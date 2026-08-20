alter table knowledge_search_hits
  add constraint knowledge_search_hits_id_run_chunk_unique
  unique (id, search_run_id, knowledge_chunk_id);

alter table knowledge_chunk_sources
  add constraint knowledge_chunk_sources_id_chunk_unique
  unique (id, knowledge_chunk_id);

create table evidence_assessments (
  id bigint generated always as identity primary key,
  work_order_id bigint not null,
  factory_id bigint not null,
  equipment_id bigint not null,
  search_run_id bigint not null,
  requester_membership_id bigint not null,
  verdict text not null,
  decision_source text not null,
  selected_search_hit_id bigint,
  selected_knowledge_chunk_id bigint,
  selected_chunk_source_id bigint,
  source_page_number integer,
  supporting_quote text,
  reason text not null,
  model_id text not null,
  prompt_version text not null,
  candidate_count integer not null,
  idempotency_key text not null,
  assessed_at timestamptz not null default now(),

  constraint evidence_assessments_work_order_scope_fk
    foreign key (work_order_id, factory_id, equipment_id)
    references work_orders (id, factory_id, equipment_id),
  constraint evidence_assessments_search_scope_fk
    foreign key (search_run_id, work_order_id, factory_id, equipment_id)
    references knowledge_search_runs (id, work_order_id, factory_id, equipment_id),
  constraint evidence_assessments_requester_factory_fk
    foreign key (requester_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint evidence_assessments_selected_hit_fk
    foreign key (
      selected_search_hit_id,
      search_run_id,
      selected_knowledge_chunk_id
    )
    references knowledge_search_hits (id, search_run_id, knowledge_chunk_id),
  constraint evidence_assessments_selected_source_fk
    foreign key (selected_chunk_source_id, selected_knowledge_chunk_id)
    references knowledge_chunk_sources (id, knowledge_chunk_id),
  constraint evidence_assessments_verdict_allowed check (
    verdict in (
      'directly_answerable',
      'partially_related',
      'not_answerable',
      'judge_error'
    )
  ),
  constraint evidence_assessments_decision_source_allowed check (
    decision_source in ('model', 'program_no_candidates', 'model_error')
  ),
  constraint evidence_assessments_decision_shape check (
    (
      verdict in ('directly_answerable', 'partially_related')
      and decision_source = 'model'
      and selected_search_hit_id is not null
      and selected_knowledge_chunk_id is not null
      and selected_chunk_source_id is not null
      and source_page_number is not null
      and supporting_quote is not null
      and btrim(supporting_quote) <> ''
      and candidate_count > 0
    )
    or
    (
      verdict = 'not_answerable'
      and decision_source in ('model', 'program_no_candidates')
      and selected_search_hit_id is null
      and selected_knowledge_chunk_id is null
      and selected_chunk_source_id is null
      and source_page_number is null
      and supporting_quote is null
      and (
        (decision_source = 'model' and candidate_count > 0)
        or
        (decision_source = 'program_no_candidates' and candidate_count = 0)
      )
    )
    or
    (
      verdict = 'judge_error'
      and decision_source = 'model_error'
      and selected_search_hit_id is null
      and selected_knowledge_chunk_id is null
      and selected_chunk_source_id is null
      and source_page_number is null
      and supporting_quote is null
      and candidate_count > 0
    )
  ),
  constraint evidence_assessments_page_positive check (
    source_page_number is null or source_page_number > 0
  ),
  constraint evidence_assessments_reason_not_blank check (btrim(reason) <> ''),
  constraint evidence_assessments_model_not_blank check (btrim(model_id) <> ''),
  constraint evidence_assessments_prompt_not_blank check (btrim(prompt_version) <> ''),
  constraint evidence_assessments_candidate_count_allowed check (
    candidate_count between 0 and 5
  ),
  constraint evidence_assessments_idempotency_not_blank check (
    btrim(idempotency_key) <> ''
  ),
  constraint evidence_assessments_search_run_unique unique (search_run_id),
  constraint evidence_assessments_work_order_idempotency_unique
    unique (work_order_id, idempotency_key),
  constraint evidence_assessments_id_search_run_unique
    unique (id, search_run_id),
  constraint evidence_assessments_id_work_order_factory_unique
    unique (id, work_order_id, factory_id)
);

create index evidence_assessments_work_order_timeline_idx
  on evidence_assessments (work_order_id, assessed_at desc, id desc);

create index evidence_assessments_search_scope_idx
  on evidence_assessments (search_run_id, work_order_id, factory_id, equipment_id);

create index evidence_assessments_requester_factory_idx
  on evidence_assessments (requester_membership_id, factory_id);

create index evidence_assessments_selected_hit_idx
  on evidence_assessments (
    selected_search_hit_id,
    search_run_id,
    selected_knowledge_chunk_id
  )
  where selected_search_hit_id is not null;

create index evidence_assessments_selected_source_idx
  on evidence_assessments (selected_chunk_source_id, selected_knowledge_chunk_id)
  where selected_chunk_source_id is not null;

create function enforce_evidence_assessment_quote_source()
returns trigger
language plpgsql
as $$
declare
  persisted_page integer;
  persisted_excerpt text;
begin
  if new.selected_chunk_source_id is null then
    return new;
  end if;

  select document_page.pdf_page_number, chunk_source.source_excerpt
  into persisted_page, persisted_excerpt
  from knowledge_chunk_sources as chunk_source
  join document_pages as document_page
    on document_page.id = chunk_source.document_page_id
  where chunk_source.id = new.selected_chunk_source_id;

  if persisted_page is distinct from new.source_page_number then
    raise exception 'evidence assessment page does not match the selected source'
      using errcode = '23514',
            constraint = 'evidence_assessments_page_matches_source';
  end if;

  if strpos(
    regexp_replace(persisted_excerpt, '[[:space:]]+', '', 'g'),
    regexp_replace(new.supporting_quote, '[[:space:]]+', '', 'g')
  ) = 0 then
    raise exception 'evidence assessment quote does not match the selected source'
      using errcode = '23514',
            constraint = 'evidence_assessments_quote_matches_source';
  end if;

  return new;
end;
$$;

create trigger evidence_assessments_quote_source_trigger
before insert on evidence_assessments
for each row
execute function enforce_evidence_assessment_quote_source();

create function reject_evidence_assessment_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'evidence assessment audit records are append-only'
    using errcode = '55000';
end;
$$;

create trigger evidence_assessments_reject_mutation
before update or delete on evidence_assessments
for each row
execute function reject_evidence_assessment_mutation();

alter table work_order_events
  drop constraint work_order_events_type_allowed;

alter table work_order_events
  add column evidence_assessment_id bigint,
  add constraint work_order_events_type_allowed check (
    event_type in (
      'work_order_created',
      'observation_added',
      'status_changed',
      'user_feedback_recorded',
      'proposal_created',
      'user_confirmation_requested',
      'risk_assessed',
      'knowledge_searched',
      'evidence_assessed',
      'human_handoff_requested',
      'human_handoff_accepted',
      'resolution_confirmed',
      'work_order_closed',
      'work_order_cancelled'
    )
  ),
  add constraint work_order_events_evidence_assessment_scope_fk
    foreign key (evidence_assessment_id, work_order_id, factory_id)
    references evidence_assessments (id, work_order_id, factory_id),
  add constraint work_order_events_evidence_assessment_shape check (
    (
      event_type = 'evidence_assessed'
      and evidence_assessment_id is not null
      and actor_kind = 'agent'
    )
    or
    (
      event_type <> 'evidence_assessed'
      and evidence_assessment_id is null
    )
  );

create unique index work_order_events_evidence_assessment_unique
  on work_order_events (evidence_assessment_id)
  where evidence_assessment_id is not null;

alter table risk_assessments
  add column evidence_assessment_id bigint,
  add constraint risk_assessments_evidence_assessment_run_fk
    foreign key (evidence_assessment_id, search_run_id)
    references evidence_assessments (id, search_run_id);

create index risk_assessments_evidence_assessment_run_idx
  on risk_assessments (evidence_assessment_id, search_run_id)
  where evidence_assessment_id is not null;
