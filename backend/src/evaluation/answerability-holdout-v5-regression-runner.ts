import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { evaluateThreeClassAnswerability } from "./answerability-three-class-evaluation.ts";
import type {
  AnswerabilityCandidate,
  AnswerabilityDecision,
  AnswerabilityJudgeInput,
  AnswerabilityVerdict,
} from "./qwen-answerability-judge.ts";

interface AcceptanceTargets {
  overall_exact_accuracy_minimum: number;
  per_class_accuracy_minimum: number;
  unsafe_direct_accept_count_maximum: number;
  judge_error_count_maximum: number;
}

export interface AnswerabilityV5RegressionFreezeRecord {
  record_version: 1;
  status: "frozen_before_full_v5_regression";
  source_evidence: {
    first_run_report_sha256: string;
    v3_regression_report_sha256: string;
    candidate_manifest_sha256: string;
  };
  strategy: {
    judge_model_id: string;
    from_prompt_version: "answerability-v3";
    to_prompt_version: "answerability-v5-two-stage";
    judge_implementation_sha256: string;
    evaluator_sha256: string;
    runner_sha256: string;
    candidate_order_source: "failed_first_run_top5";
  };
  single_changed_variable: {
    name: "judgment_orchestration";
    from: "single_call_direct_verdict";
    to: "two_stage_facts_program_verdict_evidence";
  };
  acceptance_targets: AcceptanceTargets;
  interpretation_limits: string[];
}

interface FirstRunCase {
  caseId: string;
  query: string;
  expectedVerdict: AnswerabilityVerdict;
  expectedCandidateId: string | null;
  actualVerdict: AnswerabilityVerdict | null;
  actualCandidateId: string | null;
  outcome: string;
  candidateIds: string[];
}

interface FirstRunReport {
  reportVersion: 1;
  datasetRole: "project_authored_unseen_holdout_first_run";
  candidateLimit: number;
  passed: false;
  judge: { modelId: string; promptVersion: "answerability-v2" };
  acceptanceTargets: AcceptanceTargets;
  evaluation: {
    caseCount: number;
    overallExactAccuracy: number;
    unsafeDirectAcceptCount: number;
    judgeErrorCount: number;
    cases: FirstRunCase[];
  };
}

interface V3RegressionReport {
  reportVersion: 1;
  datasetRole: "exposed_holdout_regression_after_v3_prompt_fix";
  passed: false;
  judge: { promptVersion: "answerability-v3" };
  evaluation: {
    caseCount: number;
    overallExactAccuracy: number;
    unsafeDirectAcceptCount: number;
    judgeErrorCount: number;
  };
}

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    section_title: string;
    sources: Array<{ pdf_page_number: number; excerpt: string }>;
  }>;
}

export interface AnswerabilityV5RegressionJudge {
  modelId: string;
  promptVersion: string;
  judge(input: AnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateAnswerabilityV5RegressionFreeze(input: {
  firstRunRaw: string;
  v3RunRaw: string;
  manifestRaw: string;
  judgeRaw: string;
  evaluatorRaw: string;
  runnerRaw: string;
  planRaw: string;
}): AnswerabilityV5RegressionFreezeRecord {
  const record = JSON.parse(
    input.planRaw,
  ) as AnswerabilityV5RegressionFreezeRecord;
  if (
    record.record_version !== 1 ||
    record.status !== "frozen_before_full_v5_regression" ||
    record.source_evidence?.first_run_report_sha256 !==
      sha256(input.firstRunRaw) ||
    record.source_evidence?.v3_regression_report_sha256 !==
      sha256(input.v3RunRaw) ||
    record.source_evidence?.candidate_manifest_sha256 !==
      sha256(input.manifestRaw) ||
    record.strategy?.judge_implementation_sha256 !== sha256(input.judgeRaw) ||
    record.strategy?.evaluator_sha256 !== sha256(input.evaluatorRaw) ||
    record.strategy?.runner_sha256 !== sha256(input.runnerRaw) ||
    record.strategy?.from_prompt_version !== "answerability-v3" ||
    record.strategy?.to_prompt_version !== "answerability-v5-two-stage" ||
    record.strategy?.candidate_order_source !== "failed_first_run_top5" ||
    record.single_changed_variable?.name !== "judgment_orchestration" ||
    record.single_changed_variable?.from !== "single_call_direct_verdict" ||
    record.single_changed_variable?.to !==
      "two_stage_facts_program_verdict_evidence"
  ) {
    throw new Error(
      "answerability v5 regression does not match the freeze record",
    );
  }
  return record;
}

function sameTargets(left: AcceptanceTargets, right: AcceptanceTargets): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runAnswerabilityHoldoutV5Regression(options: {
  judge: AnswerabilityV5RegressionJudge;
  firstRunReportPath?: string;
  v3RegressionReportPath?: string;
  candidateManifestPath?: string;
  regressionPlanPath?: string;
  judgeImplementationPath?: string;
  evaluatorPath?: string;
  runnerPath?: string;
}) {
  const paths = {
    firstRun:
      options.firstRunReportPath ??
      "reports/qwen-answerability-holdout-v3-first-run.json",
    v3Run:
      options.v3RegressionReportPath ??
      "reports/qwen-answerability-v3-regression.json",
    manifest:
      options.candidateManifestPath ??
      "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
    plan:
      options.regressionPlanPath ??
      "reports/ohf-answerability-v5-regression-plan.json",
    judge:
      options.judgeImplementationPath ??
      "src/evaluation/qwen-answerability-judge-v5.ts",
    evaluator:
      options.evaluatorPath ??
      "src/evaluation/answerability-three-class-evaluation.ts",
    runner:
      options.runnerPath ??
      "src/evaluation/answerability-holdout-v5-regression-runner.ts",
  };
  const [
    firstRunRaw,
    v3RunRaw,
    manifestRaw,
    planRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
  ] = await Promise.all(
    Object.values(paths).map((path) => readFile(path, "utf8")),
  );
  const plan = validateAnswerabilityV5RegressionFreeze({
    firstRunRaw,
    v3RunRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    planRaw,
  });
  const firstRun = JSON.parse(firstRunRaw) as FirstRunReport;
  const v3Run = JSON.parse(v3RunRaw) as V3RegressionReport;
  if (
    firstRun.reportVersion !== 1 ||
    firstRun.datasetRole !== "project_authored_unseen_holdout_first_run" ||
    firstRun.passed !== false ||
    firstRun.candidateLimit !== 5 ||
    firstRun.evaluation?.caseCount !== 18 ||
    !sameTargets(firstRun.acceptanceTargets, plan.acceptance_targets) ||
    v3Run.reportVersion !== 1 ||
    v3Run.datasetRole !==
      "exposed_holdout_regression_after_v3_prompt_fix" ||
    v3Run.passed !== false ||
    v3Run.judge?.promptVersion !== plan.strategy.from_prompt_version ||
    v3Run.evaluation?.caseCount !== firstRun.evaluation.caseCount
  ) {
    throw new Error("answerability v5 regression source reports are invalid");
  }
  if (
    options.judge.modelId !== plan.strategy.judge_model_id ||
    options.judge.promptVersion !== plan.strategy.to_prompt_version
  ) {
    throw new Error("answerability v5 regression judge does not match freeze");
  }
  const manifest = JSON.parse(manifestRaw) as CandidateManifest;
  if (manifest.review_status !== "unreviewed") {
    throw new Error("answerability v5 regression expects unreviewed candidates");
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

  const startedAt = performance.now();
  const actualCases = [];
  for (const item of firstRun.evaluation.cases) {
    if (
      item.candidateIds.length !== firstRun.candidateLimit ||
      new Set(item.candidateIds).size !== item.candidateIds.length ||
      item.candidateIds.some((id) => !candidatesById.has(id))
    ) {
      throw new Error("answerability v5 regression candidate order is invalid");
    }
    let decision: AnswerabilityDecision | null = null;
    let error: string | undefined;
    try {
      decision = await options.judge.judge({
        question: item.query,
        candidates: item.candidateIds.map((id) => candidatesById.get(id)!),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    actualCases.push({
      caseId: item.caseId,
      query: item.query,
      expectedVerdict: item.expectedVerdict,
      expectedCandidateId: item.expectedCandidateId,
      candidateIds: item.candidateIds,
      previousActualVerdict: item.actualVerdict,
      previousActualCandidateId: item.actualCandidateId,
      previousOutcome: item.outcome,
      decision,
      ...(error === undefined ? {} : { error }),
    });
  }
  const evaluation = evaluateThreeClassAnswerability(
    actualCases.map((item) => ({
      caseId: item.caseId,
      expectedVerdict: item.expectedVerdict,
      expectedCandidateId: item.expectedCandidateId,
      decision: item.decision,
      ...(item.error === undefined ? {} : { error: item.error }),
    })),
  );
  const targets = plan.acceptance_targets;
  const gates = {
    overallExactAccuracy:
      evaluation.overallExactAccuracy >= targets.overall_exact_accuracy_minimum,
    directlyAnswerableAccuracy:
      evaluation.perClassAccuracy.directly_answerable >=
      targets.per_class_accuracy_minimum,
    partiallyRelatedAccuracy:
      evaluation.perClassAccuracy.partially_related >=
      targets.per_class_accuracy_minimum,
    notAnswerableAccuracy:
      evaluation.perClassAccuracy.not_answerable >=
      targets.per_class_accuracy_minimum,
    unsafeDirectAcceptCount:
      evaluation.unsafeDirectAcceptCount <=
      targets.unsafe_direct_accept_count_maximum,
    judgeErrorCount:
      evaluation.judgeErrorCount <= targets.judge_error_count_maximum,
  };

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    evaluationOnly: true,
    datasetRole: "exposed_holdout_regression_after_v5_orchestration" as const,
    productionAccuracyClaimAllowed: false,
    elapsedMilliseconds: performance.now() - startedAt,
    sourceFirstRunSha256: sha256(firstRunRaw),
    sourceV3RegressionSha256: sha256(v3RunRaw),
    regressionPlanSha256: sha256(planRaw),
    judgeImplementationSha256: sha256(judgeRaw),
    evaluatorSha256: sha256(evaluatorRaw),
    runnerSha256: sha256(runnerRaw),
    judge: {
      modelId: options.judge.modelId,
      promptVersion: options.judge.promptVersion,
    },
    ranking: {
      reusedFromFailedFirstRun: true,
      candidateLimit: firstRun.candidateLimit,
      sourcePromptVersion: firstRun.judge.promptVersion,
    },
    singleChangedVariable: plan.single_changed_variable,
    acceptanceTargets: targets,
    comparison: {
      firstRunOverallExactAccuracy:
        firstRun.evaluation.overallExactAccuracy,
      v3OverallExactAccuracy: v3Run.evaluation.overallExactAccuracy,
      firstRunUnsafeDirectAcceptCount:
        firstRun.evaluation.unsafeDirectAcceptCount,
      v3UnsafeDirectAcceptCount: v3Run.evaluation.unsafeDirectAcceptCount,
    },
    evaluation: {
      ...evaluation,
      cases: evaluation.cases.map((result, index) => ({
        ...result,
        query: actualCases[index].query,
        candidateIds: actualCases[index].candidateIds,
        decision: actualCases[index].decision,
        firstRun: {
          actualVerdict: actualCases[index].previousActualVerdict,
          actualCandidateId: actualCases[index].previousActualCandidateId,
          outcome: actualCases[index].previousOutcome,
        },
        ...(actualCases[index].error === undefined
          ? {}
          : { error: actualCases[index].error }),
      })),
    },
    gates,
    passed: Object.values(gates).every(Boolean),
    interpretationLimits: plan.interpretation_limits,
  };
}
