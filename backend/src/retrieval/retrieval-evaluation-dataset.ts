import { readFile } from "node:fs/promises";

export type RetrievalLanguageStyle = "exact_term" | "colloquial" | "paraphrase";
export type RetrievalRiskClass = "reference" | "high_risk" | "not_applicable";
export type RetrievalScopeClass = "in_scope" | "out_of_scope" | "unanswerable";

export interface HitRetrievalEvaluationCase {
  case_id: string;
  query: string;
  language_style: RetrievalLanguageStyle;
  risk_class: "reference" | "high_risk";
  scope_class: "in_scope";
  expected_behavior: "hit";
  expected_candidate_key: string;
  source_basis: { candidate_key: string; pdf_pages: number[] };
}

export interface AbstainRetrievalEvaluationCase {
  case_id: string;
  query: string;
  language_style: RetrievalLanguageStyle;
  risk_class: "not_applicable";
  scope_class: "out_of_scope" | "unanswerable";
  expected_behavior: "abstain";
  expected_candidate_key: null;
  source_basis: { reason: string };
}

export type RetrievalEvaluationCase =
  | HitRetrievalEvaluationCase
  | AbstainRetrievalEvaluationCase;

export interface RetrievalEvaluationDataset {
  schema_version: 2;
  dataset_id: string;
  purpose: string;
  product_family_code: string;
  changes_knowledge_approval_status: false;
  cases: RetrievalEvaluationCase[];
}

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    sources: Array<{ pdf_page_number: number }>;
  }>;
}

const languageStyles = new Set<RetrievalLanguageStyle>([
  "exact_term",
  "colloquial",
  "paraphrase",
]);
const riskClasses = new Set<RetrievalRiskClass>([
  "reference",
  "high_risk",
  "not_applicable",
]);
const scopeClasses = new Set<RetrievalScopeClass>([
  "in_scope",
  "out_of_scope",
  "unanswerable",
]);

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be non-blank text`);
  }
  return value.trim();
}

export function validateRetrievalEvaluationDataset(
  value: unknown,
  candidatePages: ReadonlyMap<string, ReadonlySet<number>>,
): asserts value is RetrievalEvaluationDataset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("retrieval evaluation dataset must be an object");
  }
  const dataset = value as Record<string, unknown>;
  if (dataset.schema_version !== 2) {
    throw new Error("retrieval evaluation schema version must be 2");
  }
  requiredText(dataset.dataset_id, "dataset id");
  requiredText(dataset.purpose, "dataset purpose");
  requiredText(dataset.product_family_code, "product family code");
  if (dataset.changes_knowledge_approval_status !== false) {
    throw new Error("evaluation dataset must not change knowledge approval state");
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error("retrieval evaluation dataset must contain cases");
  }

  const caseIds = new Set<string>();
  for (const rawCase of dataset.cases) {
    if (typeof rawCase !== "object" || rawCase === null || Array.isArray(rawCase)) {
      throw new Error("retrieval evaluation case must be an object");
    }
    const item = rawCase as Record<string, unknown>;
    const caseId = requiredText(item.case_id, "case id");
    if (caseIds.has(caseId)) throw new Error(`duplicate case id: ${caseId}`);
    caseIds.add(caseId);
    requiredText(item.query, "query");
    if (!languageStyles.has(item.language_style as RetrievalLanguageStyle)) {
      throw new Error(`case ${caseId} has invalid language style`);
    }
    if (!riskClasses.has(item.risk_class as RetrievalRiskClass)) {
      throw new Error(`case ${caseId} has invalid risk class`);
    }
    if (!scopeClasses.has(item.scope_class as RetrievalScopeClass)) {
      throw new Error(`case ${caseId} has invalid scope class`);
    }
    if (typeof item.source_basis !== "object" || item.source_basis === null) {
      throw new Error(`case ${caseId} source basis is required`);
    }
    const sourceBasis = item.source_basis as Record<string, unknown>;

    if (item.expected_behavior === "hit") {
      if (item.scope_class !== "in_scope") {
        throw new Error(`case ${caseId} hit behavior requires in-scope data`);
      }
      if (item.risk_class === "not_applicable") {
        throw new Error(`case ${caseId} hit behavior requires a risk class`);
      }
      const expectedCandidate = requiredText(
        item.expected_candidate_key,
        "expected candidate key",
      );
      if (!candidatePages.has(expectedCandidate)) {
        throw new Error(`case ${caseId} references unknown candidate`);
      }
      if (sourceBasis.candidate_key !== expectedCandidate) {
        throw new Error(`case ${caseId} source candidate does not match expectation`);
      }
      if (!Array.isArray(sourceBasis.pdf_pages) || sourceBasis.pdf_pages.length === 0) {
        throw new Error(`case ${caseId} source pages are required`);
      }
      const knownPages = candidatePages.get(expectedCandidate)!;
      for (const page of sourceBasis.pdf_pages) {
        if (!Number.isSafeInteger(page) || !knownPages.has(Number(page))) {
          throw new Error(`case ${caseId} source page is not in the candidate manifest`);
        }
      }
    } else if (item.expected_behavior === "abstain") {
      if (item.scope_class === "in_scope") {
        throw new Error(`case ${caseId} abstain behavior requires a refusal scope`);
      }
      if (item.risk_class !== "not_applicable") {
        throw new Error(`case ${caseId} abstain behavior must not invent a risk class`);
      }
      if (item.expected_candidate_key !== null) {
        throw new Error(`case ${caseId} abstain behavior cannot expect a candidate`);
      }
      requiredText(sourceBasis.reason, "abstain reason");
    } else {
      throw new Error(`case ${caseId} has invalid expected behavior`);
    }
  }
}

export async function loadRetrievalEvaluationDataset(input: {
  datasetPath: string;
  candidateManifestPath: string;
}): Promise<RetrievalEvaluationDataset> {
  const [datasetRaw, manifestRaw] = await Promise.all([
    readFile(input.datasetPath, "utf8"),
    readFile(input.candidateManifestPath, "utf8"),
  ]);
  const dataset = JSON.parse(datasetRaw) as unknown;
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  if (manifest.review_status !== "unreviewed") {
    throw new Error("evaluation expects candidate knowledge to remain unreviewed");
  }
  const candidatePages = new Map<string, Set<number>>();
  for (const candidate of manifest.candidates) {
    candidatePages.set(
      candidate.candidate_key,
      new Set(candidate.sources.map((source) => source.pdf_page_number)),
    );
  }
  validateRetrievalEvaluationDataset(dataset, candidatePages);
  return dataset;
}
