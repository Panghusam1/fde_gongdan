import { createHash } from "node:crypto";

import type { PGliteInterface } from "@electric-sql/pglite";

export interface PageExtractionArtifact {
  schema_version: number;
  source_sha256: string;
  extractor: {
    name: string;
    version: string;
    config_sha256?: string | null;
  };
  pages: Array<{
    pdf_page_number: number;
    printed_page_label: string | null;
    extraction_method: "embedded_text" | "ocr" | "manual_transcription";
    extraction_status: "extracted" | "blank" | "needs_ocr" | "failed";
    extracted_text: string | null;
    text_sha256: string | null;
  }>;
}

export interface ImportDocumentPagesInput {
  sourceVersionId: number;
  artifact: PageExtractionArtifact;
}

export interface ImportedDocumentPages {
  sourceVersionId: number;
  pageCount: number;
  extractionCount: number;
}

export async function importDocumentPages(
  database: PGliteInterface,
  input: ImportDocumentPagesInput,
): Promise<ImportedDocumentPages> {
  const sourceVersion = await database.query<{ sha256: string }>(
    `select sha256 from source_versions where id = $1`,
    [input.sourceVersionId],
  );
  if (sourceVersion.rows.length === 0) {
    throw new Error("source version not found");
  }
  if (sourceVersion.rows[0].sha256 !== input.artifact.source_sha256) {
    throw new Error("source version fingerprint mismatch");
  }

  if (
    input.artifact.pages.length === 0 ||
    input.artifact.pages.some(
      (page, index) => page.pdf_page_number !== index + 1,
    )
  ) {
    throw new Error("page sequence must be contiguous from 1");
  }

  for (const page of input.artifact.pages) {
    if (page.extracted_text === null) {
      continue;
    }
    const actualTextSha256 = createHash("sha256")
      .update(page.extracted_text, "utf8")
      .digest("hex");
    if (actualTextSha256 !== page.text_sha256) {
      throw new Error(
        `page ${page.pdf_page_number} text fingerprint mismatch`,
      );
    }
  }

  const pagesJson = JSON.stringify(input.artifact.pages);

  return database.transaction(async (transaction) => {
    const insertedPages = await transaction.query<{ id: number }>(
      `
        insert into document_pages (
          source_version_id,
          pdf_page_number,
          printed_page_label
        )
        select
          $1,
          incoming_page.pdf_page_number,
          incoming_page.printed_page_label
        from jsonb_to_recordset($2::jsonb) as incoming_page (
          pdf_page_number integer,
          printed_page_label text
        )
        on conflict do nothing
        returning id
      `,
      [input.sourceVersionId, pagesJson],
    );

    const insertedExtractions = await transaction.query<{ id: number }>(
      `
        insert into page_extractions (
          document_page_id,
          extraction_method,
          extractor_name,
          extractor_version,
          extractor_config_sha256,
          extraction_status,
          extracted_text,
          text_sha256
        )
        select
          document_page.id,
          incoming_page.extraction_method,
          $3,
          $4,
          $5,
          incoming_page.extraction_status,
          incoming_page.extracted_text,
          incoming_page.text_sha256
        from jsonb_to_recordset($2::jsonb) as incoming_page (
          pdf_page_number integer,
          extraction_method text,
          extraction_status text,
          extracted_text text,
          text_sha256 text
        )
        join document_pages as document_page
          on document_page.source_version_id = $1
         and document_page.pdf_page_number = incoming_page.pdf_page_number
        on conflict do nothing
        returning id
      `,
      [
        input.sourceVersionId,
        pagesJson,
        input.artifact.extractor.name,
        input.artifact.extractor.version,
        input.artifact.extractor.config_sha256 ?? null,
      ],
    );

    const persistedExtractions = await transaction.query<{
      pdf_page_number: number;
      extraction_method: string;
      extraction_status: string;
      text_sha256: string | null;
    }>(
      `
        select
          document_page.pdf_page_number,
          page_extraction.extraction_method,
          page_extraction.extraction_status,
          page_extraction.text_sha256
        from document_pages as document_page
        join page_extractions as page_extraction
          on page_extraction.document_page_id = document_page.id
        where document_page.source_version_id = $1
          and lower(btrim(page_extraction.extractor_name)) = lower(btrim($2))
          and lower(btrim(page_extraction.extractor_version)) = lower(btrim($3))
          and coalesce(page_extraction.extractor_config_sha256, '') =
              coalesce($4::text, '')
      `,
      [
        input.sourceVersionId,
        input.artifact.extractor.name,
        input.artifact.extractor.version,
        input.artifact.extractor.config_sha256 ?? null,
      ],
    );
    const incomingByPageAndMethod = new Map(
      input.artifact.pages.map((page) => [
        `${page.pdf_page_number}:${page.extraction_method}`,
        page,
      ]),
    );
    for (const persisted of persistedExtractions.rows) {
      const incoming = incomingByPageAndMethod.get(
        `${persisted.pdf_page_number}:${persisted.extraction_method}`,
      );
      if (
        incoming &&
        (incoming.extraction_status !== persisted.extraction_status ||
          incoming.text_sha256 !== persisted.text_sha256)
      ) {
        throw new Error(
          `existing extraction conflict on page ${persisted.pdf_page_number}`,
        );
      }
    }

    return {
      sourceVersionId: input.sourceVersionId,
      pageCount: insertedPages.rows.length,
      extractionCount: insertedExtractions.rows.length,
    };
  });
}
