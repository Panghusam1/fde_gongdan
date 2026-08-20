import type { PGliteInterface } from "@electric-sql/pglite";

import {
  hasDirectHighRiskIntent,
  parseInputHighRiskIntentConfig,
} from "../safety/input-high-risk-intent.ts";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type RiskDecision = "proposal_allowed" | "human_handoff_required";

export interface SemanticRiskAssessment {
  riskLevel: RiskLevel;
  reason: string;
  modelId: string;
  modelVersion: string;
  promptVersion: string;
}

export interface RunRiskAssessmentInput {
  workOrderId: number;
  requesterMembershipId: number;
  searchRunId: number;
  evidenceAssessmentId?: number;
  idempotencyKey: string;
  semanticAssessment?: SemanticRiskAssessment;
}

export interface MatchedRiskRule {
  ruleCode: string;
  ruleVersion: string;
  riskLevel: RiskLevel;
  requiredAction: "allow_proposal" | "human_handoff";
  searchHitId: number | null;
  knowledgeChunkId: number | null;
  matchedText: string;
  explanation: string;
}

export interface WorkOrderRiskAssessmentResult {
  riskAssessmentId: number;
  evidenceAssessmentId: number | null;
  humanHandoffId: number | null;
  workOrderId: number;
  searchRunId: number;
  deterministicRiskLevel: RiskLevel;
  semanticRiskLevel: RiskLevel | null;
  overallRiskLevel: RiskLevel;
  decision: RiskDecision;
  blocked: boolean;
  evidenceSufficient: boolean;
  matchedRules: MatchedRiskRule[];
}

interface WorkOrderScope {
  work_order_id: number;
  factory_id: number;
  equipment_id: number;
  status: string;
  requester_is_authorized: boolean;
}

interface SearchEvidence {
  search_hit_id: number;
  knowledge_chunk_id: number;
  verified_text: string;
  content_kind: string;
  source_severity: string;
  usage_policy: string;
}

interface SafetyRule {
  id: number;
  rule_code: string;
  rule_version: string;
  match_kind: string;
  risk_level: RiskLevel;
  required_action: "allow_proposal" | "human_handoff";
  match_config: unknown;
}

interface PersistedAssessment {
  id: number;
  work_order_id: number;
  search_run_id: number;
  evidence_assessment_id: number | null;
  deterministic_risk_level: RiskLevel;
  semantic_risk_level: RiskLevel | null;
  overall_risk_level: RiskLevel;
  decision: RiskDecision;
  blocked: boolean;
  evidence_sufficient: boolean;
  semantic_reason: string | null;
  model_id: string | null;
  model_version: string | null;
  prompt_version: string | null;
}

interface PersistedHit {
  rule_code: string;
  rule_version: string;
  risk_level: RiskLevel;
  required_action: "allow_proposal" | "human_handoff";
  search_hit_id: number | null;
  knowledge_chunk_id: number | null;
  matched_text: string;
  explanation: string;
}

const levelOrder: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maximumRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return levelOrder[left] >= levelOrder[right] ? left : right;
}

function validateSemanticAssessment(
  input: SemanticRiskAssessment | undefined,
): SemanticRiskAssessment | undefined {
  if (!input) return undefined;
  const normalized = {
    ...input,
    reason: input.reason.trim(),
    modelId: input.modelId.trim(),
    modelVersion: input.modelVersion.trim(),
    promptVersion: input.promptVersion.trim(),
  };
  if (
    normalized.reason === "" ||
    normalized.modelId === "" ||
    normalized.modelVersion === "" ||
    normalized.promptVersion === ""
  ) {
    throw new Error("semantic risk assessment metadata must not be blank");
  }
  if (!(normalized.riskLevel in levelOrder)) {
    throw new Error("semantic risk level is invalid");
  }
  return normalized;
}

async function loadScope(
  database: PGliteInterface,
  input: Pick<RunRiskAssessmentInput, "workOrderId" | "requesterMembershipId">,
): Promise<WorkOrderScope> {
  const result = await database.query<WorkOrderScope>(
    `
      select
        work_order.id as work_order_id,
        work_order.factory_id,
        work_order.equipment_id,
        work_order.status,
        (
          requester_membership.id is not null
          and requester_user.id is not null
        ) as requester_is_authorized
      from work_orders as work_order
      left join factory_memberships as requester_membership
        on requester_membership.id = $2
       and requester_membership.factory_id = work_order.factory_id
       and requester_membership.is_active = true
      left join users as requester_user
        on requester_user.id = requester_membership.user_id
       and requester_user.is_active = true
      where work_order.id = $1
    `,
    [input.workOrderId, input.requesterMembershipId],
  );
  if (result.rows.length !== 1) throw new Error("work order not found");
  if (!result.rows[0].requester_is_authorized) {
    throw new Error("active membership for the work order factory is required");
  }
  return result.rows[0];
}

async function readPersistedResult(
  database: PGliteInterface,
  assessment: PersistedAssessment,
): Promise<WorkOrderRiskAssessmentResult> {
  const handoff = await database.query<{ id: number }>(
    `select id from human_handoffs where risk_assessment_id = $1`,
    [assessment.id],
  );
  const hits = await database.query<PersistedHit>(
    `
      select
        safety_rule.rule_code,
        safety_rule.rule_version,
        safety_rule.risk_level,
        safety_rule.required_action,
        assessment_hit.search_hit_id,
        search_hit.knowledge_chunk_id,
        assessment_hit.matched_text,
        assessment_hit.explanation
      from risk_assessment_hits as assessment_hit
      join safety_rules as safety_rule
        on safety_rule.id = assessment_hit.safety_rule_id
      left join knowledge_search_hits as search_hit
        on search_hit.id = assessment_hit.search_hit_id
       and search_hit.search_run_id = assessment_hit.search_run_id
      where assessment_hit.risk_assessment_id = $1
      order by assessment_hit.id
    `,
    [assessment.id],
  );
  return {
    riskAssessmentId: assessment.id,
    evidenceAssessmentId: assessment.evidence_assessment_id,
    humanHandoffId: handoff.rows[0]?.id ?? null,
    workOrderId: assessment.work_order_id,
    searchRunId: assessment.search_run_id,
    deterministicRiskLevel: assessment.deterministic_risk_level,
    semanticRiskLevel: assessment.semantic_risk_level,
    overallRiskLevel: assessment.overall_risk_level,
    decision: assessment.decision,
    blocked: assessment.blocked,
    evidenceSufficient: assessment.evidence_sufficient,
    matchedRules: hits.rows.map((hit) => ({
      ruleCode: hit.rule_code,
      ruleVersion: hit.rule_version,
      riskLevel: hit.risk_level,
      requiredAction: hit.required_action,
      searchHitId: hit.search_hit_id,
      knowledgeChunkId: hit.knowledge_chunk_id,
      matchedText: hit.matched_text,
      explanation: hit.explanation,
    })),
  };
}

function persistedRequestMatches(
  assessment: PersistedAssessment,
  input: RunRiskAssessmentInput,
  semantic: SemanticRiskAssessment | undefined,
): boolean {
  return (
    assessment.search_run_id === input.searchRunId &&
    assessment.evidence_assessment_id === (input.evidenceAssessmentId ?? null) &&
    assessment.semantic_risk_level === (semantic?.riskLevel ?? null) &&
    assessment.semantic_reason === (semantic?.reason ?? null) &&
    assessment.model_id === (semantic?.modelId ?? null) &&
    assessment.model_version === (semantic?.modelVersion ?? null) &&
    assessment.prompt_version === (semantic?.promptVersion ?? null)
  );
}

async function insertRiskMatches(
  database: PGliteInterface,
  assessmentId: number,
  searchRunId: number,
  matches: Array<{
    rule: SafetyRule;
    searchHitId: number | null;
    matchedText: string;
    explanation: string;
  }>,
): Promise<void> {
  if (matches.length === 0) return;
  const values: unknown[] = [];
  const rows = matches.map((match, rowIndex) => {
    const offset = rowIndex * 6;
    values.push(
      assessmentId,
      searchRunId,
      match.rule.id,
      match.searchHitId,
      match.matchedText,
      match.explanation,
    );
    return `(${Array.from({ length: 6 }, (_, index) => `$${offset + index + 1}`).join(", ")})`;
  });
  await database.query(
    `
      insert into risk_assessment_hits (
        risk_assessment_id, search_run_id, safety_rule_id,
        search_hit_id, matched_text, explanation
      )
      values ${rows.join(",\n")}
    `,
    values,
  );
}

export async function runRiskAssessment(
  database: PGliteInterface,
  input: RunRiskAssessmentInput,
): Promise<WorkOrderRiskAssessmentResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey === "") {
    throw new Error("risk assessment idempotency key must not be blank");
  }
  const semantic = validateSemanticAssessment(input.semanticAssessment);

  return database.transaction(async (transaction) => {
    const scope = await loadScope(transaction, input);
    const existing = await transaction.query<PersistedAssessment>(
      `
        select *
        from risk_assessments
        where work_order_id = $1 and idempotency_key = $2
      `,
      [input.workOrderId, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (!persistedRequestMatches(existing.rows[0], input, semantic)) {
        throw new Error("idempotency key was already used for a different risk assessment");
      }
      return readPersistedResult(transaction, existing.rows[0]);
    }
    if (scope.status !== "investigating") {
      throw new Error("work order status does not allow risk assessment");
    }

    const searchRun = await transaction.query<{ id: number; query_text: string }>(
      `
        select id, query_text
        from knowledge_search_runs
        where id = $1
          and work_order_id = $2
          and factory_id = $3
          and equipment_id = $4
      `,
      [input.searchRunId, scope.work_order_id, scope.factory_id, scope.equipment_id],
    );
    if (searchRun.rows.length !== 1) {
      throw new Error("knowledge search run does not belong to this work order");
    }

    const evidenceAssessment = input.evidenceAssessmentId === undefined
      ? null
      : await transaction.query<{
          id: number;
          verdict: string;
          selected_search_hit_id: number | null;
        }>(
          `
            select id, verdict, selected_search_hit_id
            from evidence_assessments
            where id = $1
              and search_run_id = $2
              and work_order_id = $3
              and factory_id = $4
              and equipment_id = $5
          `,
          [
            input.evidenceAssessmentId,
            input.searchRunId,
            scope.work_order_id,
            scope.factory_id,
            scope.equipment_id,
          ],
        );
    if (evidenceAssessment && evidenceAssessment.rows.length !== 1) {
      throw new Error("evidence assessment does not belong to this search run");
    }
    const selectedEligibleHitId =
      evidenceAssessment?.rows[0].verdict === "directly_answerable"
        ? evidenceAssessment.rows[0].selected_search_hit_id
        : null;

    const evidence = await transaction.query<SearchEvidence>(
      `
        select
          search_hit.id as search_hit_id,
          search_hit.knowledge_chunk_id,
          knowledge_chunk.verified_text,
          knowledge_chunk.content_kind,
          knowledge_chunk.source_severity,
          knowledge_chunk.usage_policy
        from knowledge_search_hits as search_hit
        join knowledge_chunks as knowledge_chunk
          on knowledge_chunk.id = search_hit.knowledge_chunk_id
        where search_hit.search_run_id = $1
          and (
            $2::boolean = false
            or ($3::bigint is not null and search_hit.id = $3)
          )
        order by search_hit.result_rank
      `,
      [
        input.searchRunId,
        evidenceAssessment !== null,
        selectedEligibleHitId,
      ],
    );
    const rules = await transaction.query<SafetyRule>(
      `select id, rule_code, rule_version, match_kind, risk_level, required_action, match_config from safety_rules where is_active = true`,
    );
    const ruleByKind = new Map(rules.rows.map((rule) => [rule.match_kind, rule]));
    const matches: Array<{
      rule: SafetyRule;
      searchHitId: number | null;
      matchedText: string;
      explanation: string;
    }> = [];
    const addMatch = (
      kind: string,
      searchHitId: number | null,
      matchedText: string,
      explanation: string,
    ) => {
      const rule = ruleByKind.get(kind);
      if (!rule) throw new Error(`active safety rule is missing: ${kind}`);
      matches.push({ rule, searchHitId, matchedText, explanation });
    };

    const inputIntentRule = ruleByKind.get("input_high_risk_intent");
    if (!inputIntentRule) {
      throw new Error("active safety rule is missing: input_high_risk_intent");
    }
    if (
      hasDirectHighRiskIntent(
        searchRun.rows[0].query_text,
        parseInputHighRiskIntentConfig(inputIntentRule.match_config),
      )
    ) {
      addMatch(
        "input_high_risk_intent",
        null,
        searchRun.rows[0].query_text,
        "用户直接要求关闭、屏蔽或绕过安全保护，不能依赖检索排序决定是否阻断。",
      );
    }

    for (const hit of evidence.rows) {
      if (["caution", "warning", "danger"].includes(hit.source_severity)) {
        addMatch(
          "source_high_severity",
          hit.search_hit_id,
          hit.verified_text,
          `来源危险等级为${hit.source_severity}，程序不得生成低风险现场方案。`,
        );
      }
      if (hit.usage_policy === "engineer_only") {
        addMatch(
          "engineer_only_knowledge",
          hit.search_hit_id,
          hit.verified_text,
          "该证据只允许具备资格的工程师使用。",
        );
      }
      if (["safety_warning", "restricted_setting"].includes(hit.content_kind)) {
        addMatch(
          "restricted_knowledge",
          hit.search_hit_id,
          hit.verified_text,
          `内容种类为${hit.content_kind}，必须转人工。`,
        );
      }
    }

    const hasBlockingEvidence = matches.some(
      ({ rule }) => rule.required_action === "human_handoff",
    );
    const lowRiskEvidence = evidence.rows.find(
      (hit) =>
        hit.usage_policy === "low_risk_guidance" &&
        ["information", "notice"].includes(hit.source_severity) &&
        !["safety_warning", "restricted_setting"].includes(hit.content_kind),
    );
    const evidenceSufficient = !hasBlockingEvidence && lowRiskEvidence !== undefined;
    if (!hasBlockingEvidence && lowRiskEvidence) {
      addMatch(
        "low_risk_guidance_available",
        lowRiskEvidence.search_hit_id,
        lowRiskEvidence.verified_text,
        "存在已审核且允许用于低风险指导的当前证据。",
      );
    }
    if (!hasBlockingEvidence && !lowRiskEvidence) {
      addMatch(
        "insufficient_evidence",
        evidence.rows[0]?.search_hit_id ?? null,
        evidence.rows[0]?.verified_text ?? "本次检索没有返回当前有效证据。",
        evidence.rows.length === 0
          ? "本次检索没有返回当前有效证据，不能凭模型常识生成方案。"
          : "检索结果没有任何允许用于低风险指导的证据。",
      );
    }

    let deterministicRiskLevel: RiskLevel = "low";
    for (const match of matches) {
      if (match.rule.match_kind !== "model_risk_escalation") {
        deterministicRiskLevel = maximumRisk(
          deterministicRiskLevel,
          match.rule.risk_level,
        );
      }
    }
    if (semantic && levelOrder[semantic.riskLevel] > levelOrder[deterministicRiskLevel]) {
      addMatch(
        "model_risk_escalation",
        null,
        semantic.reason,
        "模型只允许提高程序风险等级，不能降低固定规则结论。",
      );
    }
    const overallRiskLevel = semantic
      ? maximumRisk(deterministicRiskLevel, semantic.riskLevel)
      : deterministicRiskLevel;
    const blocked = !evidenceSufficient || overallRiskLevel !== "low";
    const decision: RiskDecision = blocked
      ? "human_handoff_required"
      : "proposal_allowed";

    const inserted = await transaction.query<PersistedAssessment>(
      `
        insert into risk_assessments (
          work_order_id, factory_id, equipment_id, search_run_id,
          evidence_assessment_id, requester_membership_id, deterministic_risk_level,
          semantic_risk_level, overall_risk_level, decision, blocked,
          evidence_sufficient, semantic_reason, model_id, model_version,
          prompt_version, idempotency_key
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17
        )
        returning *
      `,
      [
        scope.work_order_id,
        scope.factory_id,
        scope.equipment_id,
        input.searchRunId,
        input.evidenceAssessmentId ?? null,
        input.requesterMembershipId,
        deterministicRiskLevel,
        semantic?.riskLevel ?? null,
        overallRiskLevel,
        decision,
        blocked,
        evidenceSufficient,
        semantic?.reason ?? null,
        semantic?.modelId ?? null,
        semantic?.modelVersion ?? null,
        semantic?.promptVersion ?? null,
        idempotencyKey,
      ],
    );
    const assessment = inserted.rows[0];

    await insertRiskMatches(
      transaction,
      assessment.id,
      input.searchRunId,
      matches,
    );
    await transaction.query(
      `
        insert into work_order_events (
          work_order_id, factory_id, event_type, actor_kind,
          actor_membership_id, content, details, idempotency_key,
          risk_assessment_id
        )
        values ($1, $2, 'risk_assessed', 'agent', null, $3, $4::jsonb, $5, $6)
      `,
      [
        scope.work_order_id,
        scope.factory_id,
        decision === "proposal_allowed"
          ? "风险判断允许继续生成低风险方案。"
          : "风险判断已阻断自动方案并要求人工接管。",
        JSON.stringify({
          riskAssessmentId: assessment.id,
          searchRunId: input.searchRunId,
          deterministicRiskLevel,
          semanticRiskLevel: semantic?.riskLevel ?? null,
          overallRiskLevel,
          decision,
        }),
        `run_risk_assessment:${idempotencyKey}`,
        assessment.id,
      ],
    );

    if (blocked) {
      const reasonCode =
        levelOrder[overallRiskLevel] >= levelOrder.high
          ? "high_risk"
          : !evidenceSufficient
            ? "insufficient_evidence"
            : "other";
      const handoff = await transaction.query<{ id: number }>(
        `
          insert into human_handoffs (
            work_order_id, factory_id, risk_assessment_id,
            requester_membership_id, reason_code, reason_details,
            idempotency_key
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          returning id
        `,
        [
          scope.work_order_id,
          scope.factory_id,
          assessment.id,
          input.requesterMembershipId,
          reasonCode,
          reasonCode === "high_risk"
            ? "风险判断命中高危规则或模型提出了更高风险。"
            : reasonCode === "insufficient_evidence"
              ? "没有足够的当前有效低风险证据，不能继续自动生成方案。"
              : "风险判断要求人工进一步确认。",
          `run_risk_assessment:${idempotencyKey}:handoff`,
        ],
      );
      await transaction.query(
        `
          insert into work_order_events (
            work_order_id, factory_id, event_type, actor_kind,
            actor_membership_id, content, details, idempotency_key,
            human_handoff_id
          )
          values (
            $1, $2, 'human_handoff_requested', 'system', null,
            '风险门禁已经创建人工接管请求。', $3::jsonb, $4, $5
          )
        `,
        [
          scope.work_order_id,
          scope.factory_id,
          JSON.stringify({
            humanHandoffId: handoff.rows[0].id,
            riskAssessmentId: assessment.id,
            reasonCode,
          }),
          `run_risk_assessment:${idempotencyKey}:handoff-event`,
          handoff.rows[0].id,
        ],
      );
      const updated = await transaction.query<{ id: number }>(
        `
          update work_orders
          set status = 'awaiting_human'
          where id = $1 and status = 'investigating'
          returning id
        `,
        [scope.work_order_id],
      );
      if (updated.rows.length !== 1) {
        throw new Error("work order state changed during risk assessment");
      }
      await transaction.query(
        `
          insert into work_order_events (
            work_order_id, factory_id, event_type, actor_kind,
            actor_membership_id, content, from_status, to_status,
            details, idempotency_key
          )
          values (
            $1, $2, 'status_changed', 'system', null,
            '风险门禁要求转人工。', 'investigating', 'awaiting_human',
            $3::jsonb, $4
          )
        `,
        [
          scope.work_order_id,
          scope.factory_id,
          JSON.stringify({ riskAssessmentId: assessment.id }),
          `run_risk_assessment:${idempotencyKey}:handoff-status`,
        ],
      );
    }

    return readPersistedResult(transaction, assessment);
  });
}
