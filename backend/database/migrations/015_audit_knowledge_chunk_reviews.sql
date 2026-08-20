create table product_family_knowledge_reviewers (
  id bigint generated always as identity primary key,
  product_family_id bigint not null,
  user_id bigint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint product_family_knowledge_reviewers_product_family_fk
    foreign key (product_family_id) references product_families (id),
  constraint product_family_knowledge_reviewers_user_fk
    foreign key (user_id) references users (id),
  constraint product_family_knowledge_reviewers_scope_unique
    unique (product_family_id, user_id)
);

create index product_family_knowledge_reviewers_user_scope_idx
  on product_family_knowledge_reviewers (user_id, is_active, product_family_id);

create table knowledge_chunk_review_events (
  id bigint generated always as identity primary key,
  knowledge_chunk_id bigint not null,
  reviewer_user_id bigint not null,
  decision text not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  review_notes text not null,
  reviewed_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint knowledge_chunk_review_events_chunk_fk
    foreign key (knowledge_chunk_id) references knowledge_chunks (id),
  constraint knowledge_chunk_review_events_reviewer_fk
    foreign key (reviewer_user_id) references users (id),
  constraint knowledge_chunk_review_events_one_decision_per_chunk
    unique (knowledge_chunk_id),
  constraint knowledge_chunk_review_events_decision_allowed
    check (decision in ('approved', 'rejected')),
  constraint knowledge_chunk_review_events_before_object
    check (jsonb_typeof(before_snapshot) = 'object'),
  constraint knowledge_chunk_review_events_after_object
    check (jsonb_typeof(after_snapshot) = 'object'),
  constraint knowledge_chunk_review_events_notes_not_blank
    check (btrim(review_notes) <> '')
);

create index knowledge_chunk_review_events_reviewer_time_idx
  on knowledge_chunk_review_events (reviewer_user_id, reviewed_at desc);

create function record_knowledge_chunk_review_event()
returns trigger
language plpgsql
as $$
begin
  insert into knowledge_chunk_review_events (
    knowledge_chunk_id,
    reviewer_user_id,
    decision,
    before_snapshot,
    after_snapshot,
    review_notes,
    reviewed_at
  )
  values (
    new.id,
    new.reviewed_by_user_id,
    new.review_status,
    jsonb_build_object(
      'originalText', old.original_text,
      'verifiedText', old.verified_text,
      'contentKind', old.content_kind,
      'sourceSeverity', old.source_severity,
      'usagePolicy', old.usage_policy,
      'reviewStatus', old.review_status,
      'sectionTitle', old.section_title,
      'faultCode', old.fault_code
    ),
    jsonb_build_object(
      'originalText', new.original_text,
      'verifiedText', new.verified_text,
      'contentKind', new.content_kind,
      'sourceSeverity', new.source_severity,
      'usagePolicy', new.usage_policy,
      'reviewStatus', new.review_status,
      'sectionTitle', new.section_title,
      'faultCode', new.fault_code
    ),
    new.review_notes,
    new.reviewed_at
  );

  return new;
end;
$$;

create trigger knowledge_chunks_record_review_event_trigger
after update of review_status on knowledge_chunks
for each row
when (
  old.review_status = 'unreviewed'
  and new.review_status in ('approved', 'rejected')
)
execute function record_knowledge_chunk_review_event();

create function prevent_knowledge_chunk_review_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'knowledge chunk review events are immutable'
    using errcode = '55000';
end;
$$;

create trigger knowledge_chunk_review_events_immutable_trigger
before update or delete on knowledge_chunk_review_events
for each row
execute function prevent_knowledge_chunk_review_event_mutation();
