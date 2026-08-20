alter table knowledge_chunks
  add constraint knowledge_chunks_original_text_not_blank
  check (btrim(original_text) <> '');
