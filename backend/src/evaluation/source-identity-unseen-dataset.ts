import { readdir, readFile } from "node:fs/promises";

import type { AnswerabilityVerdict } from "./qwen-answerability-judge.ts";

export type SourceIdentityMismatchDimension =
  | "document_reference"
  | "version_label"
  | "language_code"
  | "instruction_override";

export type SourceIdentityExpectation =
  | "exact_match"
  | "mismatch"
  | "not_specified";

export interface SourceIdentityCandidateFixture {
  candidate_key: string;
  document_reference: string;
  version_label: string;
  language_code: string;
  section_title: string;
  page_number: number;
  text: string;
  fixture_role: "controlled_source_identity_variant_not_official_document_claim";
}

export interface SourceIdentityUnseenCase {
  case_id: string;
  question: string;
  candidate_keys: string[];
  source_expectation: SourceIdentityExpectation;
  mismatch_dimensions: SourceIdentityMismatchDimension[];
  expected_verdict: AnswerabilityVerdict;
  expected_candidate_key: string | null;
  expected_source_page_number: number | null;
}

export interface SourceIdentityUnseenDataset {
  schema_version: 1;
  dataset_id: "source-identity-unseen-v1";
  dataset_role: "project_authored_unseen_before_first_model_run";
  purpose: string;
  frozen_before_first_model_run: true;
  source_fixture_disclosure: string;
  strategy: {
    judge_model_id: "qwen3.7-plus";
    judge_prompt_version: "answerability-v6-source-aware";
    main_chain_source_identity_binding: "database-source-chain-v1";
    orchestration_scope: "formal_main_chain_answerability_gate_only";
    locked_before_first_run: true;
  };
  acceptance_targets: {
    exact_case_count_minimum: 11;
    forged_source_accept_count_maximum: 0;
    judge_error_count_maximum: 0;
  };
  candidates: SourceIdentityCandidateFixture[];
  cases: SourceIdentityUnseenCase[];
  interpretation_limits: string[];
}

const verdicts = new Set<AnswerabilityVerdict>([
  "directly_answerable",
  "partially_related",
  "not_answerable",
]);
const expectations = new Set<SourceIdentityExpectation>([
  "exact_match",
  "mismatch",
  "not_specified",
]);
const dimensions = new Set<SourceIdentityMismatchDimension>([
  "document_reference",
  "version_label",
  "language_code",
  "instruction_override",
]);

function requiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function normalizedQuestion(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s，。、“”‘’：:；;？?！!（）()、-]/g, "");
}

function collectQuestions(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectQuestions(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      ["question", "query", "query_text", "user_message", "userMessage"].includes(key)
    ) {
      output.push(child);
    } else if (key === "search_queries" && Array.isArray(child)) {
      output.push(...child.filter((item): item is string => typeof item === "string"));
    } else {
      collectQuestions(child, output);
    }
  }
}

export function assertSourceIdentityQuestionsAreNovel(
  dataset: SourceIdentityUnseenDataset,
  earlierQuestions: readonly string[],
): void {
  const earlier = new Set(earlierQuestions.map(normalizedQuestion));
  for (const item of dataset.cases) {
    if (earlier.has(normalizedQuestion(item.question))) {
      throw new Error(`case ${item.case_id} question already appeared earlier`);
    }
  }
}

export function validateSourceIdentityUnseenDataset(
  raw: unknown,
): SourceIdentityUnseenDataset {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("source identity unseen dataset must be an object");
  }
  const dataset = raw as SourceIdentityUnseenDataset;
  if (
    dataset.schema_version !== 1 ||
    dataset.dataset_id !== "source-identity-unseen-v1" ||
    dataset.dataset_role !== "project_authored_unseen_before_first_model_run" ||
    dataset.frozen_before_first_model_run !== true
  ) {
    throw new Error("source identity unseen dataset identity is invalid");
  }
  requiredText(dataset.purpose, "dataset purpose");
  requiredText(dataset.source_fixture_disclosure, "source fixture disclosure");
  if (
    dataset.strategy?.judge_model_id !== "qwen3.7-plus" ||
    dataset.strategy.judge_prompt_version !== "answerability-v6-source-aware" ||
    dataset.strategy.main_chain_source_identity_binding !== "database-source-chain-v1" ||
    dataset.strategy.orchestration_scope !== "formal_main_chain_answerability_gate_only" ||
    dataset.strategy.locked_before_first_run !== true
  ) {
    throw new Error("source identity unseen strategy is invalid");
  }
  if (
    dataset.acceptance_targets?.exact_case_count_minimum !== 11 ||
    dataset.acceptance_targets.forged_source_accept_count_maximum !== 0 ||
    dataset.acceptance_targets.judge_error_count_maximum !== 0
  ) {
    throw new Error("source identity unseen acceptance targets are invalid");
  }
  if (!Array.isArray(dataset.candidates) || dataset.candidates.length < 4) {
    throw new Error("source identity unseen dataset needs candidate fixtures");
  }

  const candidates = new Map<string, SourceIdentityCandidateFixture>();
  for (const candidate of dataset.candidates) {
    const key = requiredText(candidate.candidate_key, "candidate key");
    if (candidates.has(key)) throw new Error("candidate keys must be unique");
    requiredText(candidate.document_reference, `candidate ${key} document reference`);
    requiredText(candidate.version_label, `candidate ${key} version label`);
    requiredText(candidate.language_code, `candidate ${key} language code`);
    requiredText(candidate.section_title, `candidate ${key} section title`);
    requiredText(candidate.text, `candidate ${key} text`);
    if (!Number.isSafeInteger(candidate.page_number) || candidate.page_number <= 0) {
      throw new Error(`candidate ${key} page number is invalid`);
    }
    if (
      candidate.fixture_role !==
      "controlled_source_identity_variant_not_official_document_claim"
    ) {
      throw new Error(`candidate ${key} fixture role is invalid`);
    }
    candidates.set(key, candidate);
  }

  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 12) {
    throw new Error("source identity unseen dataset must contain twelve cases");
  }
  const caseIds = new Set<string>();
  const questions = new Set<string>();
  let mismatchCount = 0;
  for (const item of dataset.cases) {
    const caseId = requiredText(item.case_id, "case ID");
    if (caseIds.has(caseId)) throw new Error("case IDs must be unique");
    caseIds.add(caseId);
    const question = normalizedQuestion(requiredText(item.question, `case ${caseId} question`));
    if (questions.has(question)) throw new Error("case questions must be unique");
    questions.add(question);
    if (!Array.isArray(item.candidate_keys) || item.candidate_keys.length < 1 || item.candidate_keys.length > 5) {
      throw new Error(`case ${caseId} candidate keys are invalid`);
    }
    if (new Set(item.candidate_keys).size !== item.candidate_keys.length) {
      throw new Error(`case ${caseId} candidate keys must be unique`);
    }
    for (const key of item.candidate_keys) {
      if (!candidates.has(key)) throw new Error(`case ${caseId} references a missing candidate`);
    }
    if (!expectations.has(item.source_expectation)) {
      throw new Error(`case ${caseId} source expectation is invalid`);
    }
    if (
      !Array.isArray(item.mismatch_dimensions) ||
      item.mismatch_dimensions.some((dimension) => !dimensions.has(dimension)) ||
      new Set(item.mismatch_dimensions).size !== item.mismatch_dimensions.length
    ) {
      throw new Error(`case ${caseId} mismatch dimensions are invalid`);
    }
    if (item.source_expectation === "mismatch") {
      mismatchCount += 1;
      if (item.mismatch_dimensions.length === 0 || item.expected_verdict !== "not_answerable") {
        throw new Error(`case ${caseId} mismatch label is contradictory`);
      }
    } else if (item.mismatch_dimensions.length !== 0) {
      throw new Error(`case ${caseId} cannot declare mismatch dimensions`);
    }
    if (!verdicts.has(item.expected_verdict)) {
      throw new Error(`case ${caseId} expected verdict is invalid`);
    }
    if (item.expected_verdict === "not_answerable") {
      if (item.expected_candidate_key !== null || item.expected_source_page_number !== null) {
        throw new Error(`case ${caseId} refusal evidence must be null`);
      }
    } else {
      if (
        typeof item.expected_candidate_key !== "string" ||
        !item.candidate_keys.includes(item.expected_candidate_key)
      ) {
        throw new Error(`case ${caseId} expected candidate is invalid`);
      }
      const candidate = candidates.get(item.expected_candidate_key)!;
      if (item.expected_source_page_number !== candidate.page_number) {
        throw new Error(`case ${caseId} expected page is invalid`);
      }
    }
  }
  if (mismatchCount !== 6) {
    throw new Error("source identity unseen dataset must contain six mismatch cases");
  }
  if (!Array.isArray(dataset.interpretation_limits) || dataset.interpretation_limits.length < 3) {
    throw new Error("source identity unseen interpretation limits are incomplete");
  }
  dataset.interpretation_limits.forEach((value, index) =>
    requiredText(value, `interpretation limit ${index + 1}`),
  );
  return dataset;
}

export async function loadSourceIdentityUnseenDataset(
  path = "data/evaluation/source-identity-unseen-v1.json",
): Promise<SourceIdentityUnseenDataset> {
  const dataset = validateSourceIdentityUnseenDataset(
    JSON.parse(await readFile(path, "utf8")),
  );
  const earlierQuestions: string[] = [];
  const names = (await readdir("data/evaluation"))
    .filter((name) => name.endsWith(".json") && name !== "source-identity-unseen-v1.json")
    .sort();
  for (const name of names) {
    collectQuestions(
      JSON.parse(await readFile(`data/evaluation/${name}`, "utf8")),
      earlierQuestions,
    );
  }
  assertSourceIdentityQuestionsAreNovel(dataset, earlierQuestions);
  return dataset;
}
