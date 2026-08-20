export const MINIMUM_KEYWORD_TOP_SCORE = 3;
export const MINIMUM_KEYWORD_LEAD = 2;

export function isKeywordRankingConfident(
  descendingScores: number[],
  minimumTopScore = MINIMUM_KEYWORD_TOP_SCORE,
  minimumLead = MINIMUM_KEYWORD_LEAD,
): boolean {
  const topScore = descendingScores[0];
  if (!Number.isFinite(topScore) || topScore < minimumTopScore) return false;

  const secondScore = descendingScores[1];
  return secondScore === undefined || topScore - secondScore >= minimumLead;
}
