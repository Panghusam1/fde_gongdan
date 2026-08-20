alter table source_documents
  add column product_family_id bigint;

update source_documents as source_document
set product_family_id = product_family.id
from product_families as product_family
where lower(btrim(product_family.manufacturer_name)) =
      lower(btrim(source_document.publisher))
  and lower(btrim(product_family.family_code)) =
      lower(btrim(source_document.product_family));

alter table source_documents
  add constraint source_documents_product_family_fk
  foreign key (product_family_id) references product_families (id);

alter table source_documents
  alter column product_family_id set not null;

alter table source_documents
  rename column product_family to raw_product_family;

alter table source_documents
  alter column raw_product_family drop not null;

alter table source_documents
  drop constraint source_documents_product_family_not_blank;

alter table source_documents
  add constraint source_documents_raw_product_family_not_blank
  check (
    raw_product_family is null
    or btrim(raw_product_family) <> ''
  );

alter table source_documents
  add constraint source_documents_source_type_allowed
  check (
    source_type in (
      'official_manual',
      'official_datasheet',
      'official_service_bulletin',
      'official_safety_notice'
    )
  );

alter table source_documents
  drop constraint source_documents_publisher_reference_unique;

create unique index source_documents_publisher_reference_key
  on source_documents (
    lower(btrim(publisher)),
    lower(btrim(document_reference))
  );

create index source_documents_product_family_id_idx
  on source_documents (product_family_id);

alter table source_versions
  add column version_status text not null default 'unreviewed';

alter table source_versions
  add constraint source_versions_status_allowed
  check (
    version_status in (
      'unreviewed',
      'current',
      'superseded',
      'withdrawn'
    )
  );

create unique index source_versions_one_current_language
  on source_versions (
    source_document_id,
    lower(btrim(language_code))
  )
  where version_status = 'current';

create unique index source_versions_import_identity_key
  on source_versions (
    source_document_id,
    lower(btrim(version_label)),
    lower(btrim(language_code)),
    sha256
  );
