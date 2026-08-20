import { readFile } from "node:fs/promises";

export interface AnswerabilityHoldoutCase {
  case_id: string;
  query: string;
  expected_behavior: "hit" | "abstain";
  expected_candidate_key: string | null;
  expected_pdf_pages: number[];
  abstain_reason?: string;
}

export interface AnswerabilityHoldoutDataset {
  schema_version: 1;
  dataset_id: string;
  purpose: string;
  product_family_code: string;
  frozen_before_first_model_run: true;
  changes_knowledge_approval_status: false;
  threshold_policy: {
    policy_id: string;
    derived_from_dataset_id: string;
    vector_similarity_minimum: number;
    comparison: "greater_than_or_equal";
    frozen_before_holdout_run: true;
  };
  acceptance_targets: {
    answerable_correct_accept_rate_minimum: number;
    unanswerable_abstain_accuracy_minimum: number;
    accepted_precision_minimum: number;
  };
  cases: AnswerabilityHoldoutCase[];
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must not be blank`);
  }
  return value.trim();
}

function rate(value: unknown, field: string): number {
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error(`${field} must be a number from zero to one`);
  }
  return value;
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, "");
}

export async function loadAnswerabilityHoldoutDataset(input: {
  datasetPath: string;
  developmentDatasetPath: string;
  candidateManifestPath: string;
}): Promise<AnswerabilityHoldoutDataset> {
  const [datasetRaw, developmentRaw, manifestRaw] = await Promise.all([
    readFile(input.datasetPath, "utf8"),
    readFile(input.developmentDatasetPath, "utf8"),
    readFile(input.candidateManifestPath, "utf8"),
  ]);
  const dataset = JSON.parse(datasetRaw) as Record<string, unknown>;
  const development = JSON.parse(developmentRaw) as {
    cases: Array<{ query: string }>;
  };
  const manifest = JSON.parse(manifestRaw) as {
    candidates: Array<{
      candidate_key: string;
      sources: Array<{ pdf_page_number: number }>;
    }>;
  };

  if (dataset.schema_version !== 1) {
    throw new Error("answerability holdout schema version must be one");
  }
  if (
    dataset.frozen_before_first_model_run !== true ||
    dataset.changes_knowledge_approval_status !== false
  ) {
    throw new Error("answerability holdout must be frozen and evaluation only");
  }
  const threshold = dataset.threshold_policy as Record<string, unknown>;
  const targets = dataset.acceptance_targets as Record<string, unknown>;
  if (
    threshold.comparison !== "greater_than_or_equal" ||
    threshold.frozen_before_holdout_run !== true
  ) {
    throw new Error("answerability threshold must be frozen before holdout run");
  }
  rate(threshold.vector_similarity_minimum, "vector similarity minimum");
  rate(
    targets.answerable_correct_accept_rate_minimum,
    "answerable correct accept target",
  );
  rate(
    targets.unanswerable_abstain_accuracy_minimum,
    "unanswerable abstain target",
  );
  rate(targets.accepted_precision_minimum, "accepted precision target");

  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 24) {
    throw new Error("answerability holdout must contain exactly 24 cases");
  }
  const candidatePages = new Map(
    manifest.candidates.map((candidate) => [
      candidate.candidate_key,
      new Set(candidate.sources.map((source) => source.pdf_page_number)),
    ]),
  );
  const developmentQueries = new Set(
    development.cases.map((item) => normalizeQuery(item.query)),
  );
  const ids = new Set<string>();
  const queries = new Set<string>();
  let hitCount = 0;
  let abstainCount = 0;

  for (const rawCase of dataset.cases as Array<Record<string, unknown>>) {
    const caseId = nonBlank(rawCase.case_id, "case id");
    const query = nonBlank(rawCase.query, `case ${caseId} query`);
    const normalizedQuery = normalizeQuery(query);
    if (ids.has(caseId)) throw new Error(`duplicate case id: ${caseId}`);
    if (queries.has(normalizedQuery)) {
      throw new Error(`duplicate holdout query: ${caseId}`);
    }
    if (developmentQueries.has(normalizedQuery)) {
      throw new Error(`holdout query duplicates development data: ${caseId}`);
    }
    ids.add(caseId);
    queries.add(normalizedQuery);

    if (!Array.isArray(rawCase.expected_pdf_pages)) {
      throw new Error(`case ${caseId} must declare expected PDF pages`);
    }
    if (rawCase.expected_behavior === "hit") {
      hitCount += 1;
      const candidateKey = nonBlank(
        rawCase.expected_candidate_key,
        `case ${caseId} candidate`,
      );
      const pages = candidatePages.get(candidateKey);
      if (!pages) throw new Error(`case ${caseId} has an unknown candidate`);
      if (
        rawCase.expected_pdf_pages.length === 0 ||
        rawCase.expected_pdf_pages.some(
          (page) => !Number.isInteger(page) || !pages.has(page as number),
        )
      ) {
        throw new Error(`case ${caseId} has forged candidate pages`);
      }
    } else if (rawCase.expected_behavior === "abstain") {
      abstainCount += 1;
      if (
        rawCase.expected_candidate_key !== null ||
        rawCase.expected_pdf_pages.length !== 0
      ) {
        throw new Error(`case ${caseId} abstain label invents a source`);
      }
      nonBlank(rawCase.abstain_reason, `case ${caseId} abstain reason`);
    } else {
      throw new Error(`case ${caseId} has invalid expected behavior`);
    }
  }
  if (hitCount !== 12 || abstainCount !== 12) {
    throw new Error("answerability holdout must have 12 hit and 12 abstain cases");
  }

  return dataset as unknown as AnswerabilityHoldoutDataset;
}
