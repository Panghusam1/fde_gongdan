create table knowledge_chunk_search_terms (
  id bigint generated always as identity primary key,
  knowledge_chunk_id bigint not null,
  analyzer_name text not null,
  analyzer_version text not null,
  term_kind text not null,
  term text not null,
  created_at timestamptz not null default now(),

  constraint knowledge_chunk_search_terms_chunk_fk
    foreign key (knowledge_chunk_id) references knowledge_chunks (id),
  constraint knowledge_chunk_search_terms_analyzer_not_blank
    check (btrim(analyzer_name) <> ''),
  constraint knowledge_chunk_search_terms_version_not_blank
    check (btrim(analyzer_version) <> ''),
  constraint knowledge_chunk_search_terms_kind_allowed
    check (term_kind in ('fault_code', 'ascii_token', 'cjk_bigram')),
  constraint knowledge_chunk_search_terms_term_normalized
    check (term = lower(btrim(term)) and btrim(term) <> ''),
  constraint knowledge_chunk_search_terms_unique
    unique (
      knowledge_chunk_id,
      analyzer_name,
      analyzer_version,
      term_kind,
      term
    )
);

create index knowledge_chunk_search_terms_lookup_idx
  on knowledge_chunk_search_terms (
    analyzer_name,
    analyzer_version,
    term,
    knowledge_chunk_id
  );

create function enforce_search_term_uses_approved_chunk()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from knowledge_chunks
    where id = new.knowledge_chunk_id
      and review_status = 'approved'
  ) then
    raise exception 'search term requires an approved knowledge chunk'
      using errcode = '23514',
            constraint = 'knowledge_chunk_search_terms_approved_chunk_required';
  end if;

  return new;
end;
$$;

create trigger knowledge_chunk_search_terms_approved_chunk_trigger
before insert or update of knowledge_chunk_id
on knowledge_chunk_search_terms
for each row
execute function enforce_search_term_uses_approved_chunk();
