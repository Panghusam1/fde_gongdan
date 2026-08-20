do $$
begin
  if exists (
    select 1
    from knowledge_chunks
    where embedding is not null
       or embedding_model is not null
       or embedding_dimensions is not null
  ) then
    raise exception 'migration 016 blocked: legacy inline embeddings require explicit model provenance backfill';
  end if;
end;
$$;

alter table knowledge_chunks
  drop column embedding,
  drop column embedding_model,
  drop column embedding_dimensions;

create table knowledge_chunk_embeddings (
  id bigint generated always as identity primary key,
  knowledge_chunk_id bigint not null,
  model_id text not null,
  model_revision text not null,
  pooling_method text not null,
  is_normalized boolean not null,
  input_prefix text not null,
  input_text text not null,
  input_text_sha256 text not null,
  embedding_dimensions integer not null,
  embedding vector not null,
  created_at timestamptz not null default now(),

  constraint knowledge_chunk_embeddings_chunk_fk
    foreign key (knowledge_chunk_id) references knowledge_chunks (id),
  constraint knowledge_chunk_embeddings_model_not_blank
    check (btrim(model_id) <> ''),
  constraint knowledge_chunk_embeddings_revision_not_blank
    check (btrim(model_revision) <> ''),
  constraint knowledge_chunk_embeddings_pooling_allowed
    check (pooling_method in ('mean')),
  constraint knowledge_chunk_embeddings_passage_prefix
    check (input_prefix = 'passage: '),
  constraint knowledge_chunk_embeddings_input_not_blank
    check (btrim(input_text) <> ''),
  constraint knowledge_chunk_embeddings_input_sha256_format
    check (input_text_sha256 ~ '^[0-9a-f]{64}$'),
  constraint knowledge_chunk_embeddings_dimensions_positive
    check (embedding_dimensions > 0),
  constraint knowledge_chunk_embeddings_dimensions_match
    check (vector_dims(embedding) = embedding_dimensions),
  constraint knowledge_chunk_embeddings_model_revision_unique
    unique (knowledge_chunk_id, model_id, model_revision)
);

create index knowledge_chunk_embeddings_model_chunk_idx
  on knowledge_chunk_embeddings (model_id, model_revision, knowledge_chunk_id);

create function enforce_embedding_uses_approved_verified_text()
returns trigger
language plpgsql
as $$
declare
  persisted_review_status text;
  persisted_verified_text text;
begin
  select review_status, verified_text
  into persisted_review_status, persisted_verified_text
  from knowledge_chunks
  where id = new.knowledge_chunk_id;

  if persisted_review_status is distinct from 'approved' then
    raise exception 'embedding requires an approved knowledge chunk'
      using errcode = '23514',
            constraint = 'knowledge_chunk_embeddings_approved_chunk_required';
  end if;

  if new.input_text is distinct from persisted_verified_text then
    raise exception 'embedding input must equal the approved verified text'
      using errcode = '23514',
            constraint = 'knowledge_chunk_embeddings_verified_text_required';
  end if;

  return new;
end;
$$;

create trigger knowledge_chunk_embeddings_verified_input_trigger
before insert or update of knowledge_chunk_id, input_text
on knowledge_chunk_embeddings
for each row
execute function enforce_embedding_uses_approved_verified_text();
