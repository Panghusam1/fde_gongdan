alter table source_versions
  rename column publication_date to publisher_page_date;

alter table source_versions
  add column document_issue_label text;

alter table source_versions
  add constraint source_versions_document_issue_label_not_blank
  check (
    document_issue_label is null
    or btrim(document_issue_label) <> ''
  );
