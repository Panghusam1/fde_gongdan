import { performance } from "node:perf_hooks";

import { PGlite, type PGliteInterface } from "@electric-sql/pglite";

import type { WorkOrderMainChainV4 } from "../coordinator/work-order-main-chain-v4.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";
import { CONFIRMED_SOURCE_NO_MATCH_REASON } from "./confirmed-source-work-order-judge.ts";
import type { AnswerabilityVerdict } from "./qwen-answerability-judge.ts";
import type { SourceIdentityCandidateFixture } from "./source-identity-unseen-dataset.ts";
import type {
  SourceIdentityUnseenV4Case,
  SourceIdentityUnseenV4Dataset,
} from "./source-identity-unseen-v4-dataset.ts";

interface ActualCase {
  case_id: string;
  actual_verdict: AnswerabilityVerdict | "judge_error";
  actual_candidate_key: string | null;
  actual_source_page_number: number | null;
  actual_supporting_quote: string | null;
  decision_source:
    | "program_no_matching_source"
    | "content_model"
    | "judge_error";
  reason: string;
  duration_ms: number;
}

const noRetrievalEmbedder: QueryEmbedder = {
  modelId: "source-identity-evaluation-no-retrieval",
  modelRevision: "4",
  dimensions: 1,
  isNormalized: true,
  async embedQuery() {
    throw new Error("source identity evaluation must not run retrieval");
  },
};

async function openDatabase(): Promise<PGlite> {
  const database = await PGlite.create({ dataDir: "memory://" });
  await database.exec(`
    create table source_documents (
      id bigint generated always as identity primary key,
      document_reference text not null unique
    );
    create table source_versions (
      id bigint generated always as identity primary key,
      source_document_id bigint not null references source_documents(id),
      version_label text not null,
      language_code text not null,
      unique (source_document_id, version_label, language_code)
    );
    create table knowledge_chunks (
      id bigint generated always as identity primary key,
      source_version_id bigint not null references source_versions(id)
    );
    create table knowledge_search_hits (
      id bigint generated always as identity primary key,
      knowledge_chunk_id bigint not null references knowledge_chunks(id)
    );
  `);
  return database;
}

async function seedCandidates(
  database: PGliteInterface,
  fixtures: readonly SourceIdentityCandidateFixture[],
): Promise<Map<string, string>> {
  const documents = new Map<string, number>();
  const versions = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const fixture of fixtures) {
    let documentId = documents.get(fixture.document_reference);
    if (!documentId) {
      const result = await database.query<{ id: number }>(
        "insert into source_documents (document_reference) values ($1) returning id",
        [fixture.document_reference],
      );
      documentId = result.rows[0].id;
      documents.set(fixture.document_reference, documentId);
    }
    const versionKey = `${documentId}|${fixture.version_label}|${fixture.language_code}`;
    let versionId = versions.get(versionKey);
    if (!versionId) {
      const result = await database.query<{ id: number }>(
        `
          insert into source_versions (
            source_document_id, version_label, language_code
          )
          values ($1, $2, $3)
          returning id
        `,
        [documentId, fixture.version_label, fixture.language_code],
      );
      versionId = result.rows[0].id;
      versions.set(versionKey, versionId);
    }
    const chunk = await database.query<{ id: number }>(
      "insert into knowledge_chunks (source_version_id) values ($1) returning id",
      [versionId],
    );
    const hit = await database.query<{ id: number }>(
      "insert into knowledge_search_hits (knowledge_chunk_id) values ($1) returning id",
      [chunk.rows[0].id],
    );
    ids.set(fixture.candidate_key, String(hit.rows[0].id));
  }
  return ids;
}

function score(
  dataset: SourceIdentityUnseenV4Dataset,
  actualCases: ActualCase[],
) {
  const actualById = new Map(actualCases.map((item) => [item.case_id, item]));
  const cases = dataset.cases.map((expected: SourceIdentityUnseenV4Case) => {
    const actual = actualById.get(expected.case_id);
    if (!actual) throw new Error(`missing source identity result ${expected.case_id}`);
    actualById.delete(expected.case_id);
    const mismatches: string[] = [];
    if (actual.actual_verdict !== expected.expected_verdict) {
      mismatches.push(
        `expected verdict ${expected.expected_verdict}, actual ${actual.actual_verdict}`,
      );
    }
    if (actual.actual_candidate_key !== expected.expected_candidate_key) {
      mismatches.push(
        `expected candidate ${expected.expected_candidate_key}, actual ${actual.actual_candidate_key}`,
      );
    }
    if (actual.actual_source_page_number !== expected.expected_source_page_number) {
      mismatches.push(
        `expected page ${expected.expected_source_page_number}, actual ${actual.actual_source_page_number}`,
      );
    }
    const expectedDecisionSource = expected.expected_program_reject
      ? "program_no_matching_source"
      : "content_model";
    if (actual.decision_source !== expectedDecisionSource) {
      mismatches.push(
        `expected decision source ${expectedDecisionSource}, actual ${actual.decision_source}`,
      );
    }
    const unmatchedSourceAccepted =
      expected.expected_program_reject &&
      actual.actual_verdict !== "not_answerable" &&
      actual.actual_verdict !== "judge_error";
    return {
      ...actual,
      expected_verdict: expected.expected_verdict,
      expected_candidate_key: expected.expected_candidate_key,
      expected_source_page_number: expected.expected_source_page_number,
      expected_program_reject: expected.expected_program_reject,
      expected_model_invoked: expected.expected_model_invoked,
      raw_override_present: expected.raw_override_present,
      mismatches,
      exact_passed: mismatches.length === 0,
      unmatched_source_accepted: unmatchedSourceAccepted,
    };
  });
  if (actualById.size !== 0) {
    throw new Error("source identity evaluation v4 returned unknown cases");
  }
  const exactCaseCount = cases.filter(({ exact_passed }) => exact_passed).length;
  const unmatchedSourceAcceptCount = cases.filter(
    ({ unmatched_source_accepted }) => unmatched_source_accepted,
  ).length;
  const judgeErrorCount = cases.filter(
    ({ actual_verdict }) => actual_verdict === "judge_error",
  ).length;
  const programRejectObservedCount = cases.filter(
    ({ decision_source }) => decision_source === "program_no_matching_source",
  ).length;
  const gates = {
    exactCaseCount:
      exactCaseCount >= dataset.acceptance_targets.exact_case_count_minimum,
    unmatchedSourceAcceptCount:
      unmatchedSourceAcceptCount <=
      dataset.acceptance_targets.unmatched_source_accept_count_maximum,
    judgeErrorCount:
      judgeErrorCount <= dataset.acceptance_targets.judge_error_count_maximum,
  };
  return {
    report_version: 4,
    dataset_id: dataset.dataset_id,
    dataset_role: dataset.dataset_role,
    production_accuracy_claim_allowed: false,
    case_count: cases.length,
    exact_case_count: exactCaseCount,
    expected_program_reject_case_count: dataset.cases.filter(
      ({ expected_program_reject }) => expected_program_reject,
    ).length,
    program_reject_observed_count: programRejectObservedCount,
    content_model_case_count: cases.filter(
      ({ decision_source }) => decision_source === "content_model",
    ).length,
    unmatched_source_accept_count: unmatchedSourceAcceptCount,
    judge_error_count: judgeErrorCount,
    gates,
    passed: Object.values(gates).every(Boolean),
    cases,
    interpretation_limits: dataset.interpretation_limits,
  };
}

export async function executeSourceIdentityUnseenEvaluationV4(input: {
  dataset: SourceIdentityUnseenV4Dataset;
  createMainChain(
    database: PGliteInterface,
    embedder: QueryEmbedder,
  ): Pick<
    WorkOrderMainChainV4,
    "versions" | "createConfirmedAnswerabilityJudge"
  >;
}) {
  const database = await openDatabase();
  try {
    const candidateIdByKey = await seedCandidates(
      database,
      input.dataset.candidates,
    );
    const candidateKeyById = new Map(
      [...candidateIdByKey.entries()].map(([key, id]) => [id, key]),
    );
    const fixtureByKey = new Map(
      input.dataset.candidates.map((item) => [item.candidate_key, item]),
    );
    const runtime = input.createMainChain(database, noRetrievalEmbedder);
    if (
      runtime.versions.answerabilityPrompt !==
        "answerability-v8-candidate-isolated" ||
      runtime.versions.sourceIdentityBinding !== "database-source-chain-v1" ||
      runtime.versions.sourceConstraint !== "confirmed-source-exact-v1"
    ) {
      throw new Error(
        "source identity evaluation v4 requires the formal confirmed-source main chain",
      );
    }

    const actualCases: ActualCase[] = [];
    let judgeModelId: string | undefined;
    for (const item of input.dataset.cases) {
      const startedAt = performance.now();
      try {
        const judge = runtime.createConfirmedAnswerabilityJudge({
          rawQuestion: item.raw_question,
          confirmedContentQuestion: item.confirmed_content_question,
          requestedSourceIdentity: {
            documentReference:
              item.requested_source_identity.document_reference,
            versionLabel: item.requested_source_identity.version_label,
            languageCode: item.requested_source_identity.language_code,
          },
        });
        judgeModelId ??= judge.modelId;
        const decision = await judge.judge({
          question: item.raw_question,
          candidates: item.candidate_keys.map((key) => {
            const fixture = fixtureByKey.get(key)!;
            return {
              id: candidateIdByKey.get(key)!,
              sectionTitle: fixture.section_title,
              sources: [
                { pageNumber: fixture.page_number, text: fixture.text },
              ],
            };
          }),
        });
        actualCases.push({
          case_id: item.case_id,
          actual_verdict: decision.verdict,
          actual_candidate_key:
            decision.candidateId === null
              ? null
              : candidateKeyById.get(decision.candidateId) ?? null,
          actual_source_page_number: decision.sourcePageNumber,
          actual_supporting_quote: decision.supportingQuote,
          decision_source:
            decision.reason === CONFIRMED_SOURCE_NO_MATCH_REASON
              ? "program_no_matching_source"
              : "content_model",
          reason: decision.reason,
          duration_ms:
            Math.round((performance.now() - startedAt) * 100) / 100,
        });
      } catch (caught) {
        actualCases.push({
          case_id: item.case_id,
          actual_verdict: "judge_error",
          actual_candidate_key: null,
          actual_source_page_number: null,
          actual_supporting_quote: null,
          decision_source: "judge_error",
          reason: caught instanceof Error ? caught.message : String(caught),
          duration_ms:
            Math.round((performance.now() - startedAt) * 100) / 100,
        });
      }
    }
    return {
      actualCases,
      report: {
        main_chain: runtime.versions,
        judge_model_id: judgeModelId,
        ...score(input.dataset, actualCases),
      },
    };
  } finally {
    await database.close();
  }
}
