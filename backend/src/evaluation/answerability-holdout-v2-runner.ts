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
import { evaluateAnswerabilityJudge } from "./answerability-judge-evaluation.ts";
import {
  loadAnswerabilityHoldoutV2,
  type AnswerabilityHoldoutV2,
} from "./answerability-holdout-v2-dataset.ts";
import type {
  AnswerabilityCandidate,
  QwenAnswerabilityJudge,
} from "./qwen-answerability-judge.ts";

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    fault_code?: string;
    section_title: string;
    sources: Array<{ pdf_page_number: number; excerpt: string }>;
  }>;
}

interface FreezeRecord {
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
  };
  acceptance_targets: AnswerabilityHoldoutV2["acceptance_targets"];
}

export type AnswerabilityCandidateRanker = (
  question: string,
  documents: readonly EvaluationDocument[],
) => Promise<Array<{ id: string; score: number }>>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function validateAnswerabilityHoldoutV2Freeze(input: {
  datasetRaw: string;
  manifestRaw: string;
  judgeImplementationRaw: string;
  preRunRaw: string;
}): FreezeRecord {
  const preRun = JSON.parse(input.preRunRaw) as FreezeRecord;
  if (
    preRun.status !== "frozen_before_first_model_run" ||
    preRun.dataset.sha256 !== sha256(input.datasetRaw) ||
    preRun.candidate_manifest.sha256 !== sha256(input.manifestRaw) ||
    preRun.strategy.judge_implementation_sha256 !==
      sha256(input.judgeImplementationRaw)
  ) {
    throw new Error(
      "answerability holdout v2 does not match the pre-run freeze record",
    );
  }
  return preRun;
}

function validateRanking(
  ranking: Array<{ id: string; score: number }>,
  candidatesById: ReadonlyMap<string, AnswerabilityCandidate>,
  candidateLimit: number,
) {
  if (ranking.length < candidateLimit) {
    throw new Error("answerability holdout v2 ranking has too few candidates");
  }
  const ids = ranking.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("answerability holdout v2 ranking has duplicate candidates");
  }
  for (const item of ranking) {
    if (!candidatesById.has(item.id) || !Number.isFinite(item.score)) {
      throw new Error("answerability holdout v2 ranking is invalid");
    }
  }
}

export async function runAnswerabilityHoldoutV2(options: {
  judge: QwenAnswerabilityJudge;
  rankCandidates?: AnswerabilityCandidateRanker;
  datasetPath?: string;
  candidateManifestPath?: string;
  preRunRecordPath?: string;
  judgeImplementationPath?: string;
  cacheDirectory?: string;
  localFilesOnly?: boolean;
  remoteHost?: string;
}) {
  const datasetPath =
    options.datasetPath ?? "data/evaluation/ohf-answerability-holdout-v2.json";
  const candidateManifestPath =
    options.candidateManifestPath ??
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
  const preRunRecordPath =
    options.preRunRecordPath ??
    "reports/ohf-answerability-holdout-v2-prerun.json";
  const judgeImplementationPath =
    options.judgeImplementationPath ??
    "src/evaluation/qwen-answerability-judge.ts";
  const cacheDirectory = options.cacheDirectory ?? "tmp/huggingface-cache";
  const [datasetRaw, manifestRaw, preRunRaw, judgeImplementationRaw] =
    await Promise.all([
      readFile(datasetPath, "utf8"),
      readFile(candidateManifestPath, "utf8"),
      readFile(preRunRecordPath, "utf8"),
      readFile(judgeImplementationPath, "utf8"),
    ]);
  const preRun = validateAnswerabilityHoldoutV2Freeze({
    datasetRaw,
    manifestRaw,
    judgeImplementationRaw,
    preRunRaw,
  });
  const dataset = await loadAnswerabilityHoldoutV2({
    datasetPath,
    candidateManifestPath,
  });
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  if (
    dataset.strategy.strategy_id !== preRun.strategy.strategy_id ||
    dataset.strategy.candidate_limit !== preRun.strategy.candidate_limit ||
    dataset.strategy.embedding_model_id !==
      preRun.strategy.embedding_model_id ||
    dataset.strategy.embedding_model_revision !==
      preRun.strategy.embedding_model_revision ||
    options.judge.modelId !== preRun.strategy.judge_model_id ||
    options.judge.promptVersion !== preRun.strategy.judge_prompt_version ||
    JSON.stringify(dataset.acceptance_targets) !==
      JSON.stringify(preRun.acceptance_targets)
  ) {
    throw new Error("answerability holdout v2 runtime does not match frozen strategy");
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
      throw new Error("answerability holdout v2 E5 model does not match freeze");
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
  const evaluatedCases = [];
  for (const item of dataset.cases) {
    const ranking = await rankCandidates(item.query, documents);
    validateRanking(ranking, candidatesById, dataset.strategy.candidate_limit);
    const candidateIds = ranking
      .slice(0, dataset.strategy.candidate_limit)
      .map(({ id }) => id);
    const candidates = candidateIds.map((id) => candidatesById.get(id)!);
    let decision = null;
    let error: string | undefined;
    try {
      decision = await options.judge.judge({
        question: item.query,
        candidates,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    evaluatedCases.push({
      caseId: item.case_id,
      query: item.query,
      expectedBehavior: item.expected_behavior,
      expectedCandidateId: item.expected_candidate_key,
      candidateIds,
      ranking,
      decision,
      ...(error === undefined ? {} : { error }),
    });
  }
  const evaluation = evaluateAnswerabilityJudge(
    evaluatedCases.map((item) => ({
      caseId: item.caseId,
      expectedBehavior: item.expectedBehavior,
      expectedCandidateId: item.expectedCandidateId,
      decision: item.decision,
      ...(item.error === undefined ? {} : { error: item.error }),
    })),
  );
  const judgeErrorCount = evaluation.cases.filter(
    ({ outcome }) => outcome === "judge_error",
  ).length;
  const targets = dataset.acceptance_targets;
  const gates = {
    answerableCorrectAcceptRate:
      evaluation.answerableCorrectAcceptRate >=
      targets.answerable_correct_accept_rate_minimum,
    unanswerableAbstainAccuracy:
      evaluation.unanswerableAbstainAccuracy >=
      targets.unanswerable_abstain_accuracy_minimum,
    acceptedPrecision:
      evaluation.acceptedPrecision >= targets.accepted_precision_minimum,
    judgeErrorCount: judgeErrorCount <= targets.judge_error_count_maximum,
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
    judgeImplementationSha256: sha256(judgeImplementationRaw),
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
        query: evaluatedCases[index].query,
        candidateIds: evaluatedCases[index].candidateIds,
        ranking: evaluatedCases[index].ranking,
      })),
    },
    judgeErrorCount,
    gates,
    passed: Object.values(gates).every(Boolean),
    interpretationLimits: [
      "题目由项目组编写，不代表真实工厂查询分布",
      "候选知识尚未获得ATV320领域工程师审核",
      "结果不能外推为生产维修答案准确率",
    ],
  };
}
