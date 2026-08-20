import { buildSearchTerms, type SearchTermKind } from "./lexical-terms.ts";

export interface EvaluationDocument {
  id: string;
  text: string;
  sectionTitle?: string | null;
  faultCode?: string | null;
}

export interface RankingCaseResult {
  expectedId: string;
  rankedIds: string[];
}

export interface RankingMetrics {
  caseCount: number;
  hitAt1: number;
  hitAt3: number;
  meanReciprocalRank: number;
}

export interface RetrievalOutcomeCaseResult {
  expectedBehavior: "hit" | "abstain";
  expectedId: string | null;
  scopeClass: "in_scope" | "out_of_scope" | "unanswerable";
  rankedIds: string[];
  abstained: boolean;
}

export interface RetrievalOutcomeMetrics {
  caseCount: number;
  answerableCaseCount: number;
  abstainCaseCount: number;
  answerableHitAt1: number;
  answerableHitAt3: number;
  answerableMeanReciprocalRank: number;
  abstainAccuracy: number;
  scopeConflictAbstainAccuracy: number;
  unanswerableAbstainAccuracy: number;
  overallDecisionAccuracy: number;
}

const TERM_WEIGHTS: Record<SearchTermKind, number> = {
  fault_code: 8,
  ascii_token: 3,
  cjk_bigram: 1,
};

export function calculateRankingMetrics(
  results: RankingCaseResult[],
): RankingMetrics {
  if (results.length === 0) throw new Error("evaluation needs at least one case");

  let hitAt1Count = 0;
  let hitAt3Count = 0;
  let reciprocalRankTotal = 0;
  for (const result of results) {
    const rankIndex = result.rankedIds.indexOf(result.expectedId);
    if (rankIndex === 0) hitAt1Count += 1;
    if (rankIndex >= 0 && rankIndex < 3) hitAt3Count += 1;
    if (rankIndex >= 0) reciprocalRankTotal += 1 / (rankIndex + 1);
  }

  return {
    caseCount: results.length,
    hitAt1: hitAt1Count / results.length,
    hitAt3: hitAt3Count / results.length,
    meanReciprocalRank: reciprocalRankTotal / results.length,
  };
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function calculateRetrievalOutcomeMetrics(
  results: RetrievalOutcomeCaseResult[],
): RetrievalOutcomeMetrics {
  if (results.length === 0) throw new Error("evaluation needs at least one case");
  const answerable = results.filter((item) => item.expectedBehavior === "hit");
  const abstain = results.filter((item) => item.expectedBehavior === "abstain");
  const scopeConflicts = abstain.filter(
    (item) => item.scopeClass === "out_of_scope",
  );
  const unanswerable = abstain.filter(
    (item) => item.scopeClass === "unanswerable",
  );
  const answerableRanking =
    answerable.length === 0
      ? null
      : calculateRankingMetrics(
          answerable.map((item) => ({
            expectedId: item.expectedId!,
            rankedIds: item.abstained ? [] : item.rankedIds,
          })),
        );
  const correctlyAbstained = abstain.filter((item) => item.abstained).length;
  const correctDecisions = results.filter((item) =>
    item.expectedBehavior === "abstain"
      ? item.abstained
      : !item.abstained && item.rankedIds[0] === item.expectedId,
  ).length;

  return {
    caseCount: results.length,
    answerableCaseCount: answerable.length,
    abstainCaseCount: abstain.length,
    answerableHitAt1: answerableRanking?.hitAt1 ?? 0,
    answerableHitAt3: answerableRanking?.hitAt3 ?? 0,
    answerableMeanReciprocalRank:
      answerableRanking?.meanReciprocalRank ?? 0,
    abstainAccuracy: safeRate(correctlyAbstained, abstain.length),
    scopeConflictAbstainAccuracy: safeRate(
      scopeConflicts.filter((item) => item.abstained).length,
      scopeConflicts.length,
    ),
    unanswerableAbstainAccuracy: safeRate(
      unanswerable.filter((item) => item.abstained).length,
      unanswerable.length,
    ),
    overallDecisionAccuracy: safeRate(correctDecisions, results.length),
  };
}

export function rankDocumentsByKeyword(
  query: string,
  documents: EvaluationDocument[],
): Array<{ id: string; score: number }> {
  const queryTerms = new Set(
    buildSearchTerms({ text: query }).map(({ term }) => term),
  );

  return documents
    .map((document) => {
      const score = buildSearchTerms({
        text: document.text,
        sectionTitle: document.sectionTitle,
        faultCode: document.faultCode,
      }).reduce(
        (total, term) =>
          total + (queryTerms.has(term.term) ? TERM_WEIGHTS[term.kind] : 0),
        0,
      );
      return { id: document.id, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function rankDocumentsByVector(
  queryEmbedding: number[],
  documentEmbeddings: Array<{ id: string; embedding: number[] }>,
): Array<{ id: string; score: number }> {
  return documentEmbeddings
    .map(({ id, embedding }) => {
      if (embedding.length !== queryEmbedding.length) {
        throw new Error(`embedding dimensions do not match for ${id}`);
      }
      const score = queryEmbedding.reduce(
        (total, value, index) => total + value * embedding[index],
        0,
      );
      return { id, score };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function fuseRankedIds(
  keywordIds: string[],
  vectorIds: string[],
  rankConstant = 60,
): string[] {
  const scores = new Map<string, number>();
  for (const ranking of [keywordIds, vectorIds]) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rankConstant + index + 1));
    });
  }
  return [...scores]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || leftId.localeCompare(rightId),
    )
    .map(([id]) => id);
}
