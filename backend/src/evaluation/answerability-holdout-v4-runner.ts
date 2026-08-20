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
import { evaluateAdjudicatedAnswerability } from "./answerability-adjudicated-evaluation.ts";
import {
  loadAnswerabilityHoldoutV4,
  type AnswerabilityHoldoutV4,
} from "./answerability-holdout-v4-dataset.ts";
import type {
  AnswerabilityCandidate,
  AnswerabilityDecision,
  AnswerabilityJudgeInput,
} from "./qwen-answerability-judge.ts";

interface AnswerabilityHoldoutV4FreezeRecord {
  record_version: 1;
  status: "frozen_before_first_model_run";
  dataset_role: "project_authored_unseen_holdout_not_production_data";
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
  acceptance_targets: AnswerabilityHoldoutV4["acceptance_targets"];
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

export type AnswerabilityV4CandidateRanker = (
  question: string,
  documents: readonly EvaluationDocument[],
) => Promise<Array<{ id: string; score: number }>>;

export interface AnswerabilityV4Judge {
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

export function validateAnswerabilityHoldoutV4Freeze(input: {
  datasetRaw: string;
  manifestRaw: string;
  judgeRaw: string;
  evaluatorRaw: string;
  runnerRaw: string;
  preRunRaw: string;
}): AnswerabilityHoldoutV4FreezeRecord {
  const record = JSON.parse(
    input.preRunRaw,
  ) as AnswerabilityHoldoutV4FreezeRecord;
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
      "answerability holdout v4 does not match the pre-run freeze record",
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
    throw new Error("answerability holdout v4 ranking has too few candidates");
  }
  const ids = ranking.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("answerability holdout v4 ranking has duplicate candidates");
  }
  if (
    ranking.some(
      ({ id, score }) => !candidatesById.has(id) || !Number.isFinite(score),
    )
  ) {
    throw new Error("answerability holdout v4 ranking is invalid");
  }
}

export async function runAnswerabilityHoldoutV4(options: {
  judge: AnswerabilityV4Judge;
  rankCandidates?: AnswerabilityV4CandidateRanker;
  datasetPath?: string;
  candidateManifestPath?: string;
  preRunRecordPath?: string;
  judgeImplementationPath?: string;
  evaluatorPath?: string;
  runnerPath?: string;
  cacheDirectory?: string;
  localFilesOnly?: boolean;
  remoteHost?: string;
}) {
  const paths = {
    dataset:
      options.datasetPath ??
      "data/evaluation/ohf-answerability-holdout-v4.json",
    manifest:
      options.candidateManifestPath ??
      "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
    preRun:
      options.preRunRecordPath ??
      "reports/ohf-answerability-holdout-v4-prerun.json",
    judge:
      options.judgeImplementationPath ??
      "src/evaluation/qwen-answerability-judge-v5.ts",
    evaluator:
      options.evaluatorPath ??
      "src/evaluation/answerability-adjudicated-evaluation.ts",
    runner:
      options.runnerPath ??
      "src/evaluation/answerability-holdout-v4-runner.ts",
  };
  const [datasetRaw, manifestRaw, preRunRaw, judgeRaw, evaluatorRaw, runnerRaw] =
    await Promise.all(
      Object.values(paths).map((path) => readFile(path, "utf8")),
    );
  const preRun = validateAnswerabilityHoldoutV4Freeze({
    datasetRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    preRunRaw,
  });
  const dataset = await loadAnswerabilityHoldoutV4({
    datasetPath: paths.dataset,
    candidateManifestPath: paths.manifest,
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
    throw new Error("answerability holdout v4 runtime does not match freeze");
  }
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  if (manifest.review_status !== "unreviewed") {
    throw new Error("answerability holdout v4 expects unreviewed candidates");
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
  const cacheDirectory = options.cacheDirectory ?? "tmp/huggingface-cache";
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
      throw new Error("answerability holdout v4 E5 model does not match freeze");
    }
    const modelPath = join(
      cacheDirectory,
      embedder.modelId,
      embedder.modelRevision,
      MULTILINGUAL_E5_SMALL_MODEL_FILE,
    );
    const modelFileSha256 = await sha256File(modelPath);
    if (modelFileSha256 !== MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256) {
      throw new Error("answerability holdout v4 E5 file does not match freeze");
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
      modelFileSha256,
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
    let decision: AnswerabilityDecision | null = null;
    let error: string | undefined;
    try {
      decision = await options.judge.judge({
        question: item.query,
        candidates: candidateIds.map((id) => candidatesById.get(id)!),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    actualCases.push({
      item,
      candidateIds,
      ranking,
      decision,
      ...(error === undefined ? {} : { error }),
    });
  }
  const evaluation = evaluateAdjudicatedAnswerability(
    actualCases.map(({ item, decision, error }) => ({
      caseId: item.case_id,
      expectedVerdict: item.expected_verdict,
      originalExpectedCandidateId: item.primary_candidate_key,
      acceptableCandidateIds:
        item.expected_verdict === "not_answerable"
          ? null
          : item.acceptable_evidence.map(({ candidate_key }) => candidate_key),
      decision,
      ...(error === undefined ? {} : { error }),
    })),
  );
  const targets = dataset.acceptance_targets;
  const gates = {
    overallVerdictAccuracy:
      evaluation.overallVerdictAccuracy >=
      targets.overall_verdict_accuracy_minimum,
    directlyAnswerableVerdictAccuracy:
      evaluation.perClassVerdictAccuracy.directly_answerable >=
      targets.per_class_verdict_accuracy_minimum,
    partiallyRelatedVerdictAccuracy:
      evaluation.perClassVerdictAccuracy.partially_related >=
      targets.per_class_verdict_accuracy_minimum,
    notAnswerableVerdictAccuracy:
      evaluation.perClassVerdictAccuracy.not_answerable >=
      targets.per_class_verdict_accuracy_minimum,
    overallAdjudicatedExactAccuracy:
      evaluation.overallAdjudicatedExactAccuracy >=
      targets.overall_adjudicated_exact_accuracy_minimum,
    directlyAnswerableAdjudicatedExactAccuracy:
      evaluation.perClassAdjudicatedExactAccuracy.directly_answerable >=
      targets.per_class_adjudicated_exact_accuracy_minimum,
    partiallyRelatedAdjudicatedExactAccuracy:
      evaluation.perClassAdjudicatedExactAccuracy.partially_related >=
      targets.per_class_adjudicated_exact_accuracy_minimum,
    notAnswerableAdjudicatedExactAccuracy:
      evaluation.perClassAdjudicatedExactAccuracy.not_answerable >=
      targets.per_class_adjudicated_exact_accuracy_minimum,
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
    runnerSha256: sha256(runnerRaw),
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
        query: actualCases[index].item.query,
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
