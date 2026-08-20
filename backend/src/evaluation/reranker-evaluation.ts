import { performance } from "node:perf_hooks";

import { calculateRankingMetrics } from "../retrieval/retrieval-evaluation.ts";

interface Reranker {
  modelId: string;
  rerank(
    query: string,
    documents: string[],
  ): Promise<Array<{ index: number; relevanceScore: number }>>;
}

export interface RerankerEvaluationCase {
  caseId: string;
  query: string;
  expectedId: string | null;
  candidateIds: string[];
}

export interface RerankerEvaluationReport {
  modelId: string;
  caseCount: number;
  answerableCaseCount: number;
  validOutputRate: number;
  answerableHitAt1: number;
  answerableHitAt3: number;
  answerableMeanReciprocalRank: number;
  averageLatencyMilliseconds: number;
  p95LatencyMilliseconds: number;
  cases: Array<{
    caseId: string;
    expectedId: string | null;
    candidateIds: string[];
    rankedIds: string[];
    scores: Array<{ id: string; relevanceScore: number }>;
    validOutput: boolean;
    latencyMilliseconds: number;
    error: string | null;
  }>;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export async function evaluateReranker(input: {
  reranker: Reranker;
  documents: ReadonlyMap<string, string>;
  cases: RerankerEvaluationCase[];
}): Promise<RerankerEvaluationReport> {
  if (input.cases.length === 0) throw new Error("reranker evaluation needs cases");
  const results: RerankerEvaluationReport["cases"] = [];
  for (const item of input.cases) {
    const documents = item.candidateIds.map((id) => {
      const text = input.documents.get(id);
      if (!text) throw new Error(`reranker evaluation document is missing: ${id}`);
      return text;
    });
    const startedAt = performance.now();
    try {
      const ranking = await input.reranker.rerank(item.query, documents);
      const scores = ranking.map((result) => ({
        id: item.candidateIds[result.index],
        relevanceScore: result.relevanceScore,
      }));
      results.push({
        caseId: item.caseId,
        expectedId: item.expectedId,
        candidateIds: item.candidateIds,
        rankedIds: scores.map(({ id }) => id),
        scores,
        validOutput: true,
        latencyMilliseconds: performance.now() - startedAt,
        error: null,
      });
    } catch (error) {
      results.push({
        caseId: item.caseId,
        expectedId: item.expectedId,
        candidateIds: item.candidateIds,
        rankedIds: [],
        scores: [],
        validOutput: false,
        latencyMilliseconds: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const answerable = results.filter((item) => item.expectedId !== null);
  const rankingMetrics = calculateRankingMetrics(
    answerable.map((item) => ({
      expectedId: item.expectedId!,
      rankedIds: item.rankedIds,
    })),
  );
  const latencies = results.map((item) => item.latencyMilliseconds);
  return {
    modelId: input.reranker.modelId,
    caseCount: results.length,
    answerableCaseCount: answerable.length,
    validOutputRate: rate(
      results.filter((item) => item.validOutput).length,
      results.length,
    ),
    answerableHitAt1: rankingMetrics.hitAt1,
    answerableHitAt3: rankingMetrics.hitAt3,
    answerableMeanReciprocalRank: rankingMetrics.meanReciprocalRank,
    averageLatencyMilliseconds:
      latencies.reduce((total, value) => total + value, 0) / latencies.length,
    p95LatencyMilliseconds: p95(latencies),
    cases: results,
  };
}

