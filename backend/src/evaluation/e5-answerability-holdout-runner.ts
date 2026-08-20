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
import { evaluateAnswerabilityThreshold } from "./answerability-evaluation.ts";
import { loadAnswerabilityHoldoutDataset } from "./answerability-holdout-dataset.ts";

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    fault_code?: string;
    section_title: string;
    sources: Array<{ excerpt: string }>;
  }>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runE5AnswerabilityHoldout(options?: {
  datasetPath?: string;
  developmentDatasetPath?: string;
  candidateManifestPath?: string;
  preRunRecordPath?: string;
  cacheDirectory?: string;
  localFilesOnly?: boolean;
  remoteHost?: string;
}) {
  const datasetPath =
    options?.datasetPath ??
    "data/evaluation/ohf-answerability-holdout-v1.json";
  const developmentDatasetPath =
    options?.developmentDatasetPath ??
    "data/evaluation/ohf-retrieval-cases-v2.json";
  const candidateManifestPath =
    options?.candidateManifestPath ??
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
  const preRunRecordPath =
    options?.preRunRecordPath ??
    "reports/ohf-answerability-holdout-v1-prerun.json";
  const cacheDirectory = options?.cacheDirectory ?? "tmp/huggingface-cache";
  const [datasetRaw, developmentRaw, manifestRaw, preRunRaw] =
    await Promise.all([
      readFile(datasetPath, "utf8"),
      readFile(developmentDatasetPath, "utf8"),
      readFile(candidateManifestPath, "utf8"),
      readFile(preRunRecordPath, "utf8"),
    ]);
  const dataset = await loadAnswerabilityHoldoutDataset({
    datasetPath,
    developmentDatasetPath,
    candidateManifestPath,
  });
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  const preRun = JSON.parse(preRunRaw) as {
    status: string;
    dataset: { sha256: string };
    developmentDataset: { sha256: string };
    candidateManifestSha256: string;
    thresholdPolicy: { vectorSimilarityMinimum: number };
  };
  const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  if (
    preRun.status !== "frozen_before_first_model_run" ||
    preRun.dataset.sha256 !== sha256(datasetRaw) ||
    preRun.developmentDataset.sha256 !== sha256(developmentRaw) ||
    preRun.candidateManifestSha256 !== sha256(manifestRaw) ||
    preRun.thresholdPolicy.vectorSimilarityMinimum !==
      dataset.threshold_policy.vector_similarity_minimum
  ) {
    throw new Error("answerability holdout no longer matches the pre-run freeze record");
  }
  if (manifest.review_status !== "unreviewed") {
    throw new Error("answerability evaluation expects unreviewed candidates");
  }

  const documents: EvaluationDocument[] = manifest.candidates.map(
    (candidate) => ({
      id: candidate.candidate_key,
      faultCode: candidate.fault_code,
      sectionTitle: candidate.section_title,
      text: candidate.sources.map(({ excerpt }) => excerpt).join("\n"),
    }),
  );
  const embedder = await createMultilingualE5SmallEmbedder({
    cacheDirectory,
    localFilesOnly: options?.localFilesOnly ?? false,
    remoteHost: options?.remoteHost,
  });
  const startedAt = performance.now();
  const documentEmbeddings = [];
  for (const document of documents) {
    documentEmbeddings.push({
      id: document.id,
      embedding: await embedder.embedPassage(
        [document.sectionTitle, document.text].filter(Boolean).join("\n"),
      ),
    });
  }
  const rankedCases = [];
  for (const item of dataset.cases) {
    rankedCases.push({
      caseId: item.case_id,
      query: item.query,
      expectedBehavior: item.expected_behavior,
      expectedCandidateId: item.expected_candidate_key,
      ranking: rankDocumentsByVector(
        await embedder.embedQuery(item.query),
        documentEmbeddings,
      ),
    });
  }
  const evaluation = evaluateAnswerabilityThreshold({
    threshold: dataset.threshold_policy.vector_similarity_minimum,
    cases: rankedCases,
  });
  const elapsedMilliseconds = performance.now() - startedAt;
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
  };
  const modelPath = join(
    cacheDirectory,
    embedder.modelId,
    embedder.modelRevision,
    MULTILINGUAL_E5_SMALL_MODEL_FILE,
  );
  const localModelSha256 = await sha256File(modelPath);
  if (localModelSha256 !== MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256) {
    throw new Error("cached model SHA-256 does not match the pinned official file");
  }

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    evaluationOnly: true,
    knowledgeReviewStatus: manifest.review_status,
    dataset: {
      id: dataset.dataset_id,
      sha256: sha256(datasetRaw),
      frozenBeforeFirstModelRun: dataset.frozen_before_first_model_run,
    },
    preRunRecordSha256: sha256(preRunRaw),
    developmentDatasetSha256: sha256(developmentRaw),
    candidateManifestSha256: sha256(manifestRaw),
    thresholdPolicy: dataset.threshold_policy,
    acceptanceTargets: targets,
    model: {
      id: embedder.modelId,
      revision: embedder.modelRevision,
      dimensions: embedder.dimensions,
      poolingMethod: embedder.poolingMethod,
      normalized: embedder.isNormalized,
      officialSha256: MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
      localSha256: localModelSha256,
    },
    elapsedMilliseconds,
    evaluation: {
      ...evaluation,
      cases: evaluation.cases.map((result, index) => ({
        ...result,
        query: rankedCases[index].query,
        ranking: rankedCases[index].ranking,
      })),
    },
    gates,
    passed: Object.values(gates).every(Boolean),
  };
}
