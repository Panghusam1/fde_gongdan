do $$
begin
  if exists (
    select 1
    from knowledge_chunks
    where review_status = 'approved'
  ) then
    raise exception 'migration 013 blocked: approved knowledge chunks without source provenance exist';
  end if;
end;
$$;

create table knowledge_chunk_sources (
  id bigint generated always as identity primary key,
  knowledge_chunk_id bigint not null,
  source_version_id bigint not null,
  document_page_id bigint not null,
  page_extraction_id bigint not null,
  source_order integer not null,
  created_at timestamptz not null default now()
);

alter table knowledge_chunks
  add constraint knowledge_chunks_id_source_version_unique
  unique (id, source_version_id);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_chunk_version_fk
  foreign key (knowledge_chunk_id, source_version_id)
  references knowledge_chunks (id, source_version_id);

create index knowledge_chunk_sources_chunk_version_idx
  on knowledge_chunk_sources (knowledge_chunk_id, source_version_id);

alter table document_pages
  add constraint document_pages_id_source_version_unique
  unique (id, source_version_id);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_page_version_fk
  foreign key (document_page_id, source_version_id)
  references document_pages (id, source_version_id);

create index knowledge_chunk_sources_page_version_idx
  on knowledge_chunk_sources (document_page_id, source_version_id);

alter table page_extractions
  add constraint page_extractions_id_document_page_unique
  unique (id, document_page_id);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_extraction_page_fk
  foreign key (page_extraction_id, document_page_id)
  references page_extractions (id, document_page_id);

create index knowledge_chunk_sources_extraction_page_idx
  on knowledge_chunk_sources (page_extraction_id, document_page_id);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_order_positive
  check (source_order > 0);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_chunk_order_unique
  unique (knowledge_chunk_id, source_order);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_chunk_extraction_unique
  unique (knowledge_chunk_id, page_extraction_id);

create function enforce_approved_knowledge_chunk_has_source()
returns trigger
language plpgsql
as $$
begin
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

  return new;
end;
$$;

create trigger knowledge_chunks_approved_requires_source_trigger
before insert or update of review_status on knowledge_chunks
for each row
execute function enforce_approved_knowledge_chunk_has_source();

create function prevent_page_extraction_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'page extractions are immutable'
    using errcode = '55000';
end;
$$;

create trigger page_extractions_immutable_trigger
before update or delete on page_extractions
for each row
execute function prevent_page_extraction_mutation();

create function prevent_reviewed_chunk_source_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if exists (
      select 1
      from knowledge_chunks
      where id = new.knowledge_chunk_id
        and review_status in ('approved', 'rejected')
    ) then
      raise exception 'reviewed knowledge chunk sources are immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if exists (
      select 1
      from knowledge_chunks
      where id = old.knowledge_chunk_id
        and review_status in ('approved', 'rejected')
    ) then
      raise exception 'reviewed knowledge chunk sources are immutable'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if exists (
    select 1
    from knowledge_chunks
    where id in (old.knowledge_chunk_id, new.knowledge_chunk_id)
      and review_status in ('approved', 'rejected')
  ) then
    raise exception 'reviewed knowledge chunk sources are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger knowledge_chunk_sources_reviewed_immutable_trigger
before insert or update or delete on knowledge_chunk_sources
for each row
execute function prevent_reviewed_chunk_source_mutation();

create function prevent_reviewed_knowledge_chunk_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.review_status in ('approved', 'rejected') then
    raise exception 'reviewed knowledge chunks are immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create trigger knowledge_chunks_reviewed_immutable_trigger
before update or delete on knowledge_chunks
for each row
execute function prevent_reviewed_knowledge_chunk_mutation();
