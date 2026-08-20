do $$
begin
  if exists (
    select 1
    from knowledge_chunk_sources
  ) then
    raise exception 'migration 014 blocked: existing chunk sources require explicit boundary backfill';
  end if;
end;
$$;

alter table knowledge_chunks
  add column chunking_method text not null default 'legacy_unversioned',
  add column chunker_name text,
  add column chunker_version text;

alter table knowledge_chunks
  add constraint knowledge_chunks_chunking_method_allowed
  check (
    chunking_method in (
      'legacy_unversioned',
      'manual_selection',
      'structure_rule',
      'ai_proposed'
    )
  ),
  add constraint knowledge_chunks_chunking_evidence_complete
  check (
    (
      chunking_method = 'legacy_unversioned'
      and chunker_name is null
      and chunker_version is null
    )
    or
    (
      chunking_method <> 'legacy_unversioned'
      and chunker_name is not null
      and btrim(chunker_name) <> ''
      and chunker_version is not null
      and btrim(chunker_version) <> ''
    )
  );

alter table knowledge_chunk_sources
  add column start_character integer,
  add column end_character integer,
  add column source_excerpt text;

alter table knowledge_chunk_sources
  alter column start_character set not null,
  alter column end_character set not null,
  alter column source_excerpt set not null;

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_start_character_positive
  check (start_character > 0),
  add constraint knowledge_chunk_sources_character_range_valid
  check (end_character > start_character),
  add constraint knowledge_chunk_sources_excerpt_not_blank
  check (btrim(source_excerpt) <> '');

alter table knowledge_chunk_sources
  drop constraint knowledge_chunk_sources_chunk_extraction_unique;

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_chunk_extraction_range_unique
  unique (
    knowledge_chunk_id,
    page_extraction_id,
    start_character,
    end_character
  );

create function enforce_chunk_source_exact_excerpt()
returns trigger
language plpgsql
as $$
declare
  persisted_status text;
  persisted_text text;
  persisted_excerpt text;
begin
  if new.start_character is null
     or new.end_character is null
     or new.end_character <= new.start_character then
    return new;
  end if;

  select extraction_status, extracted_text
  into persisted_status, persisted_text
  from page_extractions
  where id = new.page_extraction_id;

  if persisted_status <> 'extracted' or persisted_text is null then
    raise exception 'chunk source requires an extracted page with text'
      using errcode = '23514',
            constraint = 'knowledge_chunk_sources_extracted_text_required';
  end if;

  persisted_excerpt := substring(
    persisted_text
    from new.start_character
    for new.end_character - new.start_character
  );

  if persisted_excerpt is distinct from new.source_excerpt then
    raise exception 'chunk source excerpt does not match the stored page range'
      using errcode = '23514',
            constraint = 'knowledge_chunk_sources_excerpt_matches_page';
  end if;

  return new;
end;
$$;

create trigger knowledge_chunk_sources_exact_excerpt_trigger
before insert or update of
  page_extraction_id,
  start_character,
  end_character,
  source_excerpt
on knowledge_chunk_sources
for each row
execute function enforce_chunk_source_exact_excerpt();

create or replace function enforce_approved_knowledge_chunk_has_source()
returns trigger
language plpgsql
as $$
declare
  source_count integer;
  first_source_order integer;
  last_source_order integer;
  reconstructed_original_text text;
begin
  if new.review_status = 'approved'
     and (
       new.chunking_method is null
       or new.chunking_method = 'legacy_unversioned'
       or new.chunker_name is null
       or new.chunker_version is null
     ) then
    raise exception 'approved knowledge chunk requires versioned chunking evidence'
      using errcode = '23514',
            constraint = 'knowledge_chunks_approved_requires_chunking_evidence';
  end if;

  if new.review_status = 'approved'
     and not exists (
       select 1
       from knowledge_chunk_sources as chunk_source
       where chunk_source.knowledge_chunk_id = new.id
     ) then
    raise exception 'approved knowledge chunk requires source provenance'
      using errcode = '23514',
            constraint = 'knowledge_chunks_approved_requires_source';
  end if;

  if new.review_status = 'approved' then
    select
      count(*),
      min(source_order),
      max(source_order),
      string_agg(source_excerpt, E'\n' order by source_order)
    into
      source_count,
      first_source_order,
      last_source_order,
      reconstructed_original_text
    from knowledge_chunk_sources
    where knowledge_chunk_id = new.id;

    if first_source_order <> 1 or last_source_order <> source_count then
      raise exception 'approved knowledge chunk requires contiguous source order from 1'
        using errcode = '23514',
              constraint = 'knowledge_chunks_approved_source_order_contiguous';
    end if;

    if reconstructed_original_text is distinct from new.original_text then
      raise exception 'approved knowledge chunk original text must match ordered source excerpts'
        using errcode = '23514',
              constraint = 'knowledge_chunks_approved_original_matches_sources';
    end if;
  end if;

  return new;
end;
$$;
