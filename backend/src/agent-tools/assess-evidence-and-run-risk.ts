import type { PGliteInterface } from "@electric-sql/pglite";

import type { QwenAnswerabilityJudge } from "../evaluation/qwen-answerability-judge.ts";
import {
  hasDirectHighRiskIntent,
  parseInputHighRiskIntentConfig,
} from "../safety/input-high-risk-intent.ts";
import {
  assessWorkOrderEvidence,
  type WorkOrderEvidenceAssessmentResult,
} from "./assess-work-order-evidence.ts";
import {
  runRiskAssessment,
  type WorkOrderRiskAssessmentResult,
} from "./run-risk-assessment.ts";

export interface AssessEvidenceAndRunRiskInput {
  workOrderId: number;
  requesterMembershipId: number;
  searchRunId: number;
  evidenceIdempotencyKey: string;
  riskIdempotencyKey: string;
  judge: QwenAnswerabilityJudge;
}

export interface AssessEvidenceAndRunRiskResult {
  evidenceAssessment: WorkOrderEvidenceAssessmentResult | null;
  riskAssessment: WorkOrderRiskAssessmentResult;
}

async function hasFixedHighRiskIntent(
  database: PGliteInterface,
  input: Pick<
    AssessEvidenceAndRunRiskInput,
    "workOrderId" | "searchRunId"
  >,
): Promise<boolean> {
  const result = await database.query<{
    query_text: string;
    match_config: unknown;
  }>(
    `
      select search_run.query_text, safety_rule.match_config
      from knowledge_search_runs as search_run
      join safety_rules as safety_rule
        on safety_rule.match_kind = 'input_high_risk_intent'
       and safety_rule.is_active = true
      where search_run.id = $1
        and search_run.work_order_id = $2
    `,
    [input.searchRunId, input.workOrderId],
  );
  if (result.rows.length !== 1) return false;
  return hasDirectHighRiskIntent(
    result.rows[0].query_text,
    parseInputHighRiskIntentConfig(result.rows[0].match_config),
  );
}

export async function assessEvidenceAndRunRisk(
  database: PGliteInterface,
  input: AssessEvidenceAndRunRiskInput,
): Promise<AssessEvidenceAndRunRiskResult> {
  if (await hasFixedHighRiskIntent(database, input)) {
    const riskAssessment = await runRiskAssessment(database, {
      workOrderId: input.workOrderId,
      requesterMembershipId: input.requesterMembershipId,
      searchRunId: input.searchRunId,
      idempotencyKey: input.riskIdempotencyKey,
    });
    return { evidenceAssessment: null, riskAssessment };
  }
  const evidenceAssessment = await assessWorkOrderEvidence(database, {
    workOrderId: input.workOrderId,
    requesterMembershipId: input.requesterMembershipId,
    searchRunId: input.searchRunId,
    idempotencyKey: input.evidenceIdempotencyKey,
    judge: input.judge,
  });
  const riskAssessment = await runRiskAssessment(database, {
    workOrderId: input.workOrderId,
    requesterMembershipId: input.requesterMembershipId,
    searchRunId: input.searchRunId,
    evidenceAssessmentId: evidenceAssessment.evidenceAssessmentId,
    idempotencyKey: input.riskIdempotencyKey,
  });
  return { evidenceAssessment, riskAssessment };
}
