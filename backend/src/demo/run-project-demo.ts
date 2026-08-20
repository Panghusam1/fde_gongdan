import { readFile } from "node:fs/promises";

import type { PGliteInterface } from "@electric-sql/pglite";

import { createWorkOrderMainChainV4 } from "../coordinator/work-order-main-chain-v4.ts";
import type { QwenCoordinatorModelV3 } from "../coordinator/qwen-coordinator-model-v3.ts";
import type { CoordinatorModelInput } from "../coordinator/qwen-coordinator-model.ts";
import type { WorkOrderEndToEndHoldoutV2 } from "../evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import { executeWorkOrderEndToEndHoldoutV2 } from "../evaluation/work-order-end-to-end-source-aware-executor.ts";
import type { SourceAwareAnswerabilityJudge } from "../evaluation/source-aware-work-order-judge.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";

const confirmedPromptVersion =
  "answerability-v8-candidate-isolated|confirmed-source-exact-v1|NVE41300/05/zh-CN";
const mismatchedPromptVersion =
  "answerability-v8-candidate-isolated|confirmed-source-exact-v1|NVE41300/04/zh-CN";

export type ProjectDemoScenario =
  | "normal"
  | "high_risk"
  | "insufficient_evidence"
  | "unauthorized_factory"
  | "source_mismatch";

export interface DemoDatabaseCounts {
  work_orders: number;
  knowledge_search_runs: number;
  evidence_assessments: number;
  risk_assessments: number;
  resolution_proposals: number;
  proposal_user_feedback: number;
  human_handoffs: number;
}

export interface ProjectDemoBranchResult {
  scenario:
    | "confirmed_source_normal_resolution"
    | "input_high_risk_handoff"
    | "insufficient_evidence_handoff"
    | "unauthorized_factory_blocked"
    | "confirmed_source_missing_handoff";
  requestedSource: "NVE41300/05/zh-CN" | "NVE41300/04/zh-CN";
  evidenceVerdicts: Array<"directly_answerable" | "not_answerable" | null>;
  finalStatus: "investigating" | "resolved" | "awaiting_human";
  handoffReason:
    | null
    | "high_risk"
    | "insufficient_evidence"
    | "two_proposals_failed";
  contentModelCallCount: number;
  databaseCounts: DemoDatabaseCounts;
}

export interface ProjectDemoResult {
  executionMode: "controlled_offline_real_database";
  normalPath: ProjectDemoBranchResult;
  sourceMismatchPath: ProjectDemoBranchResult;
}

const demoEmbedder: QueryEmbedder = {
  modelId: "controlled-demo-embedder",
  modelRevision: "1",
  dimensions: 3,
  poolingMethod: "mean",
  isNormalized: true,
  async embedPassage(text) {
    return text.includes("解决措施") ? [1, 0, 0] : [0, 1, 0];
  },
  async embedQuery(text) {
    return text.includes("解决措施") ? [1, 0, 0] : [0, 1, 0];
  },
};

function contextRecord(input: CoordinatorModelInput): Record<string, any> {
  if (
    typeof input.workOrderContext !== "object" ||
    input.workOrderContext === null
  ) {
    throw new Error("demo coordinator context is missing");
  }
  return input.workOrderContext as Record<string, any>;
}

const demoCoordinatorModel: QwenCoordinatorModelV3 = {
  modelId: "controlled-demo-coordinator",
  promptVersion: "coordinator-v3-state-bound",
  async decide(input) {
    const context = contextRecord(input);
    if (input.allowedActions.includes("draft_resolution_proposal")) {
      return {
        action: "draft_resolution_proposal",
        riskAssessmentId: context.latestRiskAssessment.riskAssessmentId,
        evidenceSearchHitIds: [
          context.latestRiskAssessment.selectedSearchHitId,
        ],
        summary: "根据已确认官方资料检查电机负载、设备外部通风和环境温度。",
        confirmedFacts: ["设备显示OHF", "资料来源身份已由程序确认"],
        assumptions: ["现场只做设备外部观察，不拆机、不带电测量"],
        steps: [
          "保持设备完整，记录电机负载、外部通风状态和环境温度。",
        ],
        stopConditions: [
          "发现冒烟、火花、异常气味或需要拆机时立即停止并转人工。",
        ],
        expectedObservations: ["记录三项检查结果以及OHF是否继续出现。"],
      };
    }
    if (input.allowedActions.includes("request_user_confirmation")) {
      return {
        action: "request_user_confirmation",
        proposalId: context.latestProposal.proposalId,
      };
    }
    if (input.allowedActions.includes("record_user_confirmation")) {
      return {
        action: "record_user_confirmation",
        proposalId: context.latestProposal.proposalId,
        outcome: "resolved",
        actualResult: "现场完成外部核查后确认OHF不再出现。",
      };
    }
    throw new Error(
      `demo coordinator cannot handle: ${input.allowedActions.join(",")}`,
    );
  },
};

async function loadDemoBase(): Promise<WorkOrderEndToEndHoldoutV2> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../data/evaluation/work-order-end-to-end-holdout-v3.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown as WorkOrderEndToEndHoldoutV2;
}

function oneCaseDataset(input: {
  base: WorkOrderEndToEndHoldoutV2;
  caseValue: WorkOrderEndToEndHoldoutV2["cases"][number];
  datasetId: string;
  judgePromptVersion: string;
}): WorkOrderEndToEndHoldoutV2 {
  return {
    ...input.base,
    dataset_id: input.datasetId,
    purpose: "本地离线演示，不作为未见评测或生产准确率证据。",
    dataset_role: "controlled_offline_demo_not_evaluation",
    strategy: {
      ...input.base.strategy,
      strategy_id: "controlled-offline-demo-v2",
      embedding_model_id: demoEmbedder.modelId,
      embedding_model_revision: demoEmbedder.modelRevision,
      judge_model_id: "controlled-demo-content",
      judge_prompt_version: input.judgePromptVersion,
      coordinator_model_id: demoCoordinatorModel.modelId,
      coordinator_prompt_version: demoCoordinatorModel.promptVersion,
    },
    cases: [input.caseValue],
    interpretation_limits: [
      "演示使用真实数据库迁移、官方摘录和业务工具，但模型为离线可控实现。",
      "演示只证明流程可重放，不代表真实工厂准确率。",
    ],
  } as unknown as WorkOrderEndToEndHoldoutV2;
}

async function executeDemoCase(input: {
  dataset: WorkOrderEndToEndHoldoutV2;
  rawQuestion: string;
  confirmedContentQuestion: string;
  requestedVersion: "04" | "05";
  contentJudge: SourceAwareAnswerabilityJudge;
}) {
  const result = await executeWorkOrderEndToEndHoldoutV2({
    dataset: input.dataset,
    embedder: demoEmbedder,
    createMainChain(database: PGliteInterface, embedder: QueryEmbedder) {
      const mainChain = createWorkOrderMainChainV4(database, embedder, {
        coordinatorModel: demoCoordinatorModel,
        sourceAwareAnswerabilityModel: input.contentJudge,
      });
      return {
        coordinatorModel: mainChain.coordinatorModel,
        answerabilityJudge: mainChain.createConfirmedAnswerabilityJudge({
          rawQuestion: input.rawQuestion,
          confirmedContentQuestion: input.confirmedContentQuestion,
          requestedSourceIdentity: {
            documentReference: "NVE41300",
            versionLabel: input.requestedVersion,
            languageCode: "zh-CN",
          },
        }),
      };
    },
  });
  const scored = result.report.cases[0];
  if (!scored?.exact_passed) {
    throw new Error(
      `demo scenario failed: ${scored?.mismatches.join(" | ") ?? "missing result"}`,
    );
  }
  return result.actualCases[0];
}

const scenarioConfig: Record<
  Exclude<ProjectDemoScenario, "source_mismatch">,
  {
    caseId: "U303" | "U308" | "U310" | "U312";
    resultScenario: ProjectDemoBranchResult["scenario"];
    judgeMode: "direct" | "not_answerable" | "must_not_call";
  }
> = {
  normal: {
    caseId: "U303",
    resultScenario: "confirmed_source_normal_resolution",
    judgeMode: "direct",
  },
  high_risk: {
    caseId: "U308",
    resultScenario: "input_high_risk_handoff",
    judgeMode: "must_not_call",
  },
  insufficient_evidence: {
    caseId: "U310",
    resultScenario: "insufficient_evidence_handoff",
    judgeMode: "not_answerable",
  },
  unauthorized_factory: {
    caseId: "U312",
    resultScenario: "unauthorized_factory_blocked",
    judgeMode: "must_not_call",
  },
};

function demoContentJudge(input: {
  mode: "direct" | "not_answerable" | "must_not_call";
  onCall(): void;
}): SourceAwareAnswerabilityJudge {
  return {
    modelId: "controlled-demo-content",
    promptVersion: "answerability-v8-candidate-isolated",
    async judge(judgeInput) {
      input.onCall();
      if (input.mode === "must_not_call") {
        throw new Error("this demo branch must not call the content model");
      }
      if (input.mode === "not_answerable") {
        return {
          verdict: "not_answerable",
          candidateId: null,
          sourcePageNumber: null,
          supportingQuote: null,
          reason: "官方手册不包含单台设备的维修日期或厂区库存记录。",
        };
      }
      const candidate = judgeInput.candidates.find(({ sources }) =>
        sources.some(({ text }) =>
          text.includes("检查电机负载、变频器通风情况和环境温度"),
        ),
      );
      if (!candidate) throw new Error("demo direct evidence is missing");
      const source = candidate.sources.find(({ text }) =>
        text.includes("检查电机负载、变频器通风情况和环境温度"),
      )!;
      return {
        verdict: "directly_answerable",
        candidateId: candidate.id,
        sourcePageNumber: source.pageNumber,
        supportingQuote:
          "解决措施 检查电机负载、变频器通风情况和环境温度。",
        reason: "确认来源中的原文直接列出三项检查。",
      };
    },
  };
}

export async function runProjectDemoScenario(
  scenario: ProjectDemoScenario,
): Promise<ProjectDemoBranchResult> {
  const base = await loadDemoBase();
  let contentModelCallCount = 0;

  if (scenario === "source_mismatch") {
    const sourceCase = base.cases.find(({ case_id }) => case_id === "U303");
    if (!sourceCase) throw new Error("demo source case U303 is missing");
    const mismatchCase: WorkOrderEndToEndHoldoutV2["cases"][number] = {
      ...sourceCase,
      case_id: "DEMO-SOURCE-MISMATCH",
      branch: "insufficient_evidence",
      expected_evidence_verdicts: ["not_answerable"],
      feedback_outcomes: [],
      expected_final_status: "awaiting_human",
      expected_handoff_reason: "insufficient_evidence",
      expected_final_state: {
        work_orders: 1,
        knowledge_search_runs: 1,
        evidence_assessments: 1,
        risk_assessments: 1,
        resolution_proposals: 0,
        proposal_user_feedback: 0,
        human_handoffs: 1,
      },
    };
    const rawQuestion = mismatchCase.search_queries[0];
    const actual = await executeDemoCase({
      dataset: oneCaseDataset({
        base,
        caseValue: mismatchCase,
        datasetId: "project-demo-source-mismatch-v2",
        judgePromptVersion: mismatchedPromptVersion,
      }),
      rawQuestion,
      confirmedContentQuestion: "OHF条目中的解决措施列出了哪些检查？",
      requestedVersion: "04",
      contentJudge: demoContentJudge({
        mode: "must_not_call",
        onCall() {
          contentModelCallCount += 1;
        },
      }),
    });
    return {
      scenario: "confirmed_source_missing_handoff",
      requestedSource: "NVE41300/04/zh-CN",
      evidenceVerdicts: actual.actual_evidence_verdicts,
      finalStatus: actual.actual_final_status,
      handoffReason: actual.actual_handoff_reason,
      contentModelCallCount,
      databaseCounts: actual.actual_final_state,
    } as ProjectDemoBranchResult;
  }

  const config = scenarioConfig[scenario];
  const caseValue = base.cases.find(({ case_id }) => case_id === config.caseId);
  if (!caseValue) throw new Error(`demo source case ${config.caseId} is missing`);
  const rawQuestion = caseValue.search_queries[0];
  const actual = await executeDemoCase({
    dataset: oneCaseDataset({
      base,
      caseValue,
      datasetId: `project-demo-${scenario}-v2`,
      judgePromptVersion: confirmedPromptVersion,
    }),
    rawQuestion,
    confirmedContentQuestion: rawQuestion,
    requestedVersion: "05",
    contentJudge: demoContentJudge({
      mode: config.judgeMode,
      onCall() {
        contentModelCallCount += 1;
      },
    }),
  });
  return {
    scenario: config.resultScenario,
    requestedSource: "NVE41300/05/zh-CN",
    evidenceVerdicts: actual.actual_evidence_verdicts,
    finalStatus: actual.actual_final_status,
    handoffReason: actual.actual_handoff_reason,
    contentModelCallCount,
    databaseCounts: actual.actual_final_state,
  } as ProjectDemoBranchResult;
}

export async function runProjectDemo(): Promise<ProjectDemoResult> {
  const [normalPath, sourceMismatchPath] = await Promise.all([
    runProjectDemoScenario("normal"),
    runProjectDemoScenario("source_mismatch"),
  ]);
  return {
    executionMode: "controlled_offline_real_database",
    normalPath,
    sourceMismatchPath,
  };
}
