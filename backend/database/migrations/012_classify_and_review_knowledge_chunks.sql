alter table knowledge_chunks
  rename column risk_label to legacy_risk_label;

alter table knowledge_chunks
  add column content_kind text not null default 'unclassified',
  add column source_severity text not null default 'unclassified',
  add column usage_policy text not null default 'reference_only',
  add column review_status text not null default 'unreviewed',
  add column verified_text text,
  add column reviewed_by_user_id bigint,
  add column reviewed_at timestamptz,
  add column review_notes text;

alter table knowledge_chunks
  add constraint knowledge_chunks_content_kind_allowed
  check (
    content_kind in (
      'unclassified',
      'fault_definition',
      'threshold',
      'reset_condition',
      'procedure',
      'diagnostic_context',
      'safety_warning',
      'restricted_setting'
    )
  );

alter table knowledge_chunks
  add constraint knowledge_chunks_source_severity_allowed
  check (
    source_severity in (
      'unclassified',
      'information',
      'notice',
      'caution',
      'warning',
      'danger'
    )
  );

alter table knowledge_chunks
  add constraint knowledge_chunks_usage_policy_allowed
  check (
    usage_policy in (
      'reference_only',
      'low_risk_guidance',
      'engineer_only'
    )
  );

alter table knowledge_chunks
  add constraint knowledge_chunks_high_severity_not_low_risk
  check (
    not (
      source_severity in ('caution', 'warning', 'danger')
      and usage_policy = 'low_risk_guidance'
    )
  );

alter table knowledge_chunks
  add constraint knowledge_chunks_review_status_allowed
  check (review_status in ('unreviewed', 'approved', 'rejected'));

alter table knowledge_chunks
  add constraint knowledge_chunks_verified_text_not_blank
  check (verified_text is null or btrim(verified_text) <> ''),
  add constraint knowledge_chunks_review_notes_not_blank
  check (review_notes is null or btrim(review_notes) <> ''),
  add constraint knowledge_chunks_reviewer_fk
  foreign key (reviewed_by_user_id) references users (id),
  add constraint knowledge_chunks_review_evidence_complete
  check (
    (
      review_status = 'unreviewed'
      and verified_text is null
      and reviewed_by_user_id is null
      and reviewed_at is null
      and review_notes is null
    )
    or
    (
      review_status = 'approved'
      and content_kind <> 'unclassified'
      and source_severity <> 'unclassified'
      and verified_text is not null
      and reviewed_by_user_id is not null
      and reviewed_at is not null
      and review_notes is not null
    )
    or
    (
      review_status = 'rejected'
      and verified_text is null
      and reviewed_by_user_id is not null
      and reviewed_at is not null
      and review_notes is not null
    )
  );

create index knowledge_chunks_reviewed_by_user_id_idx
  on knowledge_chunks (reviewed_by_user_id);
