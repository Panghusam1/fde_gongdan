export type AnswerabilityOutcome =
  | "correct_accept"
  | "wrong_accept"
  | "false_abstain"
  | "correct_abstain"
  | "false_accept";

export interface AnswerabilityEvaluationCaseInput {
  caseId: string;
  expectedBehavior: "hit" | "abstain";
  expectedCandidateId: string | null;
  ranking: Array<{ id: string; score: number }>;
}

export interface AnswerabilityEvaluationResult {
  threshold: number;
  caseCount: number;
  answerableCaseCount: number;
  unanswerableCaseCount: number;
  answerableCorrectAcceptRate: number;
  answerableCoverage: number;
  unanswerableAbstainAccuracy: number;
  acceptedPrecision: number;
  overallDecisionAccuracy: number;
  cases: Array<{
    caseId: string;
    expectedBehavior: "hit" | "abstain";
    expectedCandidateId: string | null;
    topCandidateId: string | null;
    topScore: number | null;
    abstained: boolean;
    outcome: AnswerabilityOutcome;
  }>;
}

const safeRate = (numerator: number, denominator: number) =>
  denominator === 0 ? 0 : numerator / denominator;

export function evaluateAnswerabilityThreshold(input: {
  threshold: number;
  cases: AnswerabilityEvaluationCaseInput[];
}): AnswerabilityEvaluationResult {
  if (input.threshold < 0 || input.threshold > 1) {
    throw new Error("answerability threshold must be from zero to one");
  }
  if (input.cases.length === 0) {
    throw new Error("answerability evaluation needs at least one case");
  }
  const cases = input.cases.map((item) => {
    const top = item.ranking[0] ?? null;
    const abstained = top === null || top.score < input.threshold;
    let outcome: AnswerabilityOutcome;
    if (item.expectedBehavior === "hit") {
      outcome = abstained
        ? "false_abstain"
        : top!.id === item.expectedCandidateId
          ? "correct_accept"
          : "wrong_accept";
    } else {
      outcome = abstained ? "correct_abstain" : "false_accept";
    }
    return {
      caseId: item.caseId,
      expectedBehavior: item.expectedBehavior,
      expectedCandidateId: item.expectedCandidateId,
      topCandidateId: top?.id ?? null,
      topScore: top?.score ?? null,
      abstained,
      outcome,
    };
  });
  const answerable = cases.filter((item) => item.expectedBehavior === "hit");
  const unanswerable = cases.filter(
    (item) => item.expectedBehavior === "abstain",
  );
  const accepted = cases.filter((item) => !item.abstained);
  const correctAccepts = cases.filter(
    (item) => item.outcome === "correct_accept",
  ).length;
  const correctAbstains = cases.filter(
    (item) => item.outcome === "correct_abstain",
  ).length;

  return {
    threshold: input.threshold,
    caseCount: cases.length,
    answerableCaseCount: answerable.length,
    unanswerableCaseCount: unanswerable.length,
    answerableCorrectAcceptRate: safeRate(correctAccepts, answerable.length),
    answerableCoverage: safeRate(
      answerable.filter((item) => !item.abstained).length,
      answerable.length,
    ),
    unanswerableAbstainAccuracy: safeRate(
      correctAbstains,
      unanswerable.length,
    ),
    acceptedPrecision: safeRate(correctAccepts, accepted.length),
    overallDecisionAccuracy: safeRate(
      correctAccepts + correctAbstains,
      cases.length,
    ),
    cases,
  };
}
