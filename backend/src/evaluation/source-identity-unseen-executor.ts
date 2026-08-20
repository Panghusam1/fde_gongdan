import { performance } from "node:perf_hooks";

import { PGlite, type PGliteInterface } from "@electric-sql/pglite";

import type { WorkOrderMainChain } from "../coordinator/work-order-main-chain.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";
import type { AnswerabilityVerdict } from "./qwen-answerability-judge.ts";
import type {
  SourceIdentityCandidateFixture,
  SourceIdentityUnseenCase,
  SourceIdentityUnseenDataset,
} from "./source-identity-unseen-dataset.ts";

export interface SourceIdentityUnseenActualCase {
  case_id: string;
  actual_verdict: AnswerabilityVerdict | "judge_error";
  actual_candidate_key: string | null;
  actual_source_page_number: number | null;
  actual_supporting_quote: string | null;
  reason: string;
  duration_ms: number;
}

export interface SourceIdentityUnseenCaseScore
  extends SourceIdentityUnseenActualCase {
  source_expectation: SourceIdentityUnseenCase["source_expectation"];
  expected_verdict: AnswerabilityVerdict;
  expected_candidate_key: string | null;
  expected_source_page_number: number | null;
  mismatches: string[];
  exact_passed: boolean;
  forged_source_accepted: boolean;
}

const evaluationEmbedder: QueryEmbedder = {
  modelId: "source-identity-evaluation-no-retrieval",
  modelRevision: "1",
  dimensions: 1,
  isNormalized: true,
  async embedQuery() {
    throw new Error("source identity evaluation must not run retrieval");
  },
};

async function openIdentityDatabase(): Promise<PGlite> {
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

async function seedCandidateIdentities(
  database: PGliteInterface,
  fixtures: readonly SourceIdentityCandidateFixture[],
): Promise<Map<string, string>> {
  const documentIds = new Map<string, number>();
  const versionIds = new Map<string, number>();
  const candidateIdByKey = new Map<string, string>();
  for (const fixture of fixtures) {
    let documentId = documentIds.get(fixture.document_reference);
    if (!documentId) {
      const inserted = await database.query<{ id: number }>(
        "insert into source_documents (document_reference) values ($1) returning id",
        [fixture.document_reference],
      );
      documentId = inserted.rows[0].id;
      documentIds.set(fixture.document_reference, documentId);
    }
    const versionKey = [
      documentId,
      fixture.version_label,
      fixture.language_code,
    ].join("|");
    let versionId = versionIds.get(versionKey);
    if (!versionId) {
      const inserted = await database.query<{ id: number }>(
        `insert into source_versions
          (source_document_id, version_label, language_code)
         values ($1, $2, $3)
         returning id`,
        [documentId, fixture.version_label, fixture.language_code],
      );
      versionId = inserted.rows[0].id;
      versionIds.set(versionKey, versionId);
    }
    const chunk = await database.query<{ id: number }>(
      "insert into knowledge_chunks (source_version_id) values ($1) returning id",
      [versionId],
    );
    const hit = await database.query<{ id: number }>(
      "insert into knowledge_search_hits (knowledge_chunk_id) values ($1) returning id",
      [chunk.rows[0].id],
    );
    candidateIdByKey.set(fixture.candidate_key, String(hit.rows[0].id));
  }
  return candidateIdByKey;
}

function scoreCases(
  dataset: SourceIdentityUnseenDataset,
  actualCases: readonly SourceIdentityUnseenActualCase[],
) {
  const actualById = new Map(actualCases.map((item) => [item.case_id, item]));
  const cases: SourceIdentityUnseenCaseScore[] = dataset.cases.map((expected) => {
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
    const forgedSourceAccepted =
      expected.source_expectation === "mismatch" &&
      actual.actual_verdict !== "not_answerable" &&
      actual.actual_verdict !== "judge_error";
    return {
      ...actual,
      source_expectation: expected.source_expectation,
      expected_verdict: expected.expected_verdict,
      expected_candidate_key: expected.expected_candidate_key,
      expected_source_page_number: expected.expected_source_page_number,
      mismatches,
      exact_passed: mismatches.length === 0,
      forged_source_accepted: forgedSourceAccepted,
    };
  });
  if (actualById.size !== 0) {
    throw new Error("source identity evaluation returned unknown cases");
  }
  const exactCaseCount = cases.filter(({ exact_passed }) => exact_passed).length;
  const forgedSourceAcceptCount = cases.filter(
    ({ forged_source_accepted }) => forged_source_accepted,
  ).length;
  const judgeErrorCount = cases.filter(
    ({ actual_verdict }) => actual_verdict === "judge_error",
  ).length;
  const gates = {
    exactCaseCount:
      exactCaseCount >= dataset.acceptance_targets.exact_case_count_minimum,
    forgedSourceAcceptCount:
      forgedSourceAcceptCount <=
      dataset.acceptance_targets.forged_source_accept_count_maximum,
    judgeErrorCount:
      judgeErrorCount <= dataset.acceptance_targets.judge_error_count_maximum,
  };
  return {
    report_version: 1,
    dataset_id: dataset.dataset_id,
    dataset_role: dataset.dataset_role,
    production_accuracy_claim_allowed: false,
    case_count: cases.length,
    exact_case_count: exactCaseCount,
    forged_source_case_count: dataset.cases.filter(
      ({ source_expectation }) => source_expectation === "mismatch",
    ).length,
    forged_source_accept_count: forgedSourceAcceptCount,
    judge_error_count: judgeErrorCount,
    gates,
    passed: Object.values(gates).every(Boolean),
    cases,
    interpretation_limits: dataset.interpretation_limits,
  };
}

export async function executeSourceIdentityUnseenEvaluation(input: {
  dataset: SourceIdentityUnseenDataset;
  createMainChain(
    database: PGliteInterface,
    embedder: QueryEmbedder,
  ): Pick<WorkOrderMainChain, "versions" | "answerabilityJudge">;
}) {
  const database = await openIdentityDatabase();
  try {
    const candidateIdByKey = await seedCandidateIdentities(
      database,
      input.dataset.candidates,
    );
    const candidateKeyById = new Map(
      [...candidateIdByKey.entries()].map(([key, id]) => [id, key]),
    );
    const fixtureByKey = new Map(
      input.dataset.candidates.map((fixture) => [fixture.candidate_key, fixture]),
    );
    const runtime = input.createMainChain(database, evaluationEmbedder);
    if (
      runtime.versions.answerabilityPrompt !== "answerability-v6-source-aware" ||
      runtime.versions.sourceIdentityBinding !== "database-source-chain-v1"
    ) {
      throw new Error("source identity evaluation requires the formal sixth-version main chain");
    }

    const actualCases: SourceIdentityUnseenActualCase[] = [];
    for (const item of input.dataset.cases) {
      const startedAt = performance.now();
      try {
        const decision = await runtime.answerabilityJudge.judge({
          question: item.question,
          candidates: item.candidate_keys.map((key) => {
            const fixture = fixtureByKey.get(key)!;
            return {
              id: candidateIdByKey.get(key)!,
              sectionTitle: fixture.section_title,
              sources: [{ pageNumber: fixture.page_number, text: fixture.text }],
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
          reason: decision.reason,
          duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        });
      } catch (caught) {
        actualCases.push({
          case_id: item.case_id,
          actual_verdict: "judge_error",
          actual_candidate_key: null,
          actual_source_page_number: null,
          actual_supporting_quote: null,
          reason: caught instanceof Error ? caught.message : String(caught),
          duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        });
      }
    }
    return {
      actualCases,
      report: {
        main_chain: runtime.versions,
        judge_model_id: runtime.answerabilityJudge.modelId,
        ...scoreCases(input.dataset, actualCases),
      },
    };
  } finally {
    await database.close();
  }
}
