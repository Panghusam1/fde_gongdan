create table document_pages (
  id bigint generated always as identity primary key,
  source_version_id bigint not null,
  pdf_page_number integer not null,
  printed_page_label text,
  created_at timestamptz not null default now(),

  constraint document_pages_source_version_fk
    foreign key (source_version_id) references source_versions (id),
  constraint document_pages_pdf_page_number_positive
    check (pdf_page_number > 0)
);

create unique index document_pages_version_page_key
  on document_pages (source_version_id, pdf_page_number);

create table page_extractions (
  id bigint generated always as identity primary key,
  document_page_id bigint not null,
  extraction_method text not null,
  extractor_name text not null,
  extractor_version text not null,
  extractor_config_sha256 text,
  extraction_status text not null,
  extracted_text text,
  text_sha256 text,
  extracted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint page_extractions_document_page_fk
    foreign key (document_page_id) references document_pages (id),
  constraint page_extractions_extractor_name_not_blank
    check (btrim(extractor_name) <> ''),
  constraint page_extractions_extractor_version_not_blank
    check (btrim(extractor_version) <> ''),
  constraint page_extractions_config_sha256_format
    check (
      extractor_config_sha256 is null
      or extractor_config_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint page_extractions_method_allowed
    check (
      extraction_method in (
        'embedded_text',
        'ocr',
        'manual_transcription'
      )
    ),
  constraint page_extractions_status_allowed
    check (
      extraction_status in (
        'extracted',
        'blank',
        'needs_ocr',
        'failed'
      )
    ),
  constraint page_extractions_text_hash_pair
    check (
      (extracted_text is null and text_sha256 is null)
      or (
        extracted_text is not null
        and text_sha256 ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint page_extractions_status_matches_content
    check (
      (
        extraction_status = 'extracted'
        and extracted_text is not null
        and btrim(extracted_text) <> ''
        and text_sha256 is not null
      )
      or (
        extraction_status = 'blank'
        and extracted_text is null
        and text_sha256 is null
      )
      or extraction_status = 'needs_ocr'
      or (
        extraction_status = 'failed'
        and extracted_text is null
        and text_sha256 is null
      )
  )
);

create unique index page_extractions_page_extractor_key
  on page_extractions (
    document_page_id,
    extraction_method,
    lower(btrim(extractor_name)),
    lower(btrim(extractor_version)),
    coalesce(extractor_config_sha256, '')
  );
