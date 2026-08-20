create table human_handoffs (
  id bigint generated always as identity primary key,
  work_order_id bigint not null,
  factory_id bigint not null,
  risk_assessment_id bigint,
  requester_membership_id bigint not null,
  reason_code text not null,
  reason_details text not null,
  handoff_status text not null default 'requested',
  assigned_engineer_membership_id bigint,
  idempotency_key text not null,
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz,

  constraint human_handoffs_work_order_factory_fk
    foreign key (work_order_id, factory_id)
    references work_orders (id, factory_id),
  constraint human_handoffs_risk_assessment_scope_fk
    foreign key (risk_assessment_id, work_order_id, factory_id)
    references risk_assessments (id, work_order_id, factory_id),
  constraint human_handoffs_requester_factory_fk
    foreign key (requester_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint human_handoffs_assignee_factory_fk
    foreign key (assigned_engineer_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint human_handoffs_reason_allowed check (
    reason_code in (
      'high_risk',
      'insufficient_evidence',
      'two_proposals_failed',
      'no_new_evidence',
      'other'
    )
  ),
  constraint human_handoffs_reason_details_not_blank check (
    btrim(reason_details) <> ''
  ),
  constraint human_handoffs_status_allowed check (
    handoff_status in ('requested', 'accepted', 'completed', 'cancelled')
  ),
  constraint human_handoffs_status_timestamps_match check (
    (
      handoff_status = 'requested'
      and assigned_engineer_membership_id is null
      and accepted_at is null
      and completed_at is null
    )
    or
    (
      handoff_status = 'accepted'
      and assigned_engineer_membership_id is not null
      and accepted_at is not null
      and completed_at is null
    )
    or
    (
      handoff_status = 'completed'
      and assigned_engineer_membership_id is not null
      and accepted_at is not null
      and completed_at is not null
    )
    or
    (
      handoff_status = 'cancelled'
      and completed_at is null
    )
  ),
  constraint human_handoffs_idempotency_not_blank check (
    btrim(idempotency_key) <> ''
  ),
  constraint human_handoffs_work_order_idempotency_unique
    unique (work_order_id, idempotency_key),
  constraint human_handoffs_id_work_order_factory_unique
    unique (id, work_order_id, factory_id)
);

create unique index human_handoffs_risk_assessment_unique
  on human_handoffs (risk_assessment_id)
  where risk_assessment_id is not null;

create index human_handoffs_work_order_timeline_idx
  on human_handoffs (work_order_id, requested_at desc, id desc);

create index human_handoffs_requester_factory_idx
  on human_handoffs (requester_membership_id, factory_id);

create index human_handoffs_assignee_factory_status_idx
  on human_handoffs (assigned_engineer_membership_id, factory_id, handoff_status)
  where assigned_engineer_membership_id is not null;

alter table work_order_events
  add column human_handoff_id bigint,
  add constraint work_order_events_human_handoff_scope_fk
    foreign key (human_handoff_id, work_order_id, factory_id)
    references human_handoffs (id, work_order_id, factory_id),
  add constraint work_order_events_human_handoff_shape check (
    (
      event_type in ('human_handoff_requested', 'human_handoff_accepted')
      and human_handoff_id is not null
    )
    or
    (
      event_type not in ('human_handoff_requested', 'human_handoff_accepted')
      and human_handoff_id is null
    )
  );

create unique index work_order_events_human_handoff_type_unique
  on work_order_events (human_handoff_id, event_type)
  where human_handoff_id is not null;
