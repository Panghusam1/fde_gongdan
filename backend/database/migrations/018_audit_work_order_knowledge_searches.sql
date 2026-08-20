alter table work_orders
  add constraint work_orders_id_factory_equipment_unique
  unique (id, factory_id, equipment_id);

alter table equipment
  add constraint equipment_id_factory_model_unique
  unique (id, factory_id, equipment_model_id);

alter table equipment_models
  add constraint equipment_models_id_family_unique
  unique (id, product_family_id);

create table knowledge_search_runs (
  id bigint generated always as identity primary key,
  work_order_id bigint not null,
  factory_id bigint not null,
  equipment_id bigint not null,
  equipment_model_id bigint not null,
  product_family_id bigint not null,
  requester_membership_id bigint not null,
  query_text text not null,
  requested_limit integer not null,
  idempotency_key text not null,
  model_id text not null,
  model_revision text not null,
  embedding_dimensions integer not null,
  pooling_method text not null,
  is_normalized boolean not null,
  analyzer_name text not null,
  analyzer_version text not null,
  fusion_strategy text not null,
  keyword_participated_in_fusion boolean not null,
  created_at timestamptz not null default now(),

  constraint knowledge_search_runs_work_order_scope_fk
    foreign key (work_order_id, factory_id, equipment_id)
    references work_orders (id, factory_id, equipment_id),
  constraint knowledge_search_runs_equipment_scope_fk
    foreign key (equipment_id, factory_id, equipment_model_id)
    references equipment (id, factory_id, equipment_model_id),
  constraint knowledge_search_runs_model_family_fk
    foreign key (equipment_model_id, product_family_id)
    references equipment_models (id, product_family_id),
  constraint knowledge_search_runs_requester_factory_fk
    foreign key (requester_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint knowledge_search_runs_query_not_blank
    check (btrim(query_text) <> ''),
  constraint knowledge_search_runs_limit_allowed
    check (requested_limit between 1 and 20),
  constraint knowledge_search_runs_idempotency_not_blank
    check (btrim(idempotency_key) <> ''),
  constraint knowledge_search_runs_model_not_blank
    check (btrim(model_id) <> ''),
  constraint knowledge_search_runs_revision_not_blank
    check (btrim(model_revision) <> ''),
  constraint knowledge_search_runs_dimensions_positive
    check (embedding_dimensions > 0),
  constraint knowledge_search_runs_pooling_allowed
    check (pooling_method in ('mean')),
  constraint knowledge_search_runs_analyzer_not_blank
    check (btrim(analyzer_name) <> ''),
  constraint knowledge_search_runs_analyzer_version_not_blank
    check (btrim(analyzer_version) <> ''),
  constraint knowledge_search_runs_fusion_strategy_not_blank
    check (btrim(fusion_strategy) <> ''),
  constraint knowledge_search_runs_work_order_idempotency_unique
    unique (work_order_id, idempotency_key)
);

create index knowledge_search_runs_work_order_timeline_idx
  on knowledge_search_runs (work_order_id, created_at desc, id desc);

create index knowledge_search_runs_equipment_scope_idx
  on knowledge_search_runs (equipment_id, factory_id, equipment_model_id);

create index knowledge_search_runs_model_family_idx
  on knowledge_search_runs (equipment_model_id, product_family_id);

create index knowledge_search_runs_requester_factory_idx
  on knowledge_search_runs (requester_membership_id, factory_id, created_at desc);

create table knowledge_search_hits (
  id bigint generated always as identity primary key,
  search_run_id bigint not null,
  knowledge_chunk_id bigint not null,
  result_rank integer not null,
  keyword_rank integer,
  keyword_score double precision,
  vector_rank integer,
  vector_similarity double precision,
  fusion_score double precision not null,
  created_at timestamptz not null default now(),

  constraint knowledge_search_hits_run_fk
    foreign key (search_run_id) references knowledge_search_runs (id),
  constraint knowledge_search_hits_chunk_fk
    foreign key (knowledge_chunk_id) references knowledge_chunks (id),
  constraint knowledge_search_hits_result_rank_positive
    check (result_rank > 0),
  constraint knowledge_search_hits_keyword_rank_positive
    check (keyword_rank is null or keyword_rank > 0),
  constraint knowledge_search_hits_vector_rank_positive
    check (vector_rank is null or vector_rank > 0),
  constraint knowledge_search_hits_keyword_pair
    check ((keyword_rank is null) = (keyword_score is null)),
  constraint knowledge_search_hits_vector_pair
    check ((vector_rank is null) = (vector_similarity is null)),
  constraint knowledge_search_hits_at_least_one_channel
    check (keyword_rank is not null or vector_rank is not null),
  constraint knowledge_search_hits_keyword_score_positive
    check (keyword_score is null or keyword_score > 0),
  constraint knowledge_search_hits_fusion_score_positive
    check (fusion_score > 0),
  constraint knowledge_search_hits_run_rank_unique
    unique (search_run_id, result_rank),
  constraint knowledge_search_hits_run_chunk_unique
    unique (search_run_id, knowledge_chunk_id)
);

create index knowledge_search_hits_chunk_idx
  on knowledge_search_hits (knowledge_chunk_id);

alter table work_order_events
  drop constraint work_order_events_type_allowed;

alter table work_order_events
  add column knowledge_search_run_id bigint,
  add constraint work_order_events_type_allowed
    check (
      event_type in (
        'work_order_created',
        'observation_added',
        'status_changed',
        'user_feedback_recorded',
        'proposal_created',
        'risk_assessed',
        'knowledge_searched',
        'human_handoff_requested',
        'human_handoff_accepted',
        'resolution_confirmed',
        'work_order_closed',
        'work_order_cancelled'
      )
    ),
  add constraint work_order_events_knowledge_search_run_fk
    foreign key (knowledge_search_run_id) references knowledge_search_runs (id),
  add constraint work_order_events_knowledge_search_shape
    check (
      (
        event_type = 'knowledge_searched'
        and knowledge_search_run_id is not null
        and actor_kind = 'agent'
      )
      or
      (
        event_type <> 'knowledge_searched'
        and knowledge_search_run_id is null
      )
    );

create unique index work_order_events_knowledge_search_run_unique
  on work_order_events (knowledge_search_run_id)
  where knowledge_search_run_id is not null;

create function reject_knowledge_search_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'knowledge search audit records are append-only'
    using errcode = '55000';
end;
$$;

create trigger knowledge_search_runs_reject_mutation
before update or delete on knowledge_search_runs
for each row
execute function reject_knowledge_search_audit_mutation();

create trigger knowledge_search_hits_reject_mutation
before update or delete on knowledge_search_hits
for each row
execute function reject_knowledge_search_audit_mutation();
