import { createHash } from "node:crypto";

import type {
  AnswerabilityDecision,
  AnswerabilityVerdict,
} from "./qwen-answerability-judge.ts";

interface CandidateAdjudicationRecord {
  schema_version: 1;
  status: string;
  source_report_sha256: string;
  pre_run_plan_sha256: string;
  changes_expected_verdicts: false;
  cases: Array<{
    case_id: string;
    expected_verdict: AnswerabilityVerdict;
    original_expected_candidate_id: string;
    acceptable_candidate_ids: string[];
    predeclared_basis: string;
    evidence_reason: string;
  }>;
}

export interface AdjudicatedEvaluationInput {
  caseId: string;
  expectedVerdict: AnswerabilityVerdict;
  originalExpectedCandidateId: string | null;
  acceptableCandidateIds: string[] | null;
  decision?: AnswerabilityDecision | null;
  error?: string;
}

export type AdjudicatedOutcome =
  | "adjudicated_correct"
  | "wrong_verdict"
  | "wrong_candidate"
  | "unsafe_direct_accept"
  | "judge_error";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be non-blank text`);
  }
  return value.trim();
}

export function loadCandidateAdjudication(input: {
  reportRaw: string;
  planRaw: string;
  auditRaw: string;
}) {
  const audit = JSON.parse(input.auditRaw) as CandidateAdjudicationRecord;
  const report = JSON.parse(input.reportRaw) as {
    evaluation?: {
      cases?: Array<{
        caseId: string;
        expectedVerdict: AnswerabilityVerdict;
        expectedCandidateId: string | null;
        candidateIds: string[];
      }>;
    };
  };
  const plan = JSON.parse(input.planRaw) as {
    architecture_probe?: Record<string, unknown> & { case_ids?: string[] };
  };
  if (
    audit.schema_version !== 1 ||
    audit.status !==
      "provisional_project_audit_not_domain_engineer_approved" ||
    audit.source_report_sha256 !== sha256(input.reportRaw) ||
    audit.pre_run_plan_sha256 !== sha256(input.planRaw) ||
    audit.changes_expected_verdicts !== false ||
    !Array.isArray(audit.cases) ||
    audit.cases.length === 0 ||
    !Array.isArray(report.evaluation?.cases) ||
    !Array.isArray(plan.architecture_probe?.case_ids)
  ) {
    throw new Error("candidate adjudication does not match its evidence");
  }
  const reportById = new Map(
    report.evaluation.cases.map((item) => [item.caseId, item]),
  );
  const acceptableCandidatesByCase = new Map<string, string[]>();
  for (const item of audit.cases) {
    const caseId = nonBlank(item.case_id, "adjudication case ID");
    const source = reportById.get(caseId);
    const predeclaredKey = `${caseId}_candidate_label_ambiguity`;
    const acceptable = item.acceptable_candidate_ids.map((candidateId) =>
      nonBlank(candidateId, "acceptable candidate ID"),
    );
    if (
      acceptableCandidatesByCase.has(caseId) ||
      !source ||
      source.expectedVerdict !== item.expected_verdict ||
      source.expectedCandidateId !== item.original_expected_candidate_id ||
      !plan.architecture_probe.case_ids.includes(caseId) ||
      typeof plan.architecture_probe[predeclaredKey] !== "string" ||
      !acceptable.includes(item.original_expected_candidate_id) ||
      acceptable.length < 2 ||
      new Set(acceptable).size !== acceptable.length ||
      acceptable.some((candidateId) => !source.candidateIds.includes(candidateId)) ||
      nonBlank(item.predeclared_basis, "predeclared basis") === "" ||
      nonBlank(item.evidence_reason, "evidence reason") === ""
    ) {
      throw new Error("candidate adjudication does not match its evidence");
    }
    acceptableCandidatesByCase.set(caseId, acceptable);
  }
  return { record: audit, acceptableCandidatesByCase };
}

export function evaluateAdjudicatedAnswerability(
  inputs: AdjudicatedEvaluationInput[],
) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("adjudicated evaluation needs cases");
  }
  const verdicts = [
    "directly_answerable",
    "partially_related",
    "not_answerable",
  ] as const;
  const totals = new Map<AnswerabilityVerdict, number>();
  const verdictCorrect = new Map<AnswerabilityVerdict, number>();
  const exactCorrect = new Map<AnswerabilityVerdict, number>();
  const seen = new Set<string>();
  const cases = inputs.map((input) => {
    const caseId = nonBlank(input.caseId, "adjudicated evaluation case ID");
    if (seen.has(caseId)) {
      throw new Error("adjudicated evaluation case IDs must be unique");
    }
    seen.add(caseId);
    if (!verdicts.includes(input.expectedVerdict)) {
      throw new Error(`case ${caseId} expected verdict is invalid`);
    }
    if (input.expectedVerdict === "not_answerable") {
      if (
        input.originalExpectedCandidateId !== null ||
        input.acceptableCandidateIds !== null
      ) {
        throw new Error(`case ${caseId} expected candidates are invalid`);
      }
    } else if (
      typeof input.originalExpectedCandidateId !== "string" ||
      !Array.isArray(input.acceptableCandidateIds) ||
      input.acceptableCandidateIds.length === 0 ||
      !input.acceptableCandidateIds.includes(input.originalExpectedCandidateId)
    ) {
      throw new Error(`case ${caseId} expected candidates are invalid`);
    }
    totals.set(
      input.expectedVerdict,
      (totals.get(input.expectedVerdict) ?? 0) + 1,
    );
    const isVerdictCorrect =
      input.error === undefined &&
      input.decision?.verdict === input.expectedVerdict;
    if (isVerdictCorrect) {
      verdictCorrect.set(
        input.expectedVerdict,
        (verdictCorrect.get(input.expectedVerdict) ?? 0) + 1,
      );
    }
    const isCandidateAccepted =
      input.expectedVerdict === "not_answerable"
        ? input.decision?.candidateId === null
        : input.acceptableCandidateIds!.includes(
            input.decision?.candidateId ?? "",
          );
    let outcome: AdjudicatedOutcome;
    if (input.error !== undefined || !input.decision) {
      outcome = "judge_error";
    } else if (
      input.expectedVerdict !== "directly_answerable" &&
      input.decision.verdict === "directly_answerable"
    ) {
      outcome = "unsafe_direct_accept";
    } else if (!isVerdictCorrect) {
      outcome = "wrong_verdict";
    } else if (!isCandidateAccepted) {
      outcome = "wrong_candidate";
    } else {
      outcome = "adjudicated_correct";
      exactCorrect.set(
        input.expectedVerdict,
        (exactCorrect.get(input.expectedVerdict) ?? 0) + 1,
      );
    }
    return {
      caseId,
      expectedVerdict: input.expectedVerdict,
      originalExpectedCandidateId: input.originalExpectedCandidateId,
      acceptableCandidateIds: input.acceptableCandidateIds,
      actualVerdict: input.decision?.verdict ?? null,
      actualCandidateId: input.decision?.candidateId ?? null,
      outcome,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
  });
  const perClassVerdictAccuracy = Object.fromEntries(
    verdicts.map((verdict) => [
      verdict,
      (verdictCorrect.get(verdict) ?? 0) / (totals.get(verdict) ?? 1),
    ]),
  ) as Record<AnswerabilityVerdict, number>;
  const perClassAdjudicatedExactAccuracy = Object.fromEntries(
    verdicts.map((verdict) => [
      verdict,
      (exactCorrect.get(verdict) ?? 0) / (totals.get(verdict) ?? 1),
    ]),
  ) as Record<AnswerabilityVerdict, number>;
  const verdictCorrectCount = [...verdictCorrect.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const adjudicatedExactCorrectCount = cases.filter(
    ({ outcome }) => outcome === "adjudicated_correct",
  ).length;
  return {
    caseCount: cases.length,
    verdictCorrectCount,
    overallVerdictAccuracy: verdictCorrectCount / cases.length,
    adjudicatedExactCorrectCount,
    overallAdjudicatedExactAccuracy:
      adjudicatedExactCorrectCount / cases.length,
    perClassVerdictAccuracy,
    perClassAdjudicatedExactAccuracy,
    unsafeDirectAcceptCount: cases.filter(
      ({ outcome }) => outcome === "unsafe_direct_accept",
    ).length,
    judgeErrorCount: cases.filter(({ outcome }) => outcome === "judge_error")
      .length,
    cases,
  };
}
