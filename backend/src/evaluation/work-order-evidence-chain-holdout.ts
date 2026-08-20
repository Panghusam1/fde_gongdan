import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type WorkOrderEvidenceBranch =
  | "direct_low_risk"
  | "not_answerable"
  | "partially_related"
  | "explicit_high_risk";

export interface WorkOrderEvidenceFinalState {
  work_order_status: "investigating" | "awaiting_human";
  evidence_assessments: number;
  risk_assessments: number;
  human_handoffs: number;
  resolution_proposals: number;
}

export interface WorkOrderEvidenceChainHoldoutCase {
  case_id: string;
  branch: WorkOrderEvidenceBranch;
  query: string;
  expected_evidence_verdict:
    | "directly_answerable"
    | "partially_related"
    | "not_answerable"
    | null;
  expected_risk_decision: "proposal_allowed" | "human_handoff_required";
  expected_judge_calls: number;
  expected_final_state: WorkOrderEvidenceFinalState;
}

export interface WorkOrderEvidenceControlledCandidate {
  candidate_key: string;
  page_number: number;
  section_title: string;
  text: string;
  content_kind: "procedure" | "safety_warning";
  source_severity: "information" | "danger";
  usage_policy: "low_risk_guidance" | "engineer_only";
}

export interface WorkOrderEvidenceChainHoldout {
  schema_version: 1;
  dataset_id: string;
  purpose: string;
  dataset_role: string;
  knowledge_fixture_role: string;
  frozen_before_first_model_run: boolean;
  changes_knowledge_approval_status: boolean;
  strategy: {
    strategy_id: string;
    candidate_limit: number;
    retrieval_fixture: string;
    requested_model_id: string;
    provider_declared_equivalent_snapshot_id: string;
    model_identity_assurance: string;
    judge_prompt_version: string;
    official_model_reference: string;
    locked_before_first_run: boolean;
  };
  acceptance_targets: {
    case_pass_rate_minimum: number;
    judge_error_count_maximum: number;
  };
  controlled_candidates: WorkOrderEvidenceControlledCandidate[];
  cases: WorkOrderEvidenceChainHoldoutCase[];
  interpretation_limits: string[];
}

export interface WorkOrderEvidenceChainFreezeInput {
  datasetRaw: string;
  judgeRaw: string;
  evidenceGateRaw: string;
  riskGateRaw: string;
  preRunRaw: string;
}

export interface WorkOrderEvidenceV2RegressionPlanInput {
  datasetRaw: string;
  firstRunRaw: string;
  v2JudgeRaw: string;
  planRaw: string;
}

export interface WorkOrderEvidenceChainActualCase {
  case_id: string;
  actual_evidence_verdict:
    | "directly_answerable"
    | "partially_related"
    | "not_answerable"
    | "judge_error"
    | null;
  actual_risk_decision: "proposal_allowed" | "human_handoff_required";
  actual_judge_calls: number;
  actual_final_state: WorkOrderEvidenceFinalState;
  judge_error: string | null;
  duration_ms: number;
}

export interface WorkOrderEvidenceChainCaseResult
  extends WorkOrderEvidenceChainActualCase {
  branch: WorkOrderEvidenceBranch;
  query: string;
  expected_evidence_verdict: WorkOrderEvidenceChainHoldoutCase["expected_evidence_verdict"];
  expected_risk_decision: WorkOrderEvidenceChainHoldoutCase["expected_risk_decision"];
  expected_judge_calls: number;
  expected_final_state: WorkOrderEvidenceFinalState;
  mismatches: string[];
  passed: boolean;
}

export interface WorkOrderEvidenceChainReport {
  report_version: 1;
  dataset_id: string;
  dataset_role: string;
  knowledge_fixture_role: string;
  model_id: string;
  provider_declared_equivalent_snapshot_id: string;
  model_identity_assurance: string;
  prompt_version: string;
  case_count: number;
  passed_case_count: number;
  case_pass_rate: number;
  judge_error_count: number;
  passed: boolean;
  cases: WorkOrderEvidenceChainCaseResult[];
  interpretation_limits: string[];
}

function nonBlank(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

export function validateWorkOrderEvidenceChainHoldout(
  raw: unknown,
): WorkOrderEvidenceChainHoldout {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("work-order evidence holdout must be an object");
  }
  const dataset = raw as WorkOrderEvidenceChainHoldout;
  if (dataset.schema_version !== 1) {
    throw new Error("work-order evidence holdout schema version must be one");
  }
  nonBlank(dataset.dataset_id, "dataset ID");
  nonBlank(dataset.purpose, "dataset purpose");
  if (
    dataset.dataset_role !== "project_authored_unseen_before_first_run" ||
    dataset.knowledge_fixture_role !==
      "synthetic_controlled_fixture_not_official_manual_content" ||
    dataset.frozen_before_first_model_run !== true ||
    dataset.changes_knowledge_approval_status !== false ||
    dataset.strategy?.locked_before_first_run !== true
  ) {
    throw new Error("work-order evidence holdout identity is invalid");
  }
  if (
    dataset.strategy.candidate_limit !== 5 ||
    dataset.strategy.requested_model_id !== "qwen3.7-plus" ||
    dataset.strategy.provider_declared_equivalent_snapshot_id !==
      "qwen3.7-plus-2026-05-26" ||
    dataset.strategy.model_identity_assurance !==
      "provider_declared_alias_equivalence" ||
    dataset.strategy.judge_prompt_version !== "answerability-v1"
  ) {
    throw new Error("work-order evidence holdout strategy is invalid");
  }
  if (
    dataset.acceptance_targets?.case_pass_rate_minimum !== 1 ||
    dataset.acceptance_targets?.judge_error_count_maximum !== 0
  ) {
    throw new Error("work-order evidence holdout acceptance targets are invalid");
  }
  if (
    !Array.isArray(dataset.controlled_candidates) ||
    dataset.controlled_candidates.length !== 2
  ) {
    throw new Error("work-order evidence holdout must freeze two candidates");
  }
  const candidateKeys = new Set<string>();
  for (const candidate of dataset.controlled_candidates) {
    const key = nonBlank(candidate.candidate_key, "candidate key");
    if (candidateKeys.has(key)) {
      throw new Error("work-order evidence holdout candidate keys must be unique");
    }
    candidateKeys.add(key);
    nonBlank(candidate.section_title, `candidate ${key} section title`);
    nonBlank(candidate.text, `candidate ${key} text`);
    if (!Number.isSafeInteger(candidate.page_number) || candidate.page_number <= 0) {
      throw new Error(`candidate ${key} page number must be positive`);
    }
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 4) {
    throw new Error("work-order evidence holdout must contain four cases");
  }
  const expectedBranches = new Set<WorkOrderEvidenceBranch>([
    "direct_low_risk",
    "not_answerable",
    "partially_related",
    "explicit_high_risk",
  ]);
  const caseIds = new Set<string>();
  for (const item of dataset.cases) {
    const caseId = nonBlank(item.case_id, "case ID");
    if (caseIds.has(caseId)) {
      throw new Error("work-order evidence holdout case IDs must be unique");
    }
    caseIds.add(caseId);
    nonBlank(item.query, `case ${caseId} query`);
    if (!expectedBranches.delete(item.branch)) {
      throw new Error(`case ${caseId} branch is invalid or duplicated`);
    }
    if (
      (item.branch === "explicit_high_risk" &&
        (item.expected_judge_calls !== 0 ||
          item.expected_evidence_verdict !== null)) ||
      (item.branch !== "explicit_high_risk" && item.expected_judge_calls !== 1)
    ) {
      throw new Error(`case ${caseId} judge expectation is invalid`);
    }
    const finalState = item.expected_final_state;
    if (
      typeof finalState !== "object" ||
      finalState === null ||
      ![
        finalState.evidence_assessments,
        finalState.risk_assessments,
        finalState.human_handoffs,
        finalState.resolution_proposals,
      ].every((count) => Number.isSafeInteger(count) && count >= 0)
    ) {
      throw new Error(`case ${caseId} final state is invalid`);
    }
  }
  if (expectedBranches.size !== 0) {
    throw new Error("work-order evidence holdout is missing a required branch");
  }
  return dataset;
}

export async function loadWorkOrderEvidenceChainHoldout(
  path = "data/evaluation/work-order-evidence-chain-holdout-v1.json",
): Promise<WorkOrderEvidenceChainHoldout> {
  return validateWorkOrderEvidenceChainHoldout(
    JSON.parse(await readFile(path, "utf8")),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateWorkOrderEvidenceChainFreeze(
  input: WorkOrderEvidenceChainFreezeInput,
): void {
  const record = JSON.parse(input.preRunRaw) as {
    record_version?: unknown;
    status?: unknown;
    frozen_inputs?: Array<{ path?: unknown; sha256?: unknown }>;
  };
  if (
    record.record_version !== 1 ||
    record.status !== "frozen_before_first_model_run" ||
    !Array.isArray(record.frozen_inputs)
  ) {
    throw new Error("work-order evidence pre-run freeze record is invalid");
  }
  const actualByPath = new Map<string, string>([
    [
      "data/evaluation/work-order-evidence-chain-holdout-v1.json",
      input.datasetRaw,
    ],
    ["src/evaluation/qwen-answerability-judge.ts", input.judgeRaw],
    ["src/agent-tools/assess-work-order-evidence.ts", input.evidenceGateRaw],
    ["src/agent-tools/assess-evidence-and-run-risk.ts", input.riskGateRaw],
  ]);
  if (record.frozen_inputs.length !== actualByPath.size) {
    throw new Error("work-order evidence pre-run freeze record is incomplete");
  }
  for (const item of record.frozen_inputs) {
    const path = nonBlank(item.path, "frozen input path");
    const expectedHash = nonBlank(item.sha256, `frozen input ${path} hash`);
    const actual = actualByPath.get(path);
    if (actual === undefined || sha256(actual) !== expectedHash) {
      throw new Error(`${path} does not match the pre-run freeze record`);
    }
    actualByPath.delete(path);
  }
  if (actualByPath.size !== 0) {
    throw new Error("work-order evidence pre-run freeze record is incomplete");
  }
}

export function scoreWorkOrderEvidenceChainHoldout(
  dataset: WorkOrderEvidenceChainHoldout,
  actualCases: WorkOrderEvidenceChainActualCase[],
  run: { model_id: string; prompt_version: string },
): WorkOrderEvidenceChainReport {
  nonBlank(run.model_id, "run model ID");
  nonBlank(run.prompt_version, "run prompt version");
  if (!Array.isArray(actualCases) || actualCases.length !== dataset.cases.length) {
    throw new Error("work-order evidence run must return every frozen case once");
  }
  const byCaseId = new Map<string, WorkOrderEvidenceChainActualCase>();
  for (const actual of actualCases) {
    const caseId = nonBlank(actual.case_id, "actual case ID");
    if (byCaseId.has(caseId)) {
      throw new Error("work-order evidence run case IDs must be unique");
    }
    byCaseId.set(caseId, actual);
  }
  const finalStateFields = [
    "work_order_status",
    "evidence_assessments",
    "risk_assessments",
    "human_handoffs",
    "resolution_proposals",
  ] as const;
  const cases = dataset.cases.map((expected): WorkOrderEvidenceChainCaseResult => {
    const actual = byCaseId.get(expected.case_id);
    if (!actual) {
      throw new Error(`work-order evidence run is missing case ${expected.case_id}`);
    }
    byCaseId.delete(expected.case_id);
    const mismatches: string[] = [];
    if (actual.actual_evidence_verdict !== expected.expected_evidence_verdict) {
      mismatches.push(
        `expected evidence_verdict=${expected.expected_evidence_verdict}, actual=${actual.actual_evidence_verdict}`,
      );
    }
    if (actual.actual_risk_decision !== expected.expected_risk_decision) {
      mismatches.push(
        `expected risk_decision=${expected.expected_risk_decision}, actual=${actual.actual_risk_decision}`,
      );
    }
    if (actual.actual_judge_calls !== expected.expected_judge_calls) {
      mismatches.push(
        `expected judge_calls=${expected.expected_judge_calls}, actual=${actual.actual_judge_calls}`,
      );
    }
    for (const field of finalStateFields) {
      const expectedValue = expected.expected_final_state[field];
      const actualValue = actual.actual_final_state[field];
      if (actualValue !== expectedValue) {
        mismatches.push(`expected ${field}=${expectedValue}, actual=${actualValue}`);
      }
    }
    if (actual.judge_error !== null) {
      mismatches.push(`judge_error=${actual.judge_error}`);
    }
    return {
      ...actual,
      branch: expected.branch,
      query: expected.query,
      expected_evidence_verdict: expected.expected_evidence_verdict,
      expected_risk_decision: expected.expected_risk_decision,
      expected_judge_calls: expected.expected_judge_calls,
      expected_final_state: expected.expected_final_state,
      mismatches,
      passed: mismatches.length === 0,
    };
  });
  if (byCaseId.size !== 0) {
    throw new Error("work-order evidence run returned an unknown case");
  }
  const passedCaseCount = cases.filter((item) => item.passed).length;
  const judgeErrorCount = cases.filter((item) => item.judge_error !== null).length;
  const casePassRate = passedCaseCount / cases.length;
  return {
    report_version: 1,
    dataset_id: dataset.dataset_id,
    dataset_role: dataset.dataset_role,
    knowledge_fixture_role: dataset.knowledge_fixture_role,
    model_id: run.model_id,
    provider_declared_equivalent_snapshot_id:
      dataset.strategy.provider_declared_equivalent_snapshot_id,
    model_identity_assurance: dataset.strategy.model_identity_assurance,
    prompt_version: run.prompt_version,
    case_count: cases.length,
    passed_case_count: passedCaseCount,
    case_pass_rate: casePassRate,
    judge_error_count: judgeErrorCount,
    passed:
      casePassRate >= dataset.acceptance_targets.case_pass_rate_minimum &&
      judgeErrorCount <= dataset.acceptance_targets.judge_error_count_maximum,
    cases,
    interpretation_limits: dataset.interpretation_limits,
  };
}

export function validateWorkOrderEvidenceV2RegressionPlan(
  input: WorkOrderEvidenceV2RegressionPlanInput,
): void {
  const plan = JSON.parse(input.planRaw) as {
    record_version?: unknown;
    status?: unknown;
    data_role?: unknown;
    v1_failure_evidence?: { sha256?: unknown };
    single_changed_variable?: {
      from_prompt_version?: unknown;
      to_prompt_version?: unknown;
      implementation_sha256?: unknown;
    };
    frozen_dataset?: { sha256?: unknown };
    acceptance_targets?: {
      case_count?: unknown;
      case_pass_rate_minimum?: unknown;
      judge_error_count_maximum?: unknown;
    };
  };
  if (
    plan.record_version !== 1 ||
    plan.status !== "locked_after_v1_failure_before_v2_full_regression" ||
    plan.data_role !== "exposed_regression_not_unseen_holdout" ||
    plan.single_changed_variable?.from_prompt_version !== "answerability-v1" ||
    plan.single_changed_variable?.to_prompt_version !== "answerability-v2" ||
    plan.acceptance_targets?.case_count !== 4 ||
    plan.acceptance_targets?.case_pass_rate_minimum !== 1 ||
    plan.acceptance_targets?.judge_error_count_maximum !== 0
  ) {
    throw new Error("work-order evidence v2 regression plan is invalid");
  }
  const firstRun = JSON.parse(input.firstRunRaw) as {
    dataset_id?: unknown;
    case_count?: unknown;
    case_pass_rate?: unknown;
    passed?: unknown;
  };
  if (
    firstRun.dataset_id !== "work-order-evidence-chain-holdout-v1" ||
    firstRun.case_count !== 4 ||
    firstRun.case_pass_rate !== 0.75 ||
    firstRun.passed !== false
  ) {
    throw new Error("work-order evidence v1 failure evidence is invalid");
  }
  const hashes = [
    [input.firstRunRaw, plan.v1_failure_evidence?.sha256],
    [input.v2JudgeRaw, plan.single_changed_variable?.implementation_sha256],
    [input.datasetRaw, plan.frozen_dataset?.sha256],
  ] as const;
  for (const [actualRaw, expected] of hashes) {
    if (typeof expected !== "string" || sha256(actualRaw) !== expected) {
      throw new Error("input does not match the v2 regression plan");
    }
  }
}
