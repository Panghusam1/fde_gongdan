import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import { loadWorkOrderEndToEndHoldoutV3 } from "../src/evaluation/work-order-end-to-end-holdout-v3-dataset.ts";
import { executeWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-executor.ts";
import { executeWorkOrderEndToEndHoldoutV2 as executeSourceAwareWorkOrderEndToEnd } from "../src/evaluation/work-order-end-to-end-source-aware-executor.ts";
import type { QwenAnswerabilityJudge } from "../src/evaluation/qwen-answerability-judge.ts";
import { createWorkOrderMainChain } from "../src/coordinator/work-order-main-chain.ts";

function createControlledEmbedder() {
  const vectorFor = (text: string) =>
    text.includes("重启")
      ? [0, 1, 0, 0]
      : text.includes("风扇") || text.includes("风机")
        ? [0, 0, 0, 1]
      : text.includes("检查电机负载") ||
          text.includes("通风") ||
          text.includes("外部核查") ||
          text.includes("负载")
        ? [1, 0, 0, 0]
        : [0, 0, 1, 0];
  return {
    modelId: "Xenova/multilingual-e5-small",
    modelRevision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dimensions: 4,
    poolingMethod: "mean" as const,
    isNormalized: true as const,
    embedPassage: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
  };
}

const controlledJudge: QwenAnswerabilityJudge = {
  modelId: "qwen3.7-plus",
  promptVersion: "answerability-v5-two-stage",
  async judge(input) {
    if (
      input.question.includes("保修") ||
      input.question.includes("含税价格") ||
      input.question.includes("具体日期") ||
      input.question.includes("仓库")
    ) {
      return {
        verdict: "not_answerable",
        candidateId: null,
        sourcePageNumber: null,
        supportingQuote: null,
        reason: "当前候选没有设备维修日期、采购价格或厂区库存。",
      };
    }
    const marker = input.question.includes("产品重启")
      ? "重启”功能执行“故障复位”"
      : input.question.includes("风扇") || input.question.includes("风机")
        ? "风机运行状况与变频器热状态相关"
      : "检查电机负载、变频器通风情况和环境温度";
    const selected = input.candidates.find(({ sources }) =>
      sources.some(({ text }) => text.includes(marker)),
    );
    assert.ok(selected);
    const source = selected.sources.find(({ text }) => text.includes(marker))!;
    return {
      verdict: "directly_answerable",
      candidateId: selected.id,
      sourcePageNumber: source.pageNumber,
      supportingQuote: source.text,
      reason: "候选逐字原文直接支持当前问题。",
    };
  },
};

const controlledCoordinator = {
  modelId: "qwen3.7-plus",
  promptVersion: "coordinator-v2",
  async decide(input: {
    userMessage: string;
    allowedActions: string[];
    workOrderContext: any;
  }) {
    assert.equal(input.allowedActions.length, 1);
    const action = input.allowedActions[0];
    const context = input.workOrderContext;
    if (action === "draft_resolution_proposal") {
      const second = context.latestProposal?.feedbackOutcome === "not_resolved";
      const feedbackEvent = context.observations.find(
        (item: { eventType: string }) => item.eventType === "user_feedback_recorded",
      );
      return {
        action,
        riskAssessmentId: context.latestRiskAssessment.riskAssessmentId,
        evidenceSearchHitIds: [
          context.latestRiskAssessment.selectedSearchHitId,
        ],
        summary: second
          ? "根据新反馈核查尚未确认的外部项目。"
          : "根据官方资料执行不拆机的外部核查。",
        confirmedFacts: ["当前工单记录OHF", "现场尚未拆机"],
        assumptions: ["现场人员只进行外部观察和记录"],
        steps: second
          ? ["保持设备完整，观察风扇运行状态并记录当前热状态"]
          : ["保持设备完整，观察并记录变频器通风情况"],
        stopConditions: ["需要拆机、带电测量或出现异常气味时立即停止并转人工"],
        expectedObservations: ["记录核查值以及OHF是否继续出现"],
        ...(second ? { basisObservationEventId: feedbackEvent.eventId } : {}),
      };
    }
    if (action === "request_user_confirmation") {
      return { action, proposalId: context.latestProposal.proposalId };
    }
    if (action === "record_user_confirmation") {
      const notResolved = input.userMessage.includes("未恢复");
      return {
        action,
        proposalId: context.latestProposal.proposalId,
        outcome: notResolved ? "not_resolved" : "resolved",
        actualResult: notResolved
          ? "现场完成外部核查后OHF仍然出现。"
          : "现场完成外部核查后确认设备恢复。",
      };
    }
    throw new Error(`unexpected controlled action ${action}`);
  },
};

const controlledCoordinatorV3 = {
  ...controlledCoordinator,
  promptVersion: "coordinator-v3-state-bound",
};

test("R268：十二条工单必须经过真实工具和数据库形成预声明终态", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV2();
  const result = await executeWorkOrderEndToEndHoldoutV2({
    dataset,
    embedder: createControlledEmbedder(),
    judge: controlledJudge,
    coordinatorModel: controlledCoordinator,
  });
  assert.equal(result.actualCases.length, 12);
  assert.equal(result.actualCases.every(({ workflow_error }) => workflow_error === null), true);
  assert.equal(
    result.report.exact_case_count,
    12,
    JSON.stringify(
      result.report.cases.filter(({ exact_passed }) => !exact_passed),
      null,
      2,
    ),
  );
  assert.equal(result.report.safety_case_pass_count, 5);
  assert.equal(result.report.unsafe_proposal_count, 0);
  assert.equal(result.report.passed, true);
});

test("R281：新未见数据必须先用可控模型跑通同一真实工具和数据库", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV3();
  const result = await executeWorkOrderEndToEndHoldoutV2({
    dataset: dataset as any,
    embedder: createControlledEmbedder(),
    judge: controlledJudge,
    coordinatorModel: controlledCoordinatorV3,
  });
  assert.equal(result.actualCases.length, 12);
  assert.equal(
    result.report.exact_case_count,
    12,
    JSON.stringify(
      result.report.cases.filter(({ exact_passed }) => !exact_passed),
      null,
      2,
    ),
  );
  assert.equal(result.report.safety_case_pass_count, 5);
  assert.equal(result.report.passed, true);
});

test("R290：十二条工单回归必须通过正式第六版主链和数据库来源身份", async () => {
  const sourceDataset = await loadWorkOrderEndToEndHoldoutV3();
  const dataset = {
    ...sourceDataset,
    dataset_id: "work-order-source-aware-main-chain-regression-v1",
    dataset_role: "exposed_regression_not_unseen",
    purpose: "验证正式工单主链升级第六版来源判断后不破坏既有数据库终态。",
    strategy: {
      ...sourceDataset.strategy,
      judge_prompt_version: "answerability-v6-source-aware",
    },
    interpretation_limits: [
      "十二条工单已经暴露，本轮只能证明主链升级回归。",
      "项目自建题不代表真实工厂准确率。",
    ],
  } as any;
  let assessedCandidateCount = 0;
  const sourceAwareControlledJudge = {
    modelId: "qwen3.7-plus",
    promptVersion: "answerability-v6-source-aware",
    async judge(input: {
      question: string;
      candidates: Array<{
        id: string;
        documentReference: string;
        versionLabel: string;
        languageCode: string;
        sources: Array<{ pageNumber: number; text: string }>;
      }>;
    }) {
      for (const candidate of input.candidates) {
        assert.equal(candidate.documentReference, "NVE41300");
        assert.equal(candidate.versionLabel, "05");
        assert.equal(candidate.languageCode, "zh-CN");
        assessedCandidateCount += 1;
      }
      if (input.question.includes("具体日期") || input.question.includes("仓库")) {
        return {
          verdict: "not_answerable" as const,
          candidateId: null,
          sourcePageNumber: null,
          supportingQuote: null,
          reason: "当前官方资料没有现场历史日期或厂区库存。",
        };
      }
      const marker = input.question.includes("产品重启")
        ? "重启”功能执行“故障复位”"
        : input.question.includes("风扇") || input.question.includes("风机")
          ? "风机运行状况与变频器热状态相关"
          : "检查电机负载、变频器通风情况和环境温度";
      const selected = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(marker)),
      );
      assert.ok(selected);
      const source = selected.sources.find(({ text }) => text.includes(marker))!;
      return {
        verdict: "directly_answerable" as const,
        candidateId: selected.id,
        sourcePageNumber: source.pageNumber,
        supportingQuote: source.text,
        reason: "来源身份和候选原文共同支持问题。",
      };
    },
  };

  const result = await executeSourceAwareWorkOrderEndToEnd({
    dataset,
    embedder: createControlledEmbedder(),
    createMainChain(database, embedder) {
      return createWorkOrderMainChain(database, embedder, {
        coordinatorModel: controlledCoordinatorV3 as any,
        sourceAwareAnswerabilityModel: sourceAwareControlledJudge,
      });
    },
  } as any);

  assert.ok(assessedCandidateCount > 0);
  assert.equal(result.actualCases.length, 12);
  assert.equal(result.report.exact_case_count, 12);
  assert.equal(result.report.safety_case_pass_count, 5);
  assert.equal(result.report.unsafe_proposal_count, 0);
  assert.equal(result.report.judge_error_count, 0);
  assert.equal(result.report.passed, true);
});
