import type {
  AnswerabilityDecision,
  AnswerabilityVerdict,
} from "./qwen-answerability-judge.ts";

export type ThreeClassOutcome =
  | "correct"
  | "wrong_verdict"
  | "wrong_candidate"
  | "unsafe_direct_accept"
  | "judge_error";

export interface ThreeClassEvaluationInput {
  caseId: string;
  expectedVerdict: AnswerabilityVerdict;
  expectedCandidateId: string | null;
  decision?: AnswerabilityDecision | null;
  error?: string;
}

function nonBlank(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

export function evaluateThreeClassAnswerability(
  inputs: ThreeClassEvaluationInput[],
) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("three-class evaluation needs cases");
  }
  const seen = new Set<string>();
  const verdicts = [
    "directly_answerable",
    "partially_related",
    "not_answerable",
  ] as const;
  const totals = new Map<AnswerabilityVerdict, number>();
  const correct = new Map<AnswerabilityVerdict, number>();
  const cases = inputs.map((input) => {
    const caseId = nonBlank(input.caseId, "evaluation case ID");
    if (seen.has(caseId)) throw new Error("evaluation case IDs must be unique");
    seen.add(caseId);
    if (!verdicts.includes(input.expectedVerdict)) {
      throw new Error(`case ${caseId} expected verdict is invalid`);
    }
    if (
      (input.expectedVerdict === "not_answerable" &&
        input.expectedCandidateId !== null) ||
      (input.expectedVerdict !== "not_answerable" &&
        (typeof input.expectedCandidateId !== "string" ||
          input.expectedCandidateId.trim() === ""))
    ) {
      throw new Error(`case ${caseId} expected candidate is invalid`);
    }
    totals.set(
      input.expectedVerdict,
      (totals.get(input.expectedVerdict) ?? 0) + 1,
    );

    let outcome: ThreeClassOutcome;
    if (input.error !== undefined || !input.decision) {
      outcome = "judge_error";
    } else if (
      input.expectedVerdict !== "directly_answerable" &&
      input.decision.verdict === "directly_answerable"
    ) {
      outcome = "unsafe_direct_accept";
    } else if (input.decision.verdict !== input.expectedVerdict) {
      outcome = "wrong_verdict";
    } else if (
      input.expectedCandidateId !== null &&
      input.decision.candidateId !== input.expectedCandidateId
    ) {
      outcome = "wrong_candidate";
    } else {
      outcome = "correct";
      correct.set(
        input.expectedVerdict,
        (correct.get(input.expectedVerdict) ?? 0) + 1,
      );
    }
    return {
      caseId,
      expectedVerdict: input.expectedVerdict,
      expectedCandidateId: input.expectedCandidateId,
      actualVerdict: input.decision?.verdict ?? null,
      actualCandidateId: input.decision?.candidateId ?? null,
      outcome,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
  });
  const perClassAccuracy = Object.fromEntries(
    verdicts.map((verdict) => [
      verdict,
      (correct.get(verdict) ?? 0) / (totals.get(verdict) ?? 1),
    ]),
  ) as Record<AnswerabilityVerdict, number>;
  const exactCorrectCount = cases.filter(
    ({ outcome }) => outcome === "correct",
  ).length;
  return {
    caseCount: cases.length,
    exactCorrectCount,
    overallExactAccuracy: exactCorrectCount / cases.length,
    perClassAccuracy,
    unsafeDirectAcceptCount: cases.filter(
      ({ outcome }) => outcome === "unsafe_direct_accept",
    ).length,
    judgeErrorCount: cases.filter(({ outcome }) => outcome === "judge_error")
      .length,
    cases,
  };
}
