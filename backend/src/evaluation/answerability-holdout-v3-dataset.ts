import { readFile } from "node:fs/promises";

import type { AnswerabilityVerdict } from "./qwen-answerability-judge.ts";

export interface AnswerabilityHoldoutV3Case {
  case_id: string;
  query: string;
  expected_verdict: AnswerabilityVerdict;
  expected_candidate_key: string | null;
  expected_pdf_pages: number[];
  label_reason: string;
  boundary_kind?: "same_surface_terms_different_business_unit";
  surface_overlap_terms?: string[];
}

export interface AnswerabilityHoldoutV3 {
  schema_version: 1;
  dataset_id: string;
  purpose: string;
  dataset_role: string;
  source_data_role: string;
  product_family_code: string;
  frozen_before_first_model_run: boolean;
  changes_knowledge_approval_status: boolean;
  strategy: {
    strategy_id: string;
    candidate_limit: number;
    embedding_model_id: string;
    embedding_model_revision: string;
    judge_model_id: string;
    provider_declared_equivalent_snapshot_id: string;
    model_identity_assurance: string;
    judge_prompt_version: string;
    locked_before_first_run: boolean;
  };
  acceptance_targets: {
    overall_exact_accuracy_minimum: number;
    per_class_accuracy_minimum: number;
    unsafe_direct_accept_count_maximum: number;
    judge_error_count_maximum: number;
  };
  cases: AnswerabilityHoldoutV3Case[];
  interpretation_limits: string[];
}

function nonBlank(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function normalizedQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function validateAnswerabilityHoldoutV3(
  raw: unknown,
  candidatePages: ReadonlyMap<string, ReadonlySet<number>>,
  earlierQueries: ReadonlySet<string>,
): AnswerabilityHoldoutV3 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("answerability holdout v3 must be an object");
  }
  const dataset = raw as AnswerabilityHoldoutV3;
  if (
    dataset.schema_version !== 1 ||
    dataset.dataset_role !== "unseen_holdout_before_first_run" ||
    dataset.source_data_role !==
      "official_manual_excerpts_not_domain_engineer_approved" ||
    dataset.frozen_before_first_model_run !== true ||
    dataset.changes_knowledge_approval_status !== false ||
    dataset.strategy?.locked_before_first_run !== true
  ) {
    throw new Error("answerability holdout v3 identity is invalid");
  }
  nonBlank(dataset.dataset_id, "dataset ID");
  nonBlank(dataset.purpose, "dataset purpose");
  if (
    dataset.strategy.candidate_limit !== 5 ||
    dataset.strategy.judge_prompt_version !== "answerability-v2" ||
    dataset.acceptance_targets?.overall_exact_accuracy_minimum !== 17 / 18 ||
    dataset.acceptance_targets?.per_class_accuracy_minimum !== 5 / 6 ||
    dataset.acceptance_targets?.unsafe_direct_accept_count_maximum !== 0 ||
    dataset.acceptance_targets?.judge_error_count_maximum !== 0
  ) {
    throw new Error("answerability holdout v3 strategy or targets are invalid");
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 18) {
    throw new Error("answerability holdout v3 must contain 18 cases");
  }
  const ids = new Set<string>();
  const queries = new Set<string>();
  const classCounts = new Map<AnswerabilityVerdict, number>();
  const coverage = new Map<string, Set<AnswerabilityVerdict>>();
  for (const item of dataset.cases) {
    const caseId = nonBlank(item.case_id, "case ID");
    if (ids.has(caseId)) throw new Error("answerability holdout v3 case IDs must be unique");
    ids.add(caseId);
    const query = nonBlank(item.query, `case ${caseId} query`);
    const normalized = normalizedQuery(query);
    if (queries.has(normalized) || earlierQueries.has(normalized)) {
      throw new Error(`case ${caseId} repeats an earlier query`);
    }
    queries.add(normalized);
    nonBlank(item.label_reason, `case ${caseId} label reason`);
    if (
      item.expected_verdict !== "directly_answerable" &&
      item.expected_verdict !== "partially_related" &&
      item.expected_verdict !== "not_answerable"
    ) {
      throw new Error(`case ${caseId} verdict is invalid`);
    }
    classCounts.set(
      item.expected_verdict,
      (classCounts.get(item.expected_verdict) ?? 0) + 1,
    );
    if (item.expected_verdict === "not_answerable") {
      if (item.expected_candidate_key !== null || item.expected_pdf_pages.length !== 0) {
        throw new Error("not-answerable case cannot expect a candidate");
      }
      if (
        item.boundary_kind !==
          "same_surface_terms_different_business_unit" ||
        !Array.isArray(item.surface_overlap_terms) ||
        item.surface_overlap_terms.length === 0 ||
        item.surface_overlap_terms.some(
          (term) =>
            typeof term !== "string" ||
            term.trim() === "" ||
            !query.includes(term),
        )
      ) {
        throw new Error(
          `case ${caseId} must record a real surface-term business boundary`,
        );
      }
      continue;
    }
    const candidateKey = nonBlank(
      item.expected_candidate_key,
      `case ${caseId} candidate`,
    );
    const pages = candidatePages.get(candidateKey);
    if (!pages) throw new Error(`case ${caseId} references an unknown candidate`);
    if (
      item.expected_pdf_pages.length === 0 ||
      item.expected_pdf_pages.some((page) => !pages.has(page))
    ) {
      throw new Error(`case ${caseId} has forged candidate pages`);
    }
    const verdicts = coverage.get(candidateKey) ?? new Set<AnswerabilityVerdict>();
    verdicts.add(item.expected_verdict);
    coverage.set(candidateKey, verdicts);
  }
  for (const verdict of [
    "directly_answerable",
    "partially_related",
    "not_answerable",
  ] as const) {
    if (classCounts.get(verdict) !== 6) {
      throw new Error("answerability holdout v3 must contain six cases per class");
    }
  }
  if (
    coverage.size !== 6 ||
    [...coverage.values()].some(
      (verdicts) =>
        verdicts.size !== 2 ||
        !verdicts.has("directly_answerable") ||
        !verdicts.has("partially_related"),
    )
  ) {
    throw new Error("answerability holdout v3 candidate coverage is invalid");
  }
  return dataset;
}

export async function loadAnswerabilityHoldoutV3(options?: {
  datasetPath?: string;
  candidateManifestPath?: string;
  earlierDatasetPaths?: string[];
}): Promise<AnswerabilityHoldoutV3> {
  const datasetPath =
    options?.datasetPath ?? "data/evaluation/ohf-answerability-holdout-v3.json";
  const candidateManifestPath =
    options?.candidateManifestPath ??
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
  const earlierDatasetPaths = options?.earlierDatasetPaths ?? [
    "data/evaluation/ohf-retrieval-cases-v2.json",
    "data/evaluation/ohf-answerability-holdout-v1.json",
    "data/evaluation/ohf-answerability-holdout-v2.json",
  ];
  const [datasetRaw, manifestRaw, ...earlierRaw] = await Promise.all([
    readFile(datasetPath, "utf8"),
    readFile(candidateManifestPath, "utf8"),
    ...earlierDatasetPaths.map((path) => readFile(path, "utf8")),
  ]);
  const manifest = JSON.parse(manifestRaw) as {
    candidates: Array<{
      candidate_key: string;
      sources: Array<{ pdf_page_number: number }>;
    }>;
  };
  const candidatePages = new Map(
    manifest.candidates.map((candidate) => [
      candidate.candidate_key,
      new Set(candidate.sources.map((source) => source.pdf_page_number)),
    ]),
  );
  const earlierQueries = new Set<string>();
  for (const rawText of earlierRaw) {
    const prior = JSON.parse(rawText) as { cases: Array<{ query: string }> };
    for (const item of prior.cases) earlierQueries.add(normalizedQuery(item.query));
  }
  return validateAnswerabilityHoldoutV3(
    JSON.parse(datasetRaw),
    candidatePages,
    earlierQueries,
  );
}
