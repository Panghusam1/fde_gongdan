alter table factory_memberships
  add constraint factory_memberships_id_factory_unique
  unique (id, factory_id);

alter table work_orders
  add column created_by_membership_id bigint not null,
  add column resolved_at timestamptz,
  add column closed_at timestamptz;

alter table work_orders
  alter column status set default 'draft';

alter table work_orders
  add constraint work_orders_status_allowed
  check (
    status in (
      'draft',
      'investigating',
      'awaiting_information',
      'awaiting_user_confirmation',
      'awaiting_human',
      'human_processing',
      'resolved',
      'closed',
      'cancelled'
    )
  );

alter table work_orders
  add constraint work_orders_resolution_timestamps_match_status
  check (
    (
      status in ('resolved', 'closed')
      and resolved_at is not null
    )
    or
    (
      status not in ('resolved', 'closed')
      and resolved_at is null
    )
  );

alter table work_orders
  add constraint work_orders_closed_timestamp_matches_status
  check (
    (status = 'closed' and closed_at is not null)
    or
    (status <> 'closed' and closed_at is null)
  );

alter table work_orders
  add constraint work_orders_id_factory_unique
  unique (id, factory_id);

alter table work_orders
  add constraint work_orders_creator_membership_factory_fk
  foreign key (created_by_membership_id, factory_id)
  references factory_memberships (id, factory_id);

create index work_orders_creator_membership_factory_idx
  on work_orders (created_by_membership_id, factory_id);

drop index work_orders_factory_id_idx;

create index work_orders_factory_status_created_idx
  on work_orders (factory_id, status, created_at desc);

create table work_order_events (
  id bigint generated always as identity primary key,
  work_order_id bigint not null,
  factory_id bigint not null,
  event_type text not null,
  actor_kind text not null,
  actor_membership_id bigint,
  content text not null,
  from_status text,
  to_status text,
  details jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),

  constraint work_order_events_work_order_factory_fk
    foreign key (work_order_id, factory_id)
    references work_orders (id, factory_id),
  constraint work_order_events_actor_membership_factory_fk
    foreign key (actor_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint work_order_events_type_allowed
    check (
      event_type in (
        'work_order_created',
        'observation_added',
        'status_changed',
        'user_feedback_recorded',
        'proposal_created',
        'risk_assessed',
        'human_handoff_requested',
        'human_handoff_accepted',
        'resolution_confirmed',
        'work_order_closed',
        'work_order_cancelled'
      )
    ),
  constraint work_order_events_actor_kind_allowed
    check (actor_kind in ('user', 'agent', 'system')),
  constraint work_order_events_actor_membership_consistent
    check (
      (actor_kind = 'user' and actor_membership_id is not null)
      or
      (actor_kind in ('agent', 'system') and actor_membership_id is null)
    ),
  constraint work_order_events_content_not_blank
    check (btrim(content) <> ''),
  constraint work_order_events_idempotency_key_not_blank
    check (btrim(idempotency_key) <> ''),
  constraint work_order_events_details_is_object
    check (jsonb_typeof(details) = 'object'),
  constraint work_order_events_from_status_allowed
    check (
      from_status is null
      or from_status in (
        'draft',
        'investigating',
        'awaiting_information',
        'awaiting_user_confirmation',
        'awaiting_human',
        'human_processing',
        'resolved',
        'closed',
        'cancelled'
      )
    ),
  constraint work_order_events_to_status_allowed
    check (
      to_status is null
      or to_status in (
        'draft',
        'investigating',
        'awaiting_information',
        'awaiting_user_confirmation',
        'awaiting_human',
        'human_processing',
        'resolved',
        'closed',
        'cancelled'
      )
    ),
  constraint work_order_events_status_shape
    check (
      (
        event_type = 'work_order_created'
        and from_status is null
        and to_status = 'draft'
      )
      or
      (
        event_type = 'status_changed'
        and from_status is not null
        and to_status is not null
        and from_status <> to_status
      )
      or
      (
        event_type not in ('work_order_created', 'status_changed')
        and from_status is null
        and to_status is null
      )
    ),
  constraint work_order_events_work_order_idempotency_unique
    unique (work_order_id, idempotency_key)
);

create index work_order_events_work_order_timeline_idx
  on work_order_events (work_order_id, occurred_at, id);

create index work_order_events_actor_membership_factory_idx
  on work_order_events (actor_membership_id, factory_id);

create function reject_work_order_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'work_order_events are append-only'
    using errcode = '55000';
end;
$$;

create trigger work_order_events_reject_mutation
before update or delete on work_order_events
for each row
execute function reject_work_order_event_mutation();
