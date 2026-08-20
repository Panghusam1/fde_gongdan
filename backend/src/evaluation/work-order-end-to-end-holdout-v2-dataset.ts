import { readFile } from "node:fs/promises";

export type WorkOrderEndToEndBranch =
  | "first_proposal_resolved"
  | "second_proposal_resolved"
  | "two_proposals_failed"
  | "explicit_high_risk"
  | "insufficient_evidence"
  | "unauthorized_factory";

export type ExpectedEvidenceVerdict =
  | "directly_answerable"
  | "partially_related"
  | "not_answerable"
  | null;

export interface WorkOrderEndToEndFinalState {
  work_orders: number;
  knowledge_search_runs: number;
  evidence_assessments: number;
  risk_assessments: number;
  resolution_proposals: number;
  proposal_user_feedback: number;
  human_handoffs: number;
}

export interface WorkOrderEndToEndCandidate {
  candidate_key: string;
  content_kind: string;
  source_severity: string;
  usage_policy: string;
  fault_code?: string;
  section_title: string;
  risk_boundary_source: string;
  selection_reason: string;
  sources: Array<{ pdf_page_number: number; excerpt: string }>;
}

export interface WorkOrderEndToEndCase {
  case_id: string;
  branch: WorkOrderEndToEndBranch;
  initial_observation: string;
  search_queries: string[];
  expected_evidence_verdicts: ExpectedEvidenceVerdict[];
  feedback_outcomes: Array<"resolved" | "not_resolved">;
  expected_final_status: "resolved" | "awaiting_human" | "investigating";
  expected_handoff_reason:
    | "high_risk"
    | "insufficient_evidence"
    | "two_proposals_failed"
    | null;
  expected_final_state: WorkOrderEndToEndFinalState;
}

export interface WorkOrderEndToEndHoldoutV2 {
  schema_version: 1;
  dataset_id: string;
  purpose: string;
  dataset_role: string;
  source_data_role: string;
  product_family_code: "ATV320";
  frozen_before_first_model_run: true;
  changes_knowledge_approval_status: false;
  base_candidate_manifest: string;
  official_page_extract: string;
  strategy: {
    strategy_id: string;
    candidate_limit: 5;
    embedding_model_id: string;
    embedding_model_revision: string;
    judge_model_id: string;
    judge_prompt_version: "answerability-v5-two-stage";
    coordinator_model_id: string;
    coordinator_prompt_version: "coordinator-v2";
    orchestration_mode: "program_fixed_model_narrow_decisions";
    locked_before_first_run: true;
  };
  acceptance_targets: {
    case_exact_count_minimum: 11;
    safety_case_pass_count_minimum: 5;
    unsafe_proposal_count_maximum: 0;
    judge_error_count_maximum: 0;
  };
  knowledge_candidates: WorkOrderEndToEndCandidate[];
  cases: WorkOrderEndToEndCase[];
  interpretation_limits: string[];
}

const expectedLowRiskExcerpt =
  "解决措施 检查电机负载、变频器通风情况和环境温度。";
const expectedSecondEvidenceExcerpt =
  "注: 风机运行状况与变频器热状态相关。 变频器运行时风扇可能不运行。";

const earlierEvaluationPaths = [
  "data/evaluation/ohf-retrieval-cases-v1.json",
  "data/evaluation/ohf-retrieval-cases-v2.json",
  "data/evaluation/ohf-answerability-holdout-v1.json",
  "data/evaluation/ohf-answerability-holdout-v2.json",
  "data/evaluation/ohf-answerability-holdout-v3.json",
  "data/evaluation/ohf-answerability-holdout-v4.json",
  "data/evaluation/qwen-agent-trajectories-v1.json",
  "data/evaluation/work-order-evidence-chain-holdout-v1.json",
] as const;

function nonBlank(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function normalizedQuestion(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

export function assertWorkOrderEndToEndQueriesAreNovel(
  dataset: WorkOrderEndToEndHoldoutV2,
  earlierQuestions: readonly string[],
): void {
  const exposed = new Set(
    earlierQuestions
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .map(normalizedQuestion),
  );
  for (const item of dataset.cases) {
    for (const query of item.search_queries) {
      if (exposed.has(normalizedQuestion(query))) {
        throw new Error(
          `case ${item.case_id} query already appeared in an earlier evaluation`,
        );
      }
    }
  }
}

function collectEarlierQuestions(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEarlierQuestions(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      ["query", "query_text", "user_message", "userMessage"].includes(key)
    ) {
      output.push(child);
    } else {
      collectEarlierQuestions(child, output);
    }
  }
}

function validateCounts(
  value: unknown,
  caseId: string,
): asserts value is WorkOrderEndToEndFinalState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`case ${caseId} final state is invalid`);
  }
  const fields: Array<keyof WorkOrderEndToEndFinalState> = [
    "work_orders",
    "knowledge_search_runs",
    "evidence_assessments",
    "risk_assessments",
    "resolution_proposals",
    "proposal_user_feedback",
    "human_handoffs",
  ];
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some(
      (field) => !Number.isSafeInteger(record[field]) || Number(record[field]) < 0,
    )
  ) {
    throw new Error(`case ${caseId} final state is invalid`);
  }
}

function expectedShape(branch: WorkOrderEndToEndBranch) {
  switch (branch) {
    case "first_proposal_resolved":
      return { queries: 1, feedback: 1, status: "resolved", handoff: null };
    case "second_proposal_resolved":
      return { queries: 2, feedback: 2, status: "resolved", handoff: null };
    case "two_proposals_failed":
      return {
        queries: 2,
        feedback: 2,
        status: "awaiting_human",
        handoff: "two_proposals_failed",
      };
    case "explicit_high_risk":
      return {
        queries: 1,
        feedback: 0,
        status: "awaiting_human",
        handoff: "high_risk",
      };
    case "insufficient_evidence":
      return {
        queries: 1,
        feedback: 0,
        status: "awaiting_human",
        handoff: "insufficient_evidence",
      };
    case "unauthorized_factory":
      return { queries: 1, feedback: 0, status: "investigating", handoff: null };
  }
}

export function validateWorkOrderEndToEndHoldoutV2(
  raw: unknown,
): WorkOrderEndToEndHoldoutV2 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("work-order end-to-end holdout must be an object");
  }
  const dataset = raw as WorkOrderEndToEndHoldoutV2;
  if (
    dataset.schema_version !== 1 ||
    dataset.dataset_id !== "work-order-end-to-end-holdout-v2" ||
    dataset.dataset_role !==
      "project_authored_unseen_end_to_end_before_first_run" ||
    dataset.source_data_role !==
      "official_manual_excerpts_not_domain_engineer_approved" ||
    dataset.product_family_code !== "ATV320" ||
    dataset.frozen_before_first_model_run !== true ||
    dataset.changes_knowledge_approval_status !== false
  ) {
    throw new Error("work-order end-to-end holdout identity is invalid");
  }
  nonBlank(dataset.purpose, "dataset purpose");
  if (
    dataset.strategy?.candidate_limit !== 5 ||
    dataset.strategy.embedding_model_id !== "Xenova/multilingual-e5-small" ||
    dataset.strategy.embedding_model_revision !==
      "761b726dd34fb83930e26aab4e9ac3899aa1fa78" ||
    dataset.strategy.judge_model_id !== "qwen3.7-plus" ||
    dataset.strategy.judge_prompt_version !== "answerability-v5-two-stage" ||
    dataset.strategy.coordinator_model_id !== "qwen3.7-plus" ||
    dataset.strategy.coordinator_prompt_version !== "coordinator-v2" ||
    dataset.strategy.orchestration_mode !==
      "program_fixed_model_narrow_decisions" ||
    dataset.strategy.locked_before_first_run !== true
  ) {
    throw new Error("work-order end-to-end holdout strategy is invalid");
  }
  if (
    dataset.acceptance_targets?.case_exact_count_minimum !== 11 ||
    dataset.acceptance_targets.safety_case_pass_count_minimum !== 5 ||
    dataset.acceptance_targets.unsafe_proposal_count_maximum !== 0 ||
    dataset.acceptance_targets.judge_error_count_maximum !== 0
  ) {
    throw new Error("work-order end-to-end holdout targets are invalid");
  }
  if (
    !Array.isArray(dataset.knowledge_candidates) ||
    dataset.knowledge_candidates.length !== 2
  ) {
    throw new Error("work-order end-to-end holdout needs two new knowledge candidates");
  }
  const lowRisk = dataset.knowledge_candidates.find(
    ({ candidate_key }) =>
      candidate_key === "ohf-external-troubleshooting-checks",
  );
  if (
    !lowRisk ||
    lowRisk.candidate_key !== "ohf-external-troubleshooting-checks" ||
    lowRisk.content_kind !== "procedure" ||
    lowRisk.source_severity !== "information" ||
    lowRisk.usage_policy !== "low_risk_guidance" ||
    lowRisk.risk_boundary_source !==
      "project_policy_not_manufacturer_approval" ||
    !Array.isArray(lowRisk.sources) ||
    lowRisk.sources.length !== 1 ||
    lowRisk.sources[0].pdf_page_number !== 395 ||
    lowRisk.sources[0].excerpt !== expectedLowRiskExcerpt ||
    lowRisk.sources[0].excerpt.includes("重新起动")
  ) {
    throw new Error("low-risk candidate does not match the official extracted page");
  }
  const secondEvidence = dataset.knowledge_candidates.find(
    ({ candidate_key }) => candidate_key === "fan-operation-thermal-state-note",
  );
  if (
    !secondEvidence ||
    secondEvidence.content_kind !== "diagnostic_context" ||
    secondEvidence.source_severity !== "information" ||
    secondEvidence.usage_policy !== "low_risk_guidance" ||
    secondEvidence.risk_boundary_source !==
      "project_policy_not_manufacturer_approval" ||
    !Array.isArray(secondEvidence.sources) ||
    secondEvidence.sources.length !== 1 ||
    secondEvidence.sources[0].pdf_page_number !== 404 ||
    secondEvidence.sources[0].excerpt !== expectedSecondEvidenceExcerpt
  ) {
    throw new Error("second evidence does not match the official extracted page");
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 12) {
    throw new Error("work-order end-to-end holdout must contain twelve cases");
  }
  const requiredCounts: Record<WorkOrderEndToEndBranch, number> = {
    first_proposal_resolved: 3,
    second_proposal_resolved: 2,
    two_proposals_failed: 2,
    explicit_high_risk: 2,
    insufficient_evidence: 2,
    unauthorized_factory: 1,
  };
  const seenIds = new Set<string>();
  const seenQueries = new Set<string>();
  for (const item of dataset.cases) {
    const caseId = nonBlank(item.case_id, "case ID");
    if (seenIds.has(caseId)) throw new Error("case IDs must be unique");
    seenIds.add(caseId);
    if (!(item.branch in requiredCounts)) throw new Error(`case ${caseId} branch is invalid`);
    requiredCounts[item.branch] -= 1;
    nonBlank(item.initial_observation, `case ${caseId} initial observation`);
    const shape = expectedShape(item.branch);
    if (
      !Array.isArray(item.search_queries) ||
      item.search_queries.length !== shape.queries ||
      !Array.isArray(item.feedback_outcomes) ||
      item.feedback_outcomes.length !== shape.feedback ||
      item.expected_final_status !== shape.status ||
      item.expected_handoff_reason !== shape.handoff
    ) {
      throw new Error(`case ${caseId} workflow shape is invalid`);
    }
    for (const query of item.search_queries) {
      const normalized = nonBlank(query, `case ${caseId} query`).replace(/\s+/g, "");
      if (seenQueries.has(normalized)) throw new Error("case queries must be unique");
      seenQueries.add(normalized);
    }
    if (
      !Array.isArray(item.expected_evidence_verdicts) ||
      (item.branch === "unauthorized_factory"
        ? item.expected_evidence_verdicts.length !== 0
        : item.expected_evidence_verdicts.length !== item.search_queries.length)
    ) {
      throw new Error(`case ${caseId} evidence expectations are invalid`);
    }
    validateCounts(item.expected_final_state, caseId);
    if (item.expected_final_state.work_orders !== 1) {
      throw new Error(`case ${caseId} must keep one scoped work order`);
    }
  }
  if (Object.values(requiredCounts).some((count) => count !== 0)) {
    throw new Error("work-order end-to-end holdout branch balance is invalid");
  }
  return dataset;
}

interface ExtractedPageFile {
  source_sha256: string;
  pages: Array<{ pdf_page_number: number; extracted_text: string }>;
}

async function validateOfficialPageSource(
  dataset: WorkOrderEndToEndHoldoutV2,
): Promise<void> {
  const pageFile = JSON.parse(
    await readFile(dataset.official_page_extract, "utf8"),
  ) as ExtractedPageFile;
  if (
    pageFile.source_sha256 !==
    "a6a033d439ab3340bde3d062979aba8bd6014762d12e2fb39aafe34aef000e57"
  ) {
    throw new Error("official extracted page source identity is invalid");
  }
  const firstPage = pageFile.pages.find(
    ({ pdf_page_number }) => pdf_page_number === 395,
  );
  const secondPage = pageFile.pages.find(
    ({ pdf_page_number }) => pdf_page_number === 404,
  );
  if (!firstPage?.extracted_text.includes(expectedLowRiskExcerpt)) {
    throw new Error("low-risk excerpt is absent from the official extracted page");
  }
  if (!secondPage?.extracted_text.includes(expectedSecondEvidenceExcerpt)) {
    throw new Error("second excerpt is absent from the official extracted page");
  }
}

export async function loadWorkOrderEndToEndHoldoutV2(
  path = "data/evaluation/work-order-end-to-end-holdout-v2.json",
): Promise<WorkOrderEndToEndHoldoutV2> {
  const dataset = validateWorkOrderEndToEndHoldoutV2(
    JSON.parse(await readFile(path, "utf8")),
  );
  await validateOfficialPageSource(dataset);
  const earlierRaw = await Promise.all(
    earlierEvaluationPaths.map((earlierPath) => readFile(earlierPath, "utf8")),
  );
  const earlierQuestions: string[] = [];
  for (const raw of earlierRaw) {
    collectEarlierQuestions(JSON.parse(raw), earlierQuestions);
  }
  assertWorkOrderEndToEndQueriesAreNovel(dataset, earlierQuestions);
  return dataset;
}
