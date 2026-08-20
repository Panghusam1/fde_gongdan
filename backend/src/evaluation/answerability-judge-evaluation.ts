import type { AnswerabilityDecision } from "./qwen-answerability-judge.ts";

export type AnswerabilityJudgeOutcome =
  | "correct_accept"
  | "wrong_accept"
  | "false_abstain"
  | "correct_abstain"
  | "false_accept"
  | "judge_error";

export interface AnswerabilityJudgeEvaluationCase {
  caseId: string;
  expectedBehavior: "hit" | "abstain";
  expectedCandidateId: string | null;
  decision: AnswerabilityDecision | null;
  error?: string;
}

const safeRate = (numerator: number, denominator: number) =>
  denominator === 0 ? 0 : numerator / denominator;

export function evaluateAnswerabilityJudge(
  input: AnswerabilityJudgeEvaluationCase[],
) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("answerability judge evaluation needs at least one case");
  }
  const caseIds = input.map(({ caseId }) => caseId.trim());
  if (caseIds.some((caseId) => caseId === "")) {
    throw new Error("answerability judge case ID must be non-blank");
  }
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("answerability judge case IDs must be unique");
  }

  const cases = input.map((item, index) => {
    if (item.expectedBehavior === "hit") {
      if (!item.expectedCandidateId?.trim()) {
        throw new Error("hit case must expect a candidate");
      }
    } else if (item.expectedCandidateId !== null) {
      throw new Error("abstain case cannot expect a candidate");
    }
    if (item.decision === null) {
      if (typeof item.error !== "string" || item.error.trim() === "") {
        throw new Error("answerability judge error case must include an error");
      }
      return {
        caseId: caseIds[index],
        expectedBehavior: item.expectedBehavior,
        expectedCandidateId: item.expectedCandidateId,
        accepted: false,
        outcome: "judge_error" as const,
        decision: null,
        error: item.error.trim(),
      };
    }
    if (item.error !== undefined) {
      throw new Error("successful answerability judge case cannot include an error");
    }
    const accepted = item.decision.verdict === "directly_answerable";
    let outcome: AnswerabilityJudgeOutcome;
    if (item.expectedBehavior === "hit") {
      outcome = !accepted
        ? "false_abstain"
        : item.decision.candidateId === item.expectedCandidateId
          ? "correct_accept"
          : "wrong_accept";
    } else {
      outcome = accepted ? "false_accept" : "correct_abstain";
    }
    return {
      caseId: caseIds[index],
      expectedBehavior: item.expectedBehavior,
      expectedCandidateId: item.expectedCandidateId,
      accepted,
      outcome,
      decision: item.decision,
    };
  });
  const answerable = cases.filter(
    ({ expectedBehavior }) => expectedBehavior === "hit",
  );
  const unanswerable = cases.filter(
    ({ expectedBehavior }) => expectedBehavior === "abstain",
  );
  const accepted = cases.filter((item) => item.accepted);
  const correctAccepts = cases.filter(
    ({ outcome }) => outcome === "correct_accept",
  ).length;
  const correctAbstains = cases.filter(
    ({ outcome }) => outcome === "correct_abstain",
  ).length;

  return {
    caseCount: cases.length,
    answerableCaseCount: answerable.length,
    unanswerableCaseCount: unanswerable.length,
    answerableCorrectAcceptRate: safeRate(correctAccepts, answerable.length),
    answerableCoverage: safeRate(
      answerable.filter((item) => item.accepted).length,
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
