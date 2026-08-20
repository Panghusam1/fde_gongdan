alter table work_order_events
  add constraint work_order_events_id_scope_unique
  unique (id, work_order_id, factory_id);

create table resolution_proposals (
  id bigint generated always as identity primary key,
  work_order_id bigint not null,
  factory_id bigint not null,
  equipment_id bigint not null,
  risk_assessment_id bigint not null,
  search_run_id bigint not null,
  requester_membership_id bigint not null,
  proposal_version smallint not null,
  previous_proposal_id bigint,
  basis_observation_event_id bigint,
  summary text not null,
  confirmed_facts jsonb not null,
  assumptions jsonb not null,
  steps jsonb not null,
  stop_conditions jsonb not null,
  expected_observations jsonb not null,
  content_sha256 text not null,
  model_id text not null,
  model_version text not null,
  prompt_version text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),

  constraint resolution_proposals_work_order_scope_fk
    foreign key (work_order_id, factory_id, equipment_id)
    references work_orders (id, factory_id, equipment_id),
  constraint resolution_proposals_risk_assessment_search_fk
    foreign key (risk_assessment_id, search_run_id)
    references risk_assessments (id, search_run_id),
  constraint resolution_proposals_requester_factory_fk
    foreign key (requester_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint resolution_proposals_id_work_order_factory_unique
    unique (id, work_order_id, factory_id),
  constraint resolution_proposals_id_search_run_unique
    unique (id, search_run_id),
  constraint resolution_proposals_previous_scope_fk
    foreign key (previous_proposal_id, work_order_id, factory_id)
    references resolution_proposals (id, work_order_id, factory_id),
  constraint resolution_proposals_basis_event_scope_fk
    foreign key (basis_observation_event_id, work_order_id, factory_id)
    references work_order_events (id, work_order_id, factory_id),
  constraint resolution_proposals_version_allowed
    check (proposal_version between 1 and 2),
  constraint resolution_proposals_version_shape
    check (
      (
        proposal_version = 1
        and previous_proposal_id is null
        and basis_observation_event_id is null
      )
      or
      (
        proposal_version = 2
        and previous_proposal_id is not null
        and basis_observation_event_id is not null
      )
    ),
  constraint resolution_proposals_summary_not_blank
    check (btrim(summary) <> ''),
  constraint resolution_proposals_confirmed_facts_nonempty_array
    check (
      jsonb_typeof(confirmed_facts) = 'array'
      and jsonb_array_length(confirmed_facts) > 0
    ),
  constraint resolution_proposals_assumptions_array
    check (jsonb_typeof(assumptions) = 'array'),
  constraint resolution_proposals_steps_nonempty_array
    check (
      jsonb_typeof(steps) = 'array'
      and jsonb_array_length(steps) > 0
    ),
  constraint resolution_proposals_stop_conditions_nonempty_array
    check (
      jsonb_typeof(stop_conditions) = 'array'
      and jsonb_array_length(stop_conditions) > 0
    ),
  constraint resolution_proposals_expected_observations_nonempty_array
    check (
      jsonb_typeof(expected_observations) = 'array'
      and jsonb_array_length(expected_observations) > 0
    ),
  constraint resolution_proposals_content_sha256_shape
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint resolution_proposals_model_id_not_blank
    check (btrim(model_id) <> ''),
  constraint resolution_proposals_model_version_not_blank
    check (btrim(model_version) <> ''),
  constraint resolution_proposals_prompt_version_not_blank
    check (btrim(prompt_version) <> ''),
  constraint resolution_proposals_idempotency_not_blank
    check (btrim(idempotency_key) <> ''),
  constraint resolution_proposals_work_order_version_unique
    unique (work_order_id, proposal_version),
  constraint resolution_proposals_work_order_content_unique
    unique (work_order_id, content_sha256),
  constraint resolution_proposals_work_order_idempotency_unique
    unique (work_order_id, idempotency_key),
  constraint resolution_proposals_risk_assessment_unique
    unique (risk_assessment_id),
  constraint resolution_proposals_previous_unique
    unique (previous_proposal_id)
);

create index resolution_proposals_work_order_timeline_idx
  on resolution_proposals (work_order_id, created_at desc, id desc);

create index resolution_proposals_work_order_scope_idx
  on resolution_proposals (work_order_id, factory_id, equipment_id);

create index resolution_proposals_requester_factory_idx
  on resolution_proposals (requester_membership_id, factory_id);

create index resolution_proposals_search_run_idx
  on resolution_proposals (search_run_id);

create index resolution_proposals_basis_event_idx
  on resolution_proposals (basis_observation_event_id)
  where basis_observation_event_id is not null;

create table resolution_proposal_evidence (
  id bigint generated always as identity primary key,
  proposal_id bigint not null,
  search_run_id bigint not null,
  search_hit_id bigint not null,
  created_at timestamptz not null default now(),

  constraint resolution_proposal_evidence_proposal_search_fk
    foreign key (proposal_id, search_run_id)
    references resolution_proposals (id, search_run_id),
  constraint resolution_proposal_evidence_hit_search_fk
    foreign key (search_hit_id, search_run_id)
    references knowledge_search_hits (id, search_run_id),
  constraint resolution_proposal_evidence_proposal_hit_unique
    unique (proposal_id, search_hit_id)
);

create index resolution_proposal_evidence_search_hit_idx
  on resolution_proposal_evidence (search_hit_id, search_run_id);

alter table work_order_events
  drop constraint work_order_events_type_allowed;

alter table work_order_events
  add column resolution_proposal_id bigint,
  add constraint work_order_events_type_allowed
    check (
      event_type in (
        'work_order_created',
        'observation_added',
        'status_changed',
        'user_feedback_recorded',
        'proposal_created',
        'user_confirmation_requested',
        'risk_assessed',
        'knowledge_searched',
        'human_handoff_requested',
        'human_handoff_accepted',
        'resolution_confirmed',
        'work_order_closed',
        'work_order_cancelled'
      )
    ),
  add constraint work_order_events_resolution_proposal_scope_fk
    foreign key (resolution_proposal_id, work_order_id, factory_id)
    references resolution_proposals (id, work_order_id, factory_id),
  add constraint work_order_events_resolution_proposal_shape
    check (
      (
        event_type in ('proposal_created', 'user_confirmation_requested')
        and resolution_proposal_id is not null
        and actor_kind = 'agent'
      )
      or
      (
        event_type not in ('proposal_created', 'user_confirmation_requested')
        and resolution_proposal_id is null
      )
    );

create unique index work_order_events_resolution_proposal_type_unique
  on work_order_events (resolution_proposal_id, event_type)
  where resolution_proposal_id is not null;

create function reject_resolution_proposal_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'resolution proposal records are append-only'
    using errcode = '55000';
end;
$$;

create trigger resolution_proposals_reject_mutation
before update or delete on resolution_proposals
for each row
execute function reject_resolution_proposal_mutation();

create trigger resolution_proposal_evidence_reject_mutation
before update or delete on resolution_proposal_evidence
for each row
execute function reject_resolution_proposal_mutation();
