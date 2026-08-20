alter table safety_rules
  drop constraint safety_rules_match_kind_allowed;

alter table safety_rules
  add constraint safety_rules_match_kind_allowed check (
    match_kind in (
      'low_risk_guidance_available',
      'source_high_severity',
      'engineer_only_knowledge',
      'restricted_knowledge',
      'insufficient_evidence',
      'model_risk_escalation',
      'input_high_risk_intent'
    )
  );

insert into safety_rules (
  rule_code, rule_version, name, match_kind,
  risk_level, required_action, match_config, source_kind
)
values (
  'INPUT_HIGH_RISK_INTENT',
  '1.0.0',
  '用户直接要求关闭或绕过安全保护',
  'input_high_risk_intent',
  'high',
  'human_handoff',
  '{
    "actionTerms":["屏蔽","关掉","关闭","绕过","取消","停用","禁用"],
    "safetyTargetTerms":["过热保护","保护","错误检测","故障检测","安全联锁","联锁","监控","OHF"],
    "negatingPrefixes":["不要","不能","不得","请勿","避免","防止","被"],
    "safetyInquiryTerms":["有什么危险","有何危险","有什么风险","有何风险","什么后果","风险评估","法规条件"],
    "maximumGapCharacters":12,
    "prefixWindowCharacters":8
  }'::jsonb,
  'project_policy'
);
