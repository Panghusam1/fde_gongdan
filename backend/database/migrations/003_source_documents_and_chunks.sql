create extension if not exists vector;

create table source_documents (
  id bigint generated always as identity primary key,
  publisher text not null,
  title text not null,
  document_reference text not null,
  product_family text not null,
  source_type text not null,
  official_url text not null,
  created_at timestamptz not null default now(),

  constraint source_documents_publisher_not_blank
    check (btrim(publisher) <> ''),
  constraint source_documents_title_not_blank
    check (btrim(title) <> ''),
  constraint source_documents_reference_not_blank
    check (btrim(document_reference) <> ''),
  constraint source_documents_product_family_not_blank
    check (btrim(product_family) <> ''),
  constraint source_documents_official_url_not_blank
    check (btrim(official_url) <> ''),
  constraint source_documents_publisher_reference_unique
    unique (publisher, document_reference)
);

create table source_versions (
  id bigint generated always as identity primary key,
  source_document_id bigint not null,
  version_label text not null,
  language_code text not null,
  publication_date date,
  acquired_at timestamptz not null default now(),
  sha256 text not null,
  local_path text not null,
  created_at timestamptz not null default now(),

  constraint source_versions_document_fk
    foreign key (source_document_id) references source_documents (id),
  constraint source_versions_version_label_not_blank
    check (btrim(version_label) <> ''),
  constraint source_versions_language_code_not_blank
    check (btrim(language_code) <> ''),
  constraint source_versions_sha256_format
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint source_versions_local_path_not_blank
    check (btrim(local_path) <> '')
);

create index source_versions_document_id_idx
  on source_versions (source_document_id);

create table knowledge_chunks (
  id bigint generated always as identity primary key,
  source_version_id bigint not null,
  chunk_no integer not null,
  original_text text not null,
  page_number integer,
  section_title text,
  applicable_model text,
  fault_code text,
  risk_label text,
  embedding vector,
  embedding_model text,
  embedding_dimensions integer,
  created_at timestamptz not null default now(),

  constraint knowledge_chunks_source_version_fk
    foreign key (source_version_id) references source_versions (id),
  constraint knowledge_chunks_chunk_no_positive
    check (chunk_no > 0),
  constraint knowledge_chunks_page_number_positive
    check (page_number is null or page_number > 0),
  constraint knowledge_chunks_source_chunk_unique
    unique (source_version_id, chunk_no)
);

create index knowledge_chunks_source_version_id_idx
  on knowledge_chunks (source_version_id);
