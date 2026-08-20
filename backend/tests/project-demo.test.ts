import assert from "node:assert/strict";
import test from "node:test";

import * as projectDemo from "../src/demo/run-project-demo.ts";

const { runProjectDemo } = projectDemo;

test("R321：离线演示必须同时跑通正常闭环和来源不匹配转人工", async () => {
  const result = await runProjectDemo();

  assert.equal(result.executionMode, "controlled_offline_real_database");
  assert.deepEqual(result.normalPath, {
    scenario: "confirmed_source_normal_resolution",
    requestedSource: "NVE41300/05/zh-CN",
    evidenceVerdicts: ["directly_answerable"],
    finalStatus: "resolved",
    handoffReason: null,
    contentModelCallCount: 1,
    databaseCounts: {
      work_orders: 1,
      knowledge_search_runs: 1,
      evidence_assessments: 1,
      risk_assessments: 1,
      resolution_proposals: 1,
      proposal_user_feedback: 1,
      human_handoffs: 0,
    },
  });
  assert.deepEqual(result.sourceMismatchPath, {
    scenario: "confirmed_source_missing_handoff",
    requestedSource: "NVE41300/04/zh-CN",
    evidenceVerdicts: ["not_answerable"],
    finalStatus: "awaiting_human",
    handoffReason: "insufficient_evidence",
    contentModelCallCount: 0,
    databaseCounts: {
      work_orders: 1,
      knowledge_search_runs: 1,
      evidence_assessments: 1,
      risk_assessments: 1,
      resolution_proposals: 0,
      proposal_user_feedback: 0,
      human_handoffs: 1,
    },
  });
});

test("R326：现场演示必须覆盖正常闭环、高危阻断、证据不足和越权隔离", async () => {
  assert.equal(
    typeof (projectDemo as Record<string, unknown>).runProjectDemoScenario,
    "function",
  );
  const runScenario = (
    projectDemo as unknown as {
      runProjectDemoScenario(
        scenario: string,
      ): Promise<{
        finalStatus: string;
        handoffReason: string | null;
        contentModelCallCount: number;
        databaseCounts: { resolution_proposals: number; human_handoffs: number };
      }>;
    }
  ).runProjectDemoScenario;

  const [highRisk, insufficientEvidence, unauthorized] = await Promise.all([
    runScenario("high_risk"),
    runScenario("insufficient_evidence"),
    runScenario("unauthorized_factory"),
  ]);

  assert.equal(highRisk.finalStatus, "awaiting_human");
  assert.equal(highRisk.handoffReason, "high_risk");
  assert.equal(highRisk.contentModelCallCount, 0);
  assert.equal(highRisk.databaseCounts.resolution_proposals, 0);
  assert.equal(highRisk.databaseCounts.human_handoffs, 1);

  assert.equal(insufficientEvidence.finalStatus, "awaiting_human");
  assert.equal(insufficientEvidence.handoffReason, "insufficient_evidence");
  assert.equal(insufficientEvidence.databaseCounts.resolution_proposals, 0);

  assert.equal(unauthorized.finalStatus, "investigating");
  assert.equal(unauthorized.handoffReason, null);
  assert.equal(unauthorized.databaseCounts.knowledge_search_runs, 0);
});
