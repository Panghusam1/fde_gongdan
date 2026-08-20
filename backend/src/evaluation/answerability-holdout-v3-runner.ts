import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createMultilingualE5SmallEmbedder,
  MULTILINGUAL_E5_SMALL_MODEL_FILE,
  MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
} from "../retrieval/multilingual-e5-small.ts";
import {
  rankDocumentsByVector,
  type EvaluationDocument,
} from "../retrieval/retrieval-evaluation.ts";
import {
  loadAnswerabilityHoldoutV3,
  type AnswerabilityHoldoutV3,
} from "./answerability-holdout-v3-dataset.ts";
import { evaluateThreeClassAnswerability } from "./answerability-three-class-evaluation.ts";
import type {
  AnswerabilityCandidate,
  AnswerabilityDecision,
  AnswerabilityJudgeInput,
} from "./qwen-answerability-judge.ts";

interface AnswerabilityHoldoutV3FreezeRecord {
  record_version: 1;
  status: string;
  dataset_role: string;
  dataset: { sha256: string };
  candidate_manifest: { sha256: string };
  strategy: {
    strategy_id: string;
    candidate_limit: number;
    embedding_model_id: string;
    embedding_model_revision: string;
    embedding_model_file_sha256: string;
    judge_model_id: string;
    judge_prompt_version: string;
    judge_implementation_sha256: string;
    evaluator_sha256: string;
    runner_sha256: string;
  };
  acceptance_targets: AnswerabilityHoldoutV3["acceptance_targets"];
}

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    fault_code?: string;
    section_title: string;
    sources: Array<{ pdf_page_number: number; excerpt: string }>;
  }>;
}

export type AnswerabilityV3CandidateRanker = (
  question: string,
  documents: readonly EvaluationDocument[],
) => Promise<Array<{ id: string; score: number }>>;

export interface AnswerabilityV3Judge {
  modelId: string;
  promptVersion: string;
  judge(input: AnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function validateAnswerabilityHoldoutV3Freeze(input: {
  datasetRaw: string;
  manifestRaw: string;
  judgeRaw: string;
  evaluatorRaw: string;
  runnerRaw: string;
  preRunRaw: string;
}): AnswerabilityHoldoutV3FreezeRecord {
  const record = JSON.parse(
    input.preRunRaw,
  ) as AnswerabilityHoldoutV3FreezeRecord;
  if (
    record.record_version !== 1 ||
    record.status !== "frozen_before_first_model_run" ||
    record.dataset_role !==
      "project_authored_unseen_holdout_not_production_data" ||
    record.dataset?.sha256 !== sha256(input.datasetRaw) ||
    record.candidate_manifest?.sha256 !== sha256(input.manifestRaw) ||
    record.strategy?.judge_implementation_sha256 !== sha256(input.judgeRaw) ||
    record.strategy?.evaluator_sha256 !== sha256(input.evaluatorRaw) ||
    record.strategy?.runner_sha256 !== sha256(input.runnerRaw)
  ) {
    throw new Error(
      "answerability holdout v3 does not match the pre-run freeze record",
    );
  }
  return record;
}

function validateRanking(
  ranking: Array<{ id: string; score: number }>,
  candidatesById: ReadonlyMap<string, AnswerabilityCandidate>,
  candidateLimit: number,
): void {
  if (ranking.length < candidateLimit) {
    throw new Error("answerability holdout v3 ranking has too few candidates");
  }
  const ids = ranking.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("answerability holdout v3 ranking has duplicate candidates");
  }
  if (
    ranking.some(
      ({ id, score }) => !candidatesById.has(id) || !Number.isFinite(score),
    )
  ) {
    throw new Error("answerability holdout v3 ranking is invalid");
  }
}

export async function runAnswerabilityHoldoutV3(options: {
  judge: AnswerabilityV3Judge;
  rankCandidates?: AnswerabilityV3CandidateRanker;
  datasetPath?: string;
  candidateManifestPath?: string;
  preRunRecordPath?: string;
  judgeImplementationPath?: string;
  evaluatorPath?: string;
  cacheDirectory?: string;
  localFilesOnly?: boolean;
  remoteHost?: string;
}) {
  const datasetPath =
    options.datasetPath ?? "data/evaluation/ohf-answerability-holdout-v3.json";
  const candidateManifestPath =
    options.candidateManifestPath ??
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
  const preRunRecordPath =
    options.preRunRecordPath ??
    "reports/ohf-answerability-holdout-v3-prerun.json";
  const judgeImplementationPath =
    options.judgeImplementationPath ??
    "src/evaluation/qwen-answerability-judge-v2.ts";
  const evaluatorPath =
    options.evaluatorPath ??
    "src/evaluation/answerability-three-class-evaluation.ts";
  const cacheDirectory = options.cacheDirectory ?? "tmp/huggingface-cache";
  const [datasetRaw, manifestRaw, preRunRaw, judgeRaw, evaluatorRaw] =
    await Promise.all([
      readFile(datasetPath, "utf8"),
      readFile(candidateManifestPath, "utf8"),
      readFile(preRunRecordPath, "utf8"),
      readFile(judgeImplementationPath, "utf8"),
      readFile(evaluatorPath, "utf8"),
    ]);
  const preRun = validateAnswerabilityHoldoutV3Freeze({
    datasetRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw: await readFile(
      "src/evaluation/answerability-holdout-v3-runner.ts",
      "utf8",
    ),
    preRunRaw,
  });
  const dataset = await loadAnswerabilityHoldoutV3({
    datasetPath,
    candidateManifestPath,
  });
  if (
    dataset.strategy.strategy_id !== preRun.strategy.strategy_id ||
    dataset.strategy.candidate_limit !== preRun.strategy.candidate_limit ||
    dataset.strategy.embedding_model_id !== preRun.strategy.embedding_model_id ||
    dataset.strategy.embedding_model_revision !==
      preRun.strategy.embedding_model_revision ||
    options.judge.modelId !== preRun.strategy.judge_model_id ||
    options.judge.promptVersion !== preRun.strategy.judge_prompt_version ||
    JSON.stringify(dataset.acceptance_targets) !==
      JSON.stringify(preRun.acceptance_targets)
  ) {
    throw new Error("answerability holdout v3 runtime does not match frozen strategy");
  }
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  if (manifest.review_status !== "unreviewed") {
    throw new Error("answerability holdout v3 expects unreviewed candidates");
  }
  const candidatesById = new Map<string, AnswerabilityCandidate>(
    manifest.candidates.map((candidate) => [
      candidate.candidate_key,
      {
        id: candidate.candidate_key,
        sectionTitle: candidate.section_title,
        sources: candidate.sources.map((source) => ({
          pageNumber: source.pdf_page_number,
          text: source.excerpt,
        })),
      },
    ]),
  );
  const documents: EvaluationDocument[] = manifest.candidates.map(
    (candidate) => ({
      id: candidate.candidate_key,
      faultCode: candidate.fault_code,
      sectionTitle: candidate.section_title,
      text: candidate.sources.map(({ excerpt }) => excerpt).join("\n"),
    }),
  );
  let rankingModel: Record<string, unknown> = { kind: "injected_test_ranker" };
  let rankCandidates = options.rankCandidates;
  if (!rankCandidates) {
    const embedder = await createMultilingualE5SmallEmbedder({
      cacheDirectory,
      localFilesOnly: options.localFilesOnly ?? false,
      remoteHost: options.remoteHost,
    });
    if (
      embedder.modelId !== preRun.strategy.embedding_model_id ||
      embedder.modelRevision !== preRun.strategy.embedding_model_revision ||
      preRun.strategy.embedding_model_file_sha256 !==
        MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256
    ) {
      throw new Error("answerability holdout v3 E5 model does not match freeze");
    }
    const modelPath = join(
      cacheDirectory,
      embedder.modelId,
      embedder.modelRevision,
      MULTILINGUAL_E5_SMALL_MODEL_FILE,
    );
    const localModelSha256 = await sha256File(modelPath);
    if (localModelSha256 !== MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256) {
      throw new Error("cached E5 model SHA-256 does not match the frozen file");
    }
    const documentEmbeddings = [];
    for (const document of documents) {
      documentEmbeddings.push({
        id: document.id,
        embedding: await embedder.embedPassage(
          [document.sectionTitle, document.text].filter(Boolean).join("\n"),
        ),
      });
    }
    rankCandidates = async (question) =>
      rankDocumentsByVector(
        await embedder.embedQuery(question),
        documentEmbeddings,
      );
    rankingModel = {
      kind: "multilingual_e5_small",
      modelId: embedder.modelId,
      modelRevision: embedder.modelRevision,
      dimensions: embedder.dimensions,
      normalized: embedder.isNormalized,
      modelFileSha256: localModelSha256,
    };
  }

  const startedAt = performance.now();
  const actualCases = [];
  for (const item of dataset.cases) {
    const ranking = await rankCandidates(item.query, documents);
    validateRanking(ranking, candidatesById, dataset.strategy.candidate_limit);
    const candidateIds = ranking
      .slice(0, dataset.strategy.candidate_limit)
      .map(({ id }) => id);
    const candidates = candidateIds.map((id) => candidatesById.get(id)!);
    let decision: AnswerabilityDecision | null = null;
    let error: string | undefined;
    try {
      decision = await options.judge.judge({
        question: item.query,
        candidates,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    actualCases.push({
      caseId: item.case_id,
      query: item.query,
      expectedVerdict: item.expected_verdict,
      expectedCandidateId: item.expected_candidate_key,
      candidateIds,
      ranking,
      decision,
      ...(error === undefined ? {} : { error }),
    });
  }
  const evaluation = evaluateThreeClassAnswerability(
    actualCases.map((item) => ({
      caseId: item.caseId,
      expectedVerdict: item.expectedVerdict,
      expectedCandidateId: item.expectedCandidateId,
      decision: item.decision,
      ...(item.error === undefined ? {} : { error: item.error }),
    })),
  );
  const targets = dataset.acceptance_targets;
  const gates = {
    overallExactAccuracy:
      evaluation.overallExactAccuracy >= targets.overall_exact_accuracy_minimum,
    directlyAnswerableAccuracy:
      evaluation.perClassAccuracy.directly_answerable >=
      targets.per_class_accuracy_minimum,
    partiallyRelatedAccuracy:
      evaluation.perClassAccuracy.partially_related >=
      targets.per_class_accuracy_minimum,
    notAnswerableAccuracy:
      evaluation.perClassAccuracy.not_answerable >=
      targets.per_class_accuracy_minimum,
    unsafeDirectAcceptCount:
      evaluation.unsafeDirectAcceptCount <=
      targets.unsafe_direct_accept_count_maximum,
    judgeErrorCount:
      evaluation.judgeErrorCount <= targets.judge_error_count_maximum,
  };
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    evaluationOnly: true,
    datasetRole: "project_authored_unseen_holdout_first_run" as const,
    productionAccuracyClaimAllowed: false,
    candidateLimit: dataset.strategy.candidate_limit,
    elapsedMilliseconds: performance.now() - startedAt,
    dataset: { id: dataset.dataset_id, sha256: sha256(datasetRaw) },
    candidateManifestSha256: sha256(manifestRaw),
    preRunRecordSha256: sha256(preRunRaw),
    judgeImplementationSha256: sha256(judgeRaw),
    evaluatorSha256: sha256(evaluatorRaw),
    rankingModel,
    judge: {
      modelId: options.judge.modelId,
      promptVersion: options.judge.promptVersion,
    },
    acceptanceTargets: targets,
    evaluation: {
      ...evaluation,
      cases: evaluation.cases.map((result, index) => ({
        ...result,
        query: actualCases[index].query,
        candidateIds: actualCases[index].candidateIds,
        ranking: actualCases[index].ranking,
        decision: actualCases[index].decision,
        ...(actualCases[index].error === undefined
          ? {}
          : { error: actualCases[index].error }),
      })),
    },
    gates,
    passed: Object.values(gates).every(Boolean),
    interpretationLimits: dataset.interpretation_limits,
  };
}
