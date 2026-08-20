import { readdir, readFile } from "node:fs/promises";

import type { AnswerabilityVerdict } from "./qwen-answerability-judge.ts";
import type { SourceIdentityCandidateFixture } from "./source-identity-unseen-dataset.ts";

export interface SourceIdentityUnseenV4Case {
  case_id: string;
  raw_question: string;
  confirmed_content_question: string;
  requested_source_identity: {
    document_reference: string;
    version_label: string;
    language_code: string;
  };
  candidate_keys: string[];
  raw_override_present: boolean;
  expected_program_reject: boolean;
  expected_model_invoked: boolean;
  expected_verdict: AnswerabilityVerdict;
  expected_candidate_key: string | null;
  expected_source_page_number: number | null;
}

export interface SourceIdentityUnseenV4Dataset {
  schema_version: 1;
  dataset_id: "source-identity-unseen-v4";
  dataset_role: "project_authored_unseen_before_first_model_run";
  purpose: string;
  frozen_before_first_model_run: true;
  source_fixture_disclosure: string;
  strategy: {
    judge_model_id: "qwen3.7-plus";
    judge_prompt_version: "answerability-v8-candidate-isolated";
    main_chain_source_identity_binding: "database-source-chain-v1";
    source_constraint: "confirmed-source-exact-v1";
    raw_question_forwarding: "forbidden";
    orchestration_scope: "formal_main_chain_confirmed_answerability_gate_only";
    locked_before_first_run: true;
  };
  acceptance_targets: {
    exact_case_count_minimum: 11;
    unmatched_source_accept_count_maximum: 0;
    judge_error_count_maximum: 0;
  };
  candidates: SourceIdentityCandidateFixture[];
  cases: SourceIdentityUnseenV4Case[];
  interpretation_limits: string[];
}

function requiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function normalizedQuestion(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、,.!?：:；;“”"'（）()\[\]]+/g, "");
}

function normalizedIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function collectEarlierQuestions(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectEarlierQuestions(child, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      [
        "question",
        "query",
        "query_text",
        "user_message",
        "userMessage",
        "raw_question",
        "confirmed_content_question",
      ].includes(key)
    ) {
      output.push(child);
    } else {
      collectEarlierQuestions(child, output);
    }
  }
}

function candidateMatchesRequest(
  candidate: SourceIdentityCandidateFixture,
  request: SourceIdentityUnseenV4Case["requested_source_identity"],
): boolean {
  return (
    normalizedIdentity(candidate.document_reference) ===
      normalizedIdentity(request.document_reference) &&
    normalizedIdentity(candidate.version_label) ===
      normalizedIdentity(request.version_label) &&
    normalizedIdentity(candidate.language_code) ===
      normalizedIdentity(request.language_code)
  );
}

export function validateSourceIdentityUnseenV4Dataset(
  raw: unknown,
): SourceIdentityUnseenV4Dataset {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("source identity unseen v4 dataset must be an object");
  }
  const dataset = raw as SourceIdentityUnseenV4Dataset;
  if (
    dataset.schema_version !== 1 ||
    dataset.dataset_id !== "source-identity-unseen-v4" ||
    dataset.dataset_role !== "project_authored_unseen_before_first_model_run" ||
    dataset.frozen_before_first_model_run !== true
  ) {
    throw new Error("source identity unseen v4 identity is invalid");
  }
  requiredText(dataset.purpose, "dataset purpose");
  requiredText(dataset.source_fixture_disclosure, "source fixture disclosure");
  if (
    dataset.strategy?.judge_model_id !== "qwen3.7-plus" ||
    dataset.strategy.judge_prompt_version !==
      "answerability-v8-candidate-isolated" ||
    dataset.strategy.main_chain_source_identity_binding !==
      "database-source-chain-v1" ||
    dataset.strategy.source_constraint !== "confirmed-source-exact-v1" ||
    dataset.strategy.raw_question_forwarding !== "forbidden" ||
    dataset.strategy.orchestration_scope !==
      "formal_main_chain_confirmed_answerability_gate_only" ||
    dataset.strategy.locked_before_first_run !== true
  ) {
    throw new Error("source identity unseen v4 strategy is invalid");
  }
  if (
    dataset.acceptance_targets?.exact_case_count_minimum !== 11 ||
    dataset.acceptance_targets.unmatched_source_accept_count_maximum !== 0 ||
    dataset.acceptance_targets.judge_error_count_maximum !== 0
  ) {
    throw new Error("source identity unseen v4 acceptance targets are invalid");
  }
  if (!Array.isArray(dataset.candidates) || dataset.candidates.length < 5) {
    throw new Error("source identity unseen v4 needs candidate fixtures");
  }

  const candidates = new Map<string, SourceIdentityCandidateFixture>();
  for (const candidate of dataset.candidates) {
    const key = requiredText(candidate.candidate_key, "candidate key");
    if (candidates.has(key)) throw new Error("candidate keys must be unique");
    requiredText(candidate.document_reference, `${key} document reference`);
    requiredText(candidate.version_label, `${key} version label`);
    requiredText(candidate.language_code, `${key} language code`);
    requiredText(candidate.section_title, `${key} section title`);
    requiredText(candidate.text, `${key} text`);
    if (!Number.isSafeInteger(candidate.page_number) || candidate.page_number <= 0) {
      throw new Error(`${key} page number is invalid`);
    }
    if (
      candidate.fixture_role !==
      "controlled_source_identity_variant_not_official_document_claim"
    ) {
      throw new Error(`${key} fixture role is invalid`);
    }
    candidates.set(key, candidate);
  }

  if (!Array.isArray(dataset.cases) || dataset.cases.length !== 12) {
    throw new Error("source identity unseen v4 must contain twelve cases");
  }
  const caseIds = new Set<string>();
  const allQuestions = new Set<string>();
  let programRejectCount = 0;
  let rawOverrideCount = 0;
  for (const item of dataset.cases) {
    const caseId = requiredText(item.case_id, "case ID");
    if (caseIds.has(caseId)) throw new Error("case IDs must be unique");
    caseIds.add(caseId);
    const rawQuestion = requiredText(item.raw_question, `${caseId} raw question`);
    const confirmedQuestion = requiredText(
      item.confirmed_content_question,
      `${caseId} confirmed content question`,
    );
    for (const question of [rawQuestion, confirmedQuestion]) {
      const normalized = normalizedQuestion(question);
      if (allQuestions.has(normalized)) {
        throw new Error(`${caseId} question is duplicated inside v4`);
      }
      allQuestions.add(normalized);
    }
    if (/NVE41300|NHA80940|zh-CN|en-US|第0?\d版/i.test(confirmedQuestion)) {
      throw new Error(`${caseId} confirmed question contains source identity`);
    }
    const request = item.requested_source_identity;
    requiredText(request?.document_reference, `${caseId} requested document`);
    requiredText(request?.version_label, `${caseId} requested version`);
    requiredText(request?.language_code, `${caseId} requested language`);
    if (
      !Array.isArray(item.candidate_keys) ||
      item.candidate_keys.length < 1 ||
      item.candidate_keys.length > 5 ||
      new Set(item.candidate_keys).size !== item.candidate_keys.length
    ) {
      throw new Error(`${caseId} candidate keys are invalid`);
    }
    const selectedCandidates = item.candidate_keys.map((key) => {
      const candidate = candidates.get(key);
      if (!candidate) throw new Error(`${caseId} references missing candidate ${key}`);
      return candidate;
    });
    const hasExactSource = selectedCandidates.some((candidate) =>
      candidateMatchesRequest(candidate, request),
    );
    if (item.expected_program_reject !== !hasExactSource) {
      throw new Error(`${caseId} program-reject expectation is not data-derived`);
    }
    if (item.expected_model_invoked !== hasExactSource) {
      throw new Error(`${caseId} model-call expectation is invalid`);
    }
    if (item.expected_program_reject) {
      programRejectCount += 1;
      if (
        item.expected_verdict !== "not_answerable" ||
        item.expected_candidate_key !== null ||
        item.expected_source_page_number !== null
      ) {
        throw new Error(`${caseId} program rejection output is invalid`);
      }
    } else {
      if (
        item.expected_candidate_key === null ||
        !item.candidate_keys.includes(item.expected_candidate_key)
      ) {
        throw new Error(`${caseId} expected candidate is invalid`);
      }
      const expectedCandidate = candidates.get(item.expected_candidate_key)!;
      if (!candidateMatchesRequest(expectedCandidate, request)) {
        throw new Error(`${caseId} expected candidate violates source constraint`);
      }
      if (item.expected_source_page_number !== expectedCandidate.page_number) {
        throw new Error(`${caseId} expected page is invalid`);
      }
    }
    if (typeof item.raw_override_present !== "boolean") {
      throw new Error(`${caseId} raw override flag is invalid`);
    }
    if (item.raw_override_present) rawOverrideCount += 1;
  }
  if (programRejectCount < 5) {
    throw new Error("source identity unseen v4 needs five program rejections");
  }
  if (rawOverrideCount < 8) {
    throw new Error("source identity unseen v4 needs eight raw overrides");
  }
  if (!Array.isArray(dataset.interpretation_limits) || dataset.interpretation_limits.length < 4) {
    throw new Error("source identity unseen v4 needs interpretation limits");
  }
  dataset.interpretation_limits.forEach((value, index) =>
    requiredText(value, `interpretation limit ${index + 1}`),
  );
  return dataset;
}

export async function loadSourceIdentityUnseenV4Dataset(
  path = "data/evaluation/source-identity-unseen-v4.json",
): Promise<SourceIdentityUnseenV4Dataset> {
  const dataset = validateSourceIdentityUnseenV4Dataset(
    JSON.parse(await readFile(path, "utf8")),
  );
  const earlierQuestions: string[] = [];
  const names = (await readdir("data/evaluation"))
    .filter(
      (name) => name.endsWith(".json") && name !== "source-identity-unseen-v4.json",
    )
    .sort();
  for (const name of names) {
    collectEarlierQuestions(
      JSON.parse(await readFile(`data/evaluation/${name}`, "utf8")),
      earlierQuestions,
    );
  }
  const earlier = new Set(earlierQuestions.map(normalizedQuestion));
  for (const item of dataset.cases) {
    for (const [kind, question] of [
      ["raw", item.raw_question],
      ["confirmed", item.confirmed_content_question],
    ] as const) {
      if (earlier.has(normalizedQuestion(question))) {
        throw new Error(`${item.case_id} ${kind} question already appeared earlier`);
      }
    }
  }
  return dataset;
}
