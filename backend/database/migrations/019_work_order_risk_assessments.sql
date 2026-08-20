alter table knowledge_search_runs
  add constraint knowledge_search_runs_id_scope_unique
  unique (id, work_order_id, factory_id, equipment_id);

alter table knowledge_search_hits
  add constraint knowledge_search_hits_id_run_unique
  unique (id, search_run_id);

create table safety_rules (
  id bigint generated always as identity primary key,
  rule_code text not null,
  rule_version text not null,
  name text not null,
  match_kind text not null,
  risk_level text not null,
  required_action text not null,
  match_config jsonb not null default '{}'::jsonb,
  source_kind text not null,
  source_chunk_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint safety_rules_code_not_blank check (btrim(rule_code) <> ''),
  constraint safety_rules_version_not_blank check (btrim(rule_version) <> ''),
  constraint safety_rules_name_not_blank check (btrim(name) <> ''),
  constraint safety_rules_match_kind_allowed check (
    match_kind in (
      'low_risk_guidance_available',
      'source_high_severity',
      'engineer_only_knowledge',
      'restricted_knowledge',
      'insufficient_evidence',
      'model_risk_escalation'
    )
  ),
  constraint safety_rules_risk_level_allowed check (
    risk_level in ('low', 'medium', 'high', 'critical')
  ),
  constraint safety_rules_required_action_allowed check (
    required_action in ('allow_proposal', 'human_handoff')
  ),
  constraint safety_rules_match_config_is_object check (
    jsonb_typeof(match_config) = 'object'
  ),
  constraint safety_rules_source_kind_allowed check (
    source_kind in ('manufacturer_knowledge', 'project_policy')
  ),
  constraint safety_rules_source_chunk_fk foreign key (source_chunk_id)
    references knowledge_chunks (id),
  constraint safety_rules_source_shape check (
    (source_kind = 'manufacturer_knowledge' and source_chunk_id is not null)
    or
    (source_kind = 'project_policy' and source_chunk_id is null)
  ),
  constraint safety_rules_code_version_unique unique (rule_code, rule_version)
);

create unique index safety_rules_one_active_code_idx
  on safety_rules (lower(btrim(rule_code)))
  where is_active = true;

create index safety_rules_source_chunk_idx
  on safety_rules (source_chunk_id)
  where source_chunk_id is not null;

insert into safety_rules (
  rule_code, rule_version, name, match_kind,
  risk_level, required_action, match_config, source_kind
)
values
  (
    'LOW_RISK_GUIDANCE_AVAILABLE', '1.0.0', '存在经过审核的低风险指导',
    'low_risk_guidance_available', 'low', 'allow_proposal',
    '{"allowedSeverities":["information","notice"]}'::jsonb, 'project_policy'
  ),
  (
    'SOURCE_HIGH_SEVERITY', '1.0.0', '来源包含注意、警告或危险标识',
    'source_high_severity', 'high', 'human_handoff',
    '{"blockedSeverities":["caution","warning","danger"]}'::jsonb, 'project_policy'
  ),
  (
    'ENGINEER_ONLY_KNOWLEDGE', '1.0.0', '证据仅允许工程师使用',
    'engineer_only_knowledge', 'high', 'human_handoff',
    '{"usagePolicy":"engineer_only"}'::jsonb, 'project_policy'
  ),
  (
    'RESTRICTED_KNOWLEDGE', '1.0.0', '证据属于安全警告或受限设置',
    'restricted_knowledge', 'high', 'human_handoff',
    '{"contentKinds":["safety_warning","restricted_setting"]}'::jsonb, 'project_policy'
  ),
  (
    'INSUFFICIENT_EVIDENCE', '1.0.0', '没有足够的低风险正式证据',
    'insufficient_evidence', 'medium', 'human_handoff',
    '{}'::jsonb, 'project_policy'
  ),
  (
    'MODEL_RISK_ESCALATION', '1.0.0', '协调模型发现额外可疑风险',
    'model_risk_escalation', 'high', 'human_handoff',
    '{}'::jsonb, 'project_policy'
  );

create table risk_assessments (
  id bigint generated always as identity primary key,
  work_order_id bigint not null,
  factory_id bigint not null,
  equipment_id bigint not null,
  search_run_id bigint not null,
  requester_membership_id bigint not null,
  deterministic_risk_level text not null,
  semantic_risk_level text,
  overall_risk_level text not null,
  decision text not null,
  blocked boolean not null,
  evidence_sufficient boolean not null,
  semantic_reason text,
  model_id text,
  model_version text,
  prompt_version text,
  idempotency_key text not null,
  assessed_at timestamptz not null default now(),

  constraint risk_assessments_work_order_scope_fk
    foreign key (work_order_id, factory_id, equipment_id)
    references work_orders (id, factory_id, equipment_id),
  constraint risk_assessments_search_scope_fk
    foreign key (search_run_id, work_order_id, factory_id, equipment_id)
    references knowledge_search_runs (id, work_order_id, factory_id, equipment_id),
  constraint risk_assessments_requester_factory_fk
    foreign key (requester_membership_id, factory_id)
    references factory_memberships (id, factory_id),
  constraint risk_assessments_deterministic_level_allowed check (
    deterministic_risk_level in ('low', 'medium', 'high', 'critical')
  ),
  constraint risk_assessments_semantic_level_allowed check (
    semantic_risk_level is null
    or semantic_risk_level in ('low', 'medium', 'high', 'critical')
  ),
  constraint risk_assessments_overall_level_allowed check (
    overall_risk_level in ('low', 'medium', 'high', 'critical')
  ),
  constraint risk_assessments_decision_allowed check (
    decision in ('proposal_allowed', 'human_handoff_required')
  ),
  constraint risk_assessments_decision_shape check (
    (
      decision = 'proposal_allowed'
      and blocked = false
      and evidence_sufficient = true
      and overall_risk_level = 'low'
    )
    or
    (
      decision = 'human_handoff_required'
      and blocked = true
    )
  ),
  constraint risk_assessments_semantic_metadata_shape check (
    (
      semantic_risk_level is null
      and semantic_reason is null
      and model_id is null
      and model_version is null
      and prompt_version is null
    )
    or
    (
      semantic_risk_level is not null
      and semantic_reason is not null and btrim(semantic_reason) <> ''
      and model_id is not null and btrim(model_id) <> ''
      and model_version is not null and btrim(model_version) <> ''
      and prompt_version is not null and btrim(prompt_version) <> ''
    )
  ),
  constraint risk_assessments_idempotency_not_blank check (
    btrim(idempotency_key) <> ''
  ),
  constraint risk_assessments_search_run_unique unique (search_run_id),
  constraint risk_assessments_work_order_idempotency_unique
    unique (work_order_id, idempotency_key),
  constraint risk_assessments_id_work_order_factory_unique
    unique (id, work_order_id, factory_id),
  constraint risk_assessments_id_search_run_unique
    unique (id, search_run_id)
);

create index risk_assessments_work_order_timeline_idx
  on risk_assessments (work_order_id, assessed_at desc, id desc);

create index risk_assessments_search_scope_idx
  on risk_assessments (search_run_id, work_order_id, factory_id, equipment_id);

create index risk_assessments_requester_factory_idx
  on risk_assessments (requester_membership_id, factory_id);

create table risk_assessment_hits (
  id bigint generated always as identity primary key,
  risk_assessment_id bigint not null,
  search_run_id bigint not null,
  safety_rule_id bigint not null,
  search_hit_id bigint,
  matched_text text not null,
  explanation text not null,
  created_at timestamptz not null default now(),

  constraint risk_assessment_hits_assessment_run_fk
    foreign key (risk_assessment_id, search_run_id)
    references risk_assessments (id, search_run_id),
  constraint risk_assessment_hits_rule_fk
    foreign key (safety_rule_id) references safety_rules (id),
  constraint risk_assessment_hits_search_hit_run_fk
    foreign key (search_hit_id, search_run_id)
    references knowledge_search_hits (id, search_run_id),
  constraint risk_assessment_hits_text_not_blank check (btrim(matched_text) <> ''),
  constraint risk_assessment_hits_explanation_not_blank check (btrim(explanation) <> '')
);

create unique index risk_assessment_hits_unique_match_idx
  on risk_assessment_hits (
    risk_assessment_id,
    safety_rule_id,
    coalesce(search_hit_id, 0::bigint)
  );

create index risk_assessment_hits_rule_idx
  on risk_assessment_hits (safety_rule_id);

create index risk_assessment_hits_search_hit_run_idx
  on risk_assessment_hits (search_hit_id, search_run_id)
  where search_hit_id is not null;

alter table work_order_events
  add column risk_assessment_id bigint,
  add constraint work_order_events_risk_assessment_fk
    foreign key (risk_assessment_id, work_order_id, factory_id)
    references risk_assessments (id, work_order_id, factory_id),
  add constraint work_order_events_risk_assessment_shape check (
    (
      event_type = 'risk_assessed'
      and risk_assessment_id is not null
      and actor_kind = 'agent'
    )
    or
    (
      event_type <> 'risk_assessed'
      and risk_assessment_id is null
    )
  );

create unique index work_order_events_risk_assessment_unique
  on work_order_events (risk_assessment_id)
  where risk_assessment_id is not null;

create function reject_risk_assessment_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'risk assessment audit records are append-only'
    using errcode = '55000';
end;
$$;

create trigger risk_assessments_reject_mutation
before update or delete on risk_assessments
for each row
execute function reject_risk_assessment_audit_mutation();

create trigger risk_assessment_hits_reject_mutation
before update or delete on risk_assessment_hits
for each row
execute function reject_risk_assessment_audit_mutation();
