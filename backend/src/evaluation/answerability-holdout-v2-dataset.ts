import { readFile } from "node:fs/promises";

export interface AnswerabilityHoldoutV2Case {
  case_id: string;
  query: string;
  expected_behavior: "hit" | "abstain";
  expected_candidate_key: string | null;
  expected_pdf_pages: number[];
  abstain_reason?: string;
}

export interface AnswerabilityHoldoutV2 {
  schema_version: number;
  dataset_id: string;
  purpose: string;
  dataset_role: string;
  product_family_code: string;
  frozen_before_first_model_run: boolean;
  changes_knowledge_approval_status: boolean;
  strategy: {
    strategy_id: string;
    candidate_limit: number;
    embedding_model_id: string;
    embedding_model_revision: string;
    judge_model_id: string;
    judge_prompt_version: string;
    locked_before_first_run: boolean;
  };
  acceptance_targets: {
    answerable_correct_accept_rate_minimum: number;
    unanswerable_abstain_accuracy_minimum: number;
    accepted_precision_minimum: number;
    judge_error_count_maximum: number;
  };
  cases: AnswerabilityHoldoutV2Case[];
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

function validRate(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error(`${fieldName} must be from zero to one`);
  }
  return value;
}

export function validateAnswerabilityHoldoutV2(
  raw: unknown,
  candidatePages: ReadonlyMap<string, ReadonlySet<number>>,
  earlierQueries: ReadonlySet<string>,
  options: { enforceProductionShape?: boolean } = {},
): AnswerabilityHoldoutV2 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("answerability holdout v2 must be an object");
  }
  const dataset = raw as AnswerabilityHoldoutV2;
  if (dataset.schema_version !== 1) {
    throw new Error("answerability holdout v2 schema version must be one");
  }
  nonBlank(dataset.dataset_id, "dataset ID");
  nonBlank(dataset.purpose, "dataset purpose");
  if (dataset.dataset_role !== "unseen_holdout_before_first_run") {
    throw new Error("answerability holdout v2 must be marked as unseen before first run");
  }
  if (
    dataset.frozen_before_first_model_run !== true ||
    dataset.changes_knowledge_approval_status !== false ||
    dataset.strategy?.locked_before_first_run !== true
  ) {
    throw new Error("answerability holdout v2 must be frozen and evaluation only");
  }
  if (dataset.strategy.candidate_limit !== 5) {
    throw new Error("answerability holdout v2 candidate limit must be five");
  }
  nonBlank(dataset.strategy.strategy_id, "strategy ID");
  nonBlank(dataset.strategy.embedding_model_id, "embedding model ID");
  nonBlank(dataset.strategy.embedding_model_revision, "embedding model revision");
  nonBlank(dataset.strategy.judge_model_id, "judge model ID");
  nonBlank(dataset.strategy.judge_prompt_version, "judge prompt version");
  validRate(
    dataset.acceptance_targets?.answerable_correct_accept_rate_minimum,
    "answerable target",
  );
  validRate(
    dataset.acceptance_targets?.unanswerable_abstain_accuracy_minimum,
    "unanswerable target",
  );
  validRate(
    dataset.acceptance_targets?.accepted_precision_minimum,
    "precision target",
  );
  if (dataset.acceptance_targets?.judge_error_count_maximum !== 0) {
    throw new Error("answerability holdout v2 judge error maximum must be zero");
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error("answerability holdout v2 needs cases");
  }
  const caseIds = new Set<string>();
  const queries = new Set<string>();
  const candidateCounts = new Map<string, number>();
  let hitCount = 0;
  let abstainCount = 0;
  for (const item of dataset.cases) {
    const caseId = nonBlank(item.case_id, "case ID");
    if (caseIds.has(caseId)) {
      throw new Error("answerability holdout v2 case IDs must be unique");
    }
    caseIds.add(caseId);
    const query = nonBlank(item.query, `case ${caseId} query`);
    const normalized = normalizedQuery(query);
    if (queries.has(normalized)) {
      throw new Error(`case ${caseId} repeats a query in this dataset`);
    }
    if (earlierQueries.has(normalized)) {
      throw new Error(`case ${caseId} repeats an earlier query`);
    }
    queries.add(normalized);
    if (!Array.isArray(item.expected_pdf_pages)) {
      throw new Error(`case ${caseId} expected pages must be an array`);
    }
    if (item.expected_behavior === "hit") {
      hitCount += 1;
      const candidateKey = nonBlank(
        item.expected_candidate_key,
        `case ${caseId} candidate`,
      );
      const pages = candidatePages.get(candidateKey);
      if (!pages) throw new Error(`case ${caseId} references an unknown candidate`);
      if (
        item.expected_pdf_pages.length === 0 ||
        item.expected_pdf_pages.some(
          (page) => !Number.isSafeInteger(page) || !pages.has(page),
        )
      ) {
        throw new Error(`case ${caseId} has forged candidate pages`);
      }
      candidateCounts.set(
        candidateKey,
        (candidateCounts.get(candidateKey) ?? 0) + 1,
      );
    } else if (item.expected_behavior === "abstain") {
      abstainCount += 1;
      if (item.expected_candidate_key !== null) {
        throw new Error("abstain case cannot expect a candidate");
      }
      if (item.expected_pdf_pages.length !== 0) {
        throw new Error("abstain case cannot expect candidate pages");
      }
      nonBlank(item.abstain_reason, `case ${caseId} abstain reason`);
    } else {
      throw new Error(`case ${caseId} behavior is invalid`);
    }
  }
  if (options.enforceProductionShape !== false) {
    if (dataset.cases.length !== 36 || hitCount !== 18 || abstainCount !== 18) {
      throw new Error("answerability holdout v2 must have 18 hit and 18 abstain cases");
    }
    if (
      candidateCounts.size !== 6 ||
      [...candidateCounts.values()].some((count) => count !== 3)
    ) {
      throw new Error("answerability holdout v2 must have three hit cases per candidate");
    }
  }
  return dataset;
}

export async function loadAnswerabilityHoldoutV2(options?: {
  datasetPath?: string;
  candidateManifestPath?: string;
  earlierDatasetPaths?: string[];
}): Promise<AnswerabilityHoldoutV2> {
  const datasetPath =
    options?.datasetPath ?? "data/evaluation/ohf-answerability-holdout-v2.json";
  const candidateManifestPath =
    options?.candidateManifestPath ??
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
  const earlierDatasetPaths = options?.earlierDatasetPaths ?? [
    "data/evaluation/ohf-retrieval-cases-v2.json",
    "data/evaluation/ohf-answerability-holdout-v1.json",
  ];
  const [datasetRaw, manifestRaw, ...earlierRaw] = await Promise.all([
    readFile(datasetPath, "utf8"),
    readFile(candidateManifestPath, "utf8"),
    ...earlierDatasetPaths.map((path) => readFile(path, "utf8")),
  ]);
  const manifest = JSON.parse(manifestRaw) as {
    review_status: string;
    candidates: Array<{
      candidate_key: string;
      sources: Array<{ pdf_page_number: number }>;
    }>;
  };
  if (manifest.review_status !== "unreviewed") {
    throw new Error("answerability holdout v2 expects unreviewed candidates");
  }
  const candidatePages = new Map(
    manifest.candidates.map((candidate) => [
      candidate.candidate_key,
      new Set(candidate.sources.map((source) => source.pdf_page_number)),
    ]),
  );
  const earlierQueries = new Set<string>();
  for (const rawText of earlierRaw) {
    const prior = JSON.parse(rawText) as { cases: Array<{ query: string }> };
    for (const item of prior.cases) {
      earlierQueries.add(normalizedQuery(item.query));
    }
  }
  return validateAnswerabilityHoldoutV2(
    JSON.parse(datasetRaw),
    candidatePages,
    earlierQueries,
  );
}
