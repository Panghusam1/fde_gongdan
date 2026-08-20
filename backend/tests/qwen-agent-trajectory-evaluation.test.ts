import assert from "node:assert/strict";
import test from "node:test";

async function loadEvaluationModule() {
  try {
    return await import("../src/evaluation/agent-trajectory-evaluation.ts");
  } catch {
    assert.fail("Agent轨迹评测器尚未实现");
  }
}

test("R184：版本化数据集必须包含20条多轮轨迹并覆盖关键业务分支", async () => {
  const { loadAgentTrajectorySuite } = await loadEvaluationModule();
  const suite = await loadAgentTrajectorySuite(
    "data/evaluation/qwen-agent-trajectories-v1.json",
  );

  assert.equal(suite.datasetId, "atv320-qwen-agent-trajectories-v1");
  assert.equal(suite.version, 1);
  assert.equal(suite.cases.length, 20);
  assert.ok(suite.cases.every((scenario: { turns: unknown[] }) => scenario.turns.length >= 2));
  assert.ok(
    suite.cases.reduce(
      (total: number, scenario: { turns: unknown[] }) => total + scenario.turns.length,
      0,
    ) >= 40,
  );
  assert.deepEqual(
    new Set(suite.cases.map((scenario: { category: string }) => scenario.category)),
    new Set([
      "normal_resolution",
      "observation_capture",
      "first_failure_second_plan",
      "two_failed_handoff",
      "high_risk",
      "insufficient_evidence",
      "prompt_injection",
      "scope_conflict",
    ]),
  );
  assert.deepEqual(suite.thresholds, {
    validOutputRate: 1,
    actionAccuracy: 0.9,
    parameterAccuracy: 0.85,
    trajectoryPassRate: 0.8,
  });
});

test("R185：评测器必须逐轮评分并把参数错误归到具体轨迹", async () => {
  const { evaluateAgentTrajectories } = await loadEvaluationModule();
  const suite = {
    datasetId: "unit-agent-trajectories",
    version: 1,
    purpose: "验证评测器本身",
    modelInputMode: "database_context_each_turn",
    thresholds: {
      validOutputRate: 1,
      actionAccuracy: 1,
      parameterAccuracy: 1,
      trajectoryPassRate: 1,
    },
    cases: [
      {
        caseId: "unit-01",
        category: "normal_resolution",
        title: "全部正确",
        turns: [
          {
            turnId: "unit-01-turn-01",
            userMessage: "查询资料",
            allowedActions: ["search_official_knowledge"],
            workOrderContext: { status: "investigating" },
            expected: {
              action: "search_official_knowledge",
              nonEmptyTextFields: ["queryText"],
            },
          },
          {
            turnId: "unit-01-turn-02",
            userMessage: "执行风险判断",
            allowedActions: ["run_risk_assessment"],
            workOrderContext: { latestSearch: { searchRunId: 51 } },
            expected: {
              action: "run_risk_assessment",
              exactFields: { searchRunId: 51 },
            },
          },
        ],
      },
      {
        caseId: "unit-02",
        category: "observation_capture",
        title: "第二轮参数错误",
        turns: [
          {
            turnId: "unit-02-turn-01",
            userMessage: "记录症状",
            allowedActions: ["append_observation"],
            workOrderContext: { status: "investigating" },
            expected: {
              action: "append_observation",
              exactFields: { observationType: "symptom" },
              nonEmptyTextFields: ["content"],
            },
          },
          {
            turnId: "unit-02-turn-02",
            userMessage: "再次查询",
            allowedActions: ["search_official_knowledge"],
            workOrderContext: { status: "investigating" },
            expected: {
              action: "search_official_knowledge",
              nonEmptyTextFields: ["queryText"],
            },
          },
        ],
      },
    ],
  };
  const decisions = new Map<string, Record<string, unknown>>([
    ["查询资料", { action: "search_official_knowledge", queryText: "OHF资料" }],
    ["执行风险判断", { action: "run_risk_assessment", searchRunId: 51 }],
    ["记录症状", { action: "append_observation", observationType: "symptom", content: "OHF" }],
    ["再次查询", { action: "search_official_knowledge", queryText: "" }],
  ]);
  const model = {
    modelId: "fake-model",
    promptVersion: "fake-prompt",
    async decide(input: { userMessage: string }) {
      return decisions.get(input.userMessage)!;
    },
  };

  const report = await evaluateAgentTrajectories(model, suite);

  assert.deepEqual(
    {
      trajectoryCount: report.metrics.trajectoryCount,
      turnCount: report.metrics.turnCount,
      validOutputRate: report.metrics.validOutputRate,
      actionAccuracy: report.metrics.actionAccuracy,
      parameterAccuracy: report.metrics.parameterAccuracy,
      trajectoryPassRate: report.metrics.trajectoryPassRate,
      passed: report.passed,
    },
    {
      trajectoryCount: 2,
      turnCount: 4,
      validOutputRate: 1,
      actionAccuracy: 1,
      parameterAccuracy: 0.75,
      trajectoryPassRate: 0.5,
      passed: false,
    },
  );
  assert.equal(report.cases[0].passed, true);
  assert.equal(report.cases[1].passed, false);
  assert.match(report.cases[1].turns[1].failures.join(" "), /queryText/);
});

test("R186：重复编号或期待动作不在许可表中的数据集必须拒绝", async () => {
  const { validateAgentTrajectorySuite } = await loadEvaluationModule();
  const invalid = {
    datasetId: "invalid-suite",
    version: 1,
    purpose: "错误数据",
    modelInputMode: "database_context_each_turn",
    thresholds: {
      validOutputRate: 1,
      actionAccuracy: 0.9,
      parameterAccuracy: 0.85,
      trajectoryPassRate: 0.8,
    },
    cases: [
      {
        caseId: "duplicate",
        category: "normal_resolution",
        title: "错误一",
        turns: [
          {
            turnId: "same-turn",
            userMessage: "继续",
            allowedActions: ["append_observation"],
            workOrderContext: {},
            expected: { action: "search_official_knowledge" },
          },
          {
            turnId: "same-turn",
            userMessage: "继续",
            allowedActions: ["append_observation"],
            workOrderContext: {},
            expected: { action: "append_observation" },
          },
        ],
      },
      {
        caseId: "duplicate",
        category: "normal_resolution",
        title: "错误二",
        turns: [],
      },
    ],
  };

  assert.throws(
    () => validateAgentTrajectorySuite(invalid),
    /duplicate case id|duplicate turn id|expected action must be allowed|at least two turns/,
  );
});
