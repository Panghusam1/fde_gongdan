create table proposal_user_feedback (
  id bigint generated always as identity primary key,
  proposal_id bigint not null,
  work_order_id bigint not null,
  factory_id bigint not null,
  responder_membership_id bigint not null,
  outcome text not null,
  actual_result text not null,
  idempotency_key text not null,
  responded_at timestamptz not null default now(),

  constraint proposal_user_feedback_proposal_scope_fk
    foreign key (proposal_id, work_order_id, factory_id)
    references resolution_proposals (id, work_order_id, factory_id),
  constraint proposal_user_feedback_responder_factory_fk
    foreign key (responder_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint proposal_user_feedback_outcome_allowed
    check (outcome in ('resolved', 'not_resolved')),
  constraint proposal_user_feedback_actual_result_not_blank
    check (btrim(actual_result) <> ''),
  constraint proposal_user_feedback_idempotency_not_blank
    check (btrim(idempotency_key) <> ''),
  constraint proposal_user_feedback_proposal_unique
    unique (proposal_id),
  constraint proposal_user_feedback_work_order_idempotency_unique
    unique (work_order_id, idempotency_key),
  constraint proposal_user_feedback_id_work_order_factory_unique
    unique (id, work_order_id, factory_id)
);

create index proposal_user_feedback_work_order_timeline_idx
  on proposal_user_feedback (work_order_id, responded_at desc, id desc);

create index proposal_user_feedback_responder_factory_idx
  on proposal_user_feedback (responder_membership_id, factory_id);

alter table work_order_events
  add column proposal_user_feedback_id bigint,
  add constraint work_order_events_proposal_feedback_scope_fk
    foreign key (proposal_user_feedback_id, work_order_id, factory_id)
    references proposal_user_feedback (id, work_order_id, factory_id),
  add constraint work_order_events_proposal_feedback_shape
    check (
      (
        event_type in ('user_feedback_recorded', 'resolution_confirmed')
        and proposal_user_feedback_id is not null
        and actor_kind = 'user'
      )
      or
      (
        event_type not in ('user_feedback_recorded', 'resolution_confirmed')
        and proposal_user_feedback_id is null
      )
    );

create unique index work_order_events_proposal_feedback_type_unique
  on work_order_events (proposal_user_feedback_id, event_type)
  where proposal_user_feedback_id is not null;

create function reject_proposal_user_feedback_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'proposal user feedback records are append-only'
    using errcode = '55000';
end;
$$;

create trigger proposal_user_feedback_reject_mutation
before update or delete on proposal_user_feedback
for each row
execute function reject_proposal_user_feedback_mutation();
