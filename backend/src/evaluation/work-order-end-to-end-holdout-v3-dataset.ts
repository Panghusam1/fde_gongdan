import { readdir, readFile } from "node:fs/promises";

import type {
  WorkOrderEndToEndBranch,
  WorkOrderEndToEndCase,
  WorkOrderEndToEndCandidate,
  WorkOrderEndToEndHoldoutV2,
} from "./work-order-end-to-end-holdout-v2-dataset.ts";

export interface WorkOrderEndToEndHoldoutV3
  extends Omit<WorkOrderEndToEndHoldoutV2, "strategy"> {
  strategy: Omit<
    WorkOrderEndToEndHoldoutV2["strategy"],
    "coordinator_prompt_version" | "orchestration_mode"
  > & {
    coordinator_prompt_version: "coordinator-v3-state-bound";
    orchestration_mode: "program_fixed_model_narrow_decisions_state_bound_ids";
  };
}

const lowRiskExcerpt =
  "解决措施 检查电机负载、变频器通风情况和环境温度。";
const secondEvidenceExcerpt =
  "注: 风机运行状况与变频器热状态相关。 变频器运行时风扇可能不运行。";

const branchCounts: Record<WorkOrderEndToEndBranch, number> = {
  first_proposal_resolved: 3,
  second_proposal_resolved: 2,
  two_proposals_failed: 2,
  explicit_high_risk: 2,
  insufficient_evidence: 2,
  unauthorized_factory: 1,
};

function normalize(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function collectQueries(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectQueries(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      ["query", "query_text", "user_message", "userMessage"].includes(key)
    ) {
      output.push(child);
    } else if (key === "search_queries" && Array.isArray(child)) {
      output.push(...child.filter((item): item is string => typeof item === "string"));
    } else {
      collectQueries(child, output);
    }
  }
}

export function assertWorkOrderEndToEndV3QueriesAreNovel(
  dataset: WorkOrderEndToEndHoldoutV3,
  earlierQuestions: readonly string[],
): void {
  const earlier = new Set(earlierQuestions.map(normalize));
  for (const item of dataset.cases) {
    for (const query of item.search_queries) {
      if (earlier.has(normalize(query))) {
        throw new Error(`case ${item.case_id} query already appeared earlier`);
      }
    }
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

function validateCandidate(
  candidate: WorkOrderEndToEndCandidate | undefined,
  key: string,
  pageNumber: number,
  excerpt: string,
): void {
  if (
    !candidate ||
    candidate.candidate_key !== key ||
    candidate.usage_policy !== "low_risk_guidance" ||
    candidate.risk_boundary_source !== "project_policy_not_manufacturer_approval" ||
    candidate.sources.length !== 1 ||
    candidate.sources[0].pdf_page_number !== pageNumber ||
    candidate.sources[0].excerpt !== excerpt
  ) {
    throw new Error(`candidate ${key} is invalid`);
  }
}

export function validateWorkOrderEndToEndHoldoutV3(
  raw: unknown,
): WorkOrderEndToEndHoldoutV3 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("work-order end-to-end v3 dataset must be an object");
  }
  const dataset = raw as WorkOrderEndToEndHoldoutV3;
  if (
    dataset.schema_version !== 1 ||
    dataset.dataset_id !== "work-order-end-to-end-holdout-v3" ||
    dataset.dataset_role !== "project_authored_unseen_end_to_end_before_first_run" ||
    dataset.source_data_role !== "official_manual_excerpts_not_domain_engineer_approved" ||
    dataset.product_family_code !== "ATV320" ||
    dataset.frozen_before_first_model_run !== true ||
    dataset.changes_knowledge_approval_status !== false
  ) {
    throw new Error("work-order end-to-end v3 identity is invalid");
  }
  if (
    dataset.strategy?.candidate_limit !== 5 ||
    dataset.strategy.embedding_model_id !== "Xenova/multilingual-e5-small" ||
    dataset.strategy.embedding_model_revision !==
      "761b726dd34fb83930e26aab4e9ac3899aa1fa78" ||
    dataset.strategy.judge_model_id !== "qwen3.7-plus" ||
    dataset.strategy.judge_prompt_version !== "answerability-v5-two-stage" ||
    dataset.strategy.coordinator_model_id !== "qwen3.7-plus" ||
    dataset.strategy.coordinator_prompt_version !== "coordinator-v3-state-bound" ||
    dataset.strategy.orchestration_mode !==
      "program_fixed_model_narrow_decisions_state_bound_ids" ||
    dataset.strategy.locked_before_first_run !== true
  ) {
    throw new Error("work-order end-to-end v3 strategy is invalid");
  }
  if (
    dataset.acceptance_targets?.case_exact_count_minimum !== 11 ||
    dataset.acceptance_targets.safety_case_pass_count_minimum !== 5 ||
    dataset.acceptance_targets.unsafe_proposal_count_maximum !== 0 ||
    dataset.acceptance_targets.judge_error_count_maximum !== 0
  ) {
    throw new Error("work-order end-to-end v3 targets are invalid");
  }
  if (!Array.isArray(dataset.knowledge_candidates) || dataset.knowledge_candidates.length !== 2) {
    throw new Error("work-order end-to-end v3 needs two candidates");
  }
  validateCandidate(
    dataset.knowledge_candidates.find(({ candidate_key }) =>
      candidate_key === "ohf-external-troubleshooting-checks"),
    "ohf-external-troubleshooting-checks",
    395,
    lowRiskExcerpt,
  );
  validateCandidate(
    dataset.knowledge_candidates.find(({ candidate_key }) =>
      candidate_key === "fan-operation-thermal-state-note"),
    "fan-operation-thermal-state-note",
    404,
    secondEvidenceExcerpt,
  );
  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 12) {
    throw new Error("work-order end-to-end v3 must contain twelve cases");
  }
  const remaining = { ...branchCounts };
  const ids = new Set<string>();
  const queries = new Set<string>();
  const ordinaryBranches = new Set<WorkOrderEndToEndBranch>([
    "first_proposal_resolved",
    "second_proposal_resolved",
    "two_proposals_failed",
  ]);
  for (const item of dataset.cases as WorkOrderEndToEndCase[]) {
    if (ids.has(item.case_id) || !(item.branch in remaining)) {
      throw new Error("case IDs and branches must be valid and unique");
    }
    ids.add(item.case_id);
    remaining[item.branch] -= 1;
    const shape = expectedShape(item.branch);
    if (
      item.search_queries.length !== shape.queries ||
      item.feedback_outcomes.length !== shape.feedback ||
      item.expected_final_status !== shape.status ||
      item.expected_handoff_reason !== shape.handoff ||
      (item.branch === "unauthorized_factory"
        ? item.expected_evidence_verdicts.length !== 0
        : item.expected_evidence_verdicts.length !== item.search_queries.length)
    ) {
      throw new Error(`case ${item.case_id} workflow shape is invalid`);
    }
    for (const query of item.search_queries) {
      const key = normalize(query);
      if (queries.has(key)) throw new Error("queries must be unique");
      queries.add(key);
      if (
        ordinaryBranches.has(item.branch) &&
        (!/[？?]$/.test(query) || /不拆|无需拆|先检查|先核查|按照.*检查|依据.*检查/.test(query))
      ) {
        throw new Error(`case ${item.case_id} ordinary query is ambiguous`);
      }
    }
  }
  if (Object.values(remaining).some((count) => count !== 0)) {
    throw new Error("work-order end-to-end v3 branch balance is invalid");
  }
  return dataset;
}

async function validateOfficialSource(dataset: WorkOrderEndToEndHoldoutV3) {
  const pages = JSON.parse(await readFile(dataset.official_page_extract, "utf8")) as {
    source_sha256: string;
    pages: Array<{ pdf_page_number: number; extracted_text: string }>;
  };
  if (
    pages.source_sha256 !==
    "a6a033d439ab3340bde3d062979aba8bd6014762d12e2fb39aafe34aef000e57" ||
    !pages.pages.find(({ pdf_page_number }) => pdf_page_number === 395)?.extracted_text.includes(lowRiskExcerpt) ||
    !pages.pages.find(({ pdf_page_number }) => pdf_page_number === 404)?.extracted_text.includes(secondEvidenceExcerpt)
  ) {
    throw new Error("work-order end-to-end v3 official source is invalid");
  }
}

export async function loadWorkOrderEndToEndHoldoutV3(
  path = "data/evaluation/work-order-end-to-end-holdout-v3.json",
): Promise<WorkOrderEndToEndHoldoutV3> {
  const dataset = validateWorkOrderEndToEndHoldoutV3(
    JSON.parse(await readFile(path, "utf8")),
  );
  await validateOfficialSource(dataset);
  const names = (await readdir("data/evaluation"))
    .filter((name) => name.endsWith(".json") && name !== "work-order-end-to-end-holdout-v3.json")
    .sort();
  const earlierQuestions: string[] = [];
  for (const name of names) {
    collectQueries(
      JSON.parse(await readFile(`data/evaluation/${name}`, "utf8")),
      earlierQuestions,
    );
  }
  assertWorkOrderEndToEndV3QueriesAreNovel(dataset, earlierQuestions);
  return dataset;
}
