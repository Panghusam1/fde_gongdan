import argparse
import hashlib
import json
import sys
from pathlib import Path

try:
    import pypdf
    from pypdf import PdfReader
except ModuleNotFoundError as error:
    if error.name != "pypdf":
        raise
    raise SystemExit(
        "缺少页级 PDF 提取依赖。请先执行："
        "python -m pip install -r requirements-pages.txt"
    ) from None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for block in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_pages(source_path: Path, expected_source_sha256: str) -> dict:
    actual_source_sha256 = sha256_file(source_path)
    if actual_source_sha256 != expected_source_sha256:
        raise ValueError(
            "source PDF fingerprint mismatch: "
            f"expected {expected_source_sha256}, got {actual_source_sha256}"
        )

    reader = PdfReader(source_path)
    pages = []
    for pdf_page_number, page in enumerate(reader.pages, start=1):
        extracted_text = page.extract_text() or ""
        if extracted_text.strip():
            extraction_status = "extracted"
            text_sha256 = sha256_text(extracted_text)
        else:
            extraction_status = "blank"
            extracted_text = None
            text_sha256 = None

        pages.append(
            {
                "pdf_page_number": pdf_page_number,
                "printed_page_label": None,
                "extraction_method": "embedded_text",
                "extraction_status": extraction_status,
                "extracted_text": extracted_text,
                "text_sha256": text_sha256,
            }
        )

    return {
        "schema_version": 1,
        "source_path": source_path.as_posix(),
        "source_sha256": actual_source_sha256,
        "extractor": {
            "name": "pypdf",
            "version": pypdf.__version__,
        },
        "pages": pages,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="逐页提取PDF文字并生成带指纹的可审查JSON文件"
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-source-sha256", required=True)
    args = parser.parse_args()

    artifact = extract_pages(args.input, args.expected_source_sha256.lower())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    blank_pages = [
        page["pdf_page_number"]
        for page in artifact["pages"]
        if page["extraction_status"] == "blank"
    ]
    print(
        json.dumps(
            {
                "output": args.output.as_posix(),
                "page_count": len(artifact["pages"]),
                "blank_pages": blank_pages,
                "extractor": artifact["extractor"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
