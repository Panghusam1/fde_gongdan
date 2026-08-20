import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { evaluateAnswerabilityJudge } from "./answerability-judge-evaluation.ts";
import type {
  AnswerabilityCandidate,
  QwenAnswerabilityJudge,
} from "./qwen-answerability-judge.ts";

interface HoldoutDataset {
  dataset_id: string;
  cases: Array<{
    case_id: string;
    query: string;
    expected_behavior: "hit" | "abstain";
    expected_candidate_key: string | null;
  }>;
}

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    section_title: string;
    sources: Array<{ pdf_page_number: number; excerpt: string }>;
  }>;
}

interface E5BaselineReport {
  dataset: { id: string; sha256: string };
  candidateManifestSha256: string;
  evaluation: {
    answerableCorrectAcceptRate: number;
    unanswerableAbstainAccuracy: number;
    acceptedPrecision: number;
    cases: Array<{
      caseId: string;
      query: string;
      expectedBehavior: "hit" | "abstain";
      expectedCandidateId: string | null;
      ranking: Array<{ id: string; score: number }>;
    }>;
  };
}

const regressionTargets = {
  answerableCorrectAcceptRateMinimum: 0.9,
  unanswerableAbstainAccuracyMinimum: 1,
  acceptedPrecisionMinimum: 0.9,
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function runAnswerabilityJudgeRegression(options: {
  judge: QwenAnswerabilityJudge;
  datasetPath?: string;
  candidateManifestPath?: string;
  e5BaselineReportPath?: string;
}) {
  const datasetPath =
    options.datasetPath ?? "data/evaluation/ohf-answerability-holdout-v1.json";
  const candidateManifestPath =
    options.candidateManifestPath ??
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
  const e5BaselineReportPath =
    options.e5BaselineReportPath ??
    "reports/ohf-answerability-holdout-v1-result.json";
  const [datasetRaw, manifestRaw, baselineRaw] = await Promise.all([
    readFile(datasetPath, "utf8"),
    readFile(candidateManifestPath, "utf8"),
    readFile(e5BaselineReportPath, "utf8"),
  ]);
  const dataset = JSON.parse(datasetRaw) as HoldoutDataset;
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  const baseline = JSON.parse(baselineRaw) as E5BaselineReport;
  if (
    baseline.dataset.id !== dataset.dataset_id ||
    baseline.dataset.sha256 !== sha256(datasetRaw) ||
    baseline.candidateManifestSha256 !== sha256(manifestRaw)
  ) {
    throw new Error("answerability regression inputs do not match the E5 baseline");
  }
  if (manifest.review_status !== "unreviewed") {
    throw new Error("answerability regression expects unreviewed candidate data");
  }
  if (dataset.cases.length !== baseline.evaluation.cases.length) {
    throw new Error("answerability regression baseline case count changed");
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
  const datasetById = new Map(dataset.cases.map((item) => [item.case_id, item]));
  const candidateLimit = 5;
  const startedAt = performance.now();
  const evaluatedCases = [];
  for (const baselineCase of baseline.evaluation.cases) {
    const expected = datasetById.get(baselineCase.caseId);
    if (
      !expected ||
      expected.query !== baselineCase.query ||
      expected.expected_behavior !== baselineCase.expectedBehavior ||
      expected.expected_candidate_key !== baselineCase.expectedCandidateId
    ) {
      throw new Error(
        `answerability regression case ${baselineCase.caseId} no longer matches the frozen dataset`,
      );
    }
    const candidateIds = baselineCase.ranking
      .slice(0, candidateLimit)
      .map(({ id }) => id);
    const candidates = candidateIds.map((id) => {
      const candidate = candidatesById.get(id);
      if (!candidate) {
        throw new Error(
          `answerability regression ranking references unknown candidate ${id}`,
        );
      }
      return candidate;
    });
    let decision = null;
    let error: string | undefined;
    try {
      decision = await options.judge.judge({
        question: baselineCase.query,
        candidates,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    evaluatedCases.push({
      caseId: baselineCase.caseId,
      query: baselineCase.query,
      expectedBehavior: baselineCase.expectedBehavior,
      expectedCandidateId: baselineCase.expectedCandidateId,
      candidateIds,
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
  const gates = {
    answerableCorrectAcceptRate:
      evaluation.answerableCorrectAcceptRate >=
      regressionTargets.answerableCorrectAcceptRateMinimum,
    unanswerableAbstainAccuracy:
      evaluation.unanswerableAbstainAccuracy >=
      regressionTargets.unanswerableAbstainAccuracyMinimum,
    acceptedPrecision:
      evaluation.acceptedPrecision >=
      regressionTargets.acceptedPrecisionMinimum,
  };

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    evaluationOnly: true,
    datasetRole: "seen_regression_after_failed_holdout" as const,
    productionAccuracyClaimAllowed: false,
    candidateLimit,
    elapsedMilliseconds: performance.now() - startedAt,
    dataset: { id: dataset.dataset_id, sha256: sha256(datasetRaw) },
    candidateManifestSha256: sha256(manifestRaw),
    e5BaselineReportSha256: sha256(baselineRaw),
    judge: {
      modelId: options.judge.modelId,
      promptVersion: options.judge.promptVersion,
    },
    regressionTargets,
    baseline: {
      strategy: "e5_top1_similarity_threshold_0.86",
      answerableCorrectAcceptRate:
        baseline.evaluation.answerableCorrectAcceptRate,
      unanswerableAbstainAccuracy:
        baseline.evaluation.unanswerableAbstainAccuracy,
      acceptedPrecision: baseline.evaluation.acceptedPrecision,
    },
    evaluation: {
      ...evaluation,
      cases: evaluation.cases.map((result, index) => ({
        ...result,
        query: evaluatedCases[index].query,
        candidateIds: evaluatedCases[index].candidateIds,
      })),
    },
    gates,
    passedRegressionTargets: Object.values(gates).every(Boolean),
  };
}
