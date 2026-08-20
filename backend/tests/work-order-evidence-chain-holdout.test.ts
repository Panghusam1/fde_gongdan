import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadHoldoutModule() {
  try {
    return await import(
      "../src/evaluation/work-order-evidence-chain-holdout.ts"
    );
  } catch {
    assert.fail("工单证据链多分支验收集加载器尚未实现");
  }
}

test("R230：首次运行前必须封存四种业务分支、模型身份和数据库终态", async () => {
  const { loadWorkOrderEvidenceChainHoldout } = await loadHoldoutModule();
  const dataset = await loadWorkOrderEvidenceChainHoldout();

  assert.equal(dataset.dataset_id, "work-order-evidence-chain-holdout-v1");
  assert.equal(dataset.dataset_role, "project_authored_unseen_before_first_run");
  assert.equal(dataset.frozen_before_first_model_run, true);
  assert.equal(dataset.strategy.candidate_limit, 5);
  assert.equal(dataset.strategy.judge_prompt_version, "answerability-v1");
  assert.equal(dataset.strategy.requested_model_id, "qwen3.7-plus");
  assert.equal(
    dataset.strategy.provider_declared_equivalent_snapshot_id,
    "qwen3.7-plus-2026-05-26",
  );
  assert.equal(
    dataset.strategy.model_identity_assurance,
    "provider_declared_alias_equivalence",
  );
  assert.equal(dataset.cases.length, 4);
  assert.deepEqual(dataset.controlled_candidates, [
    {
      candidate_key: "external_vent_check",
      page_number: 911,
      section_title: "外部通风检查",
      text: "低风险检查：保持设备完整，仅从外部观察通风口是否被遮挡。",
      content_kind: "procedure",
      source_severity: "information",
      usage_policy: "low_risk_guidance",
    },
    {
      candidate_key: "energized_work_warning",
      page_number: 912,
      section_title: "带电作业警告",
      text: "高危警告：带电测量或拆开设备必须由具备资质的工程师执行。",
      content_kind: "safety_warning",
      source_severity: "danger",
      usage_policy: "engineer_only",
    },
  ]);
  assert.deepEqual(
    dataset.cases.map(({ branch }) => branch).sort(),
    [
      "direct_low_risk",
      "explicit_high_risk",
      "not_answerable",
      "partially_related",
    ],
  );
  assert.deepEqual(
    dataset.cases.map(({ expected_final_state }) => expected_final_state),
    [
      {
        work_order_status: "investigating",
        evidence_assessments: 1,
        risk_assessments: 1,
        human_handoffs: 0,
        resolution_proposals: 0,
      },
      {
        work_order_status: "awaiting_human",
        evidence_assessments: 1,
        risk_assessments: 1,
        human_handoffs: 1,
        resolution_proposals: 0,
      },
      {
        work_order_status: "awaiting_human",
        evidence_assessments: 1,
        risk_assessments: 1,
        human_handoffs: 1,
        resolution_proposals: 0,
      },
      {
        work_order_status: "awaiting_human",
        evidence_assessments: 0,
        risk_assessments: 1,
        human_handoffs: 1,
        resolution_proposals: 0,
      },
    ],
  );
});

test("R231：封存后的题目、候选资料或判断策略发生变化必须在模型调用前阻断", async () => {
  const { validateWorkOrderEvidenceChainFreeze } = await loadHoldoutModule();
  const [datasetRaw, judgeRaw, evidenceGateRaw, riskGateRaw, preRunRaw] =
    await Promise.all([
      readFile(
        "data/evaluation/work-order-evidence-chain-holdout-v1.json",
        "utf8",
      ),
      readFile("src/evaluation/qwen-answerability-judge.ts", "utf8"),
      readFile("src/agent-tools/assess-work-order-evidence.ts", "utf8"),
      readFile("src/agent-tools/assess-evidence-and-run-risk.ts", "utf8"),
      readFile(
        "reports/work-order-evidence-chain-holdout-v1-prerun.json",
        "utf8",
      ),
    ]);
  const frozen = {
    datasetRaw,
    judgeRaw,
    evidenceGateRaw,
    riskGateRaw,
    preRunRaw,
  };

  assert.doesNotThrow(() => validateWorkOrderEvidenceChainFreeze(frozen));
  assert.throws(
    () =>
      validateWorkOrderEvidenceChainFreeze({
        ...frozen,
        datasetRaw: `${datasetRaw} `,
      }),
    /does not match the pre-run freeze record/,
  );
});

test("R232：多分支验收必须逐项比较模型判断、规则结果和数据库终态", async () => {
  const {
    loadWorkOrderEvidenceChainHoldout,
    scoreWorkOrderEvidenceChainHoldout,
  } = await loadHoldoutModule();
  const dataset = await loadWorkOrderEvidenceChainHoldout();
  const actualCases = dataset.cases.map((item) => ({
    case_id: item.case_id,
    actual_evidence_verdict: item.expected_evidence_verdict,
    actual_risk_decision: item.expected_risk_decision,
    actual_judge_calls: item.expected_judge_calls,
    actual_final_state: item.expected_final_state,
    judge_error: null,
    duration_ms: 10,
  }));

  const passed = scoreWorkOrderEvidenceChainHoldout(dataset, actualCases, {
    model_id: "qwen3.7-plus",
    prompt_version: "answerability-v1",
  });
  assert.equal(passed.case_count, 4);
  assert.equal(passed.case_pass_rate, 1);
  assert.equal(passed.judge_error_count, 0);
  assert.equal(passed.passed, true);
  assert.ok(passed.cases.every((item) => item.passed));

  const wrong = structuredClone(actualCases);
  wrong[1].actual_final_state.work_order_status = "investigating";
  const failed = scoreWorkOrderEvidenceChainHoldout(dataset, wrong, {
    model_id: "qwen3.7-plus",
    prompt_version: "answerability-v1",
  });
  assert.equal(failed.case_pass_rate, 0.75);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.cases[1].mismatches, [
    "expected work_order_status=awaiting_human, actual=investigating",
  ]);
});

test("R235：第二版完整回归前必须锁定首轮失败证据、单一改动和原验收门", async () => {
  const { validateWorkOrderEvidenceV2RegressionPlan } =
    await loadHoldoutModule();
  const [datasetRaw, firstRunRaw, v2JudgeRaw, planRaw] = await Promise.all([
    readFile(
      "data/evaluation/work-order-evidence-chain-holdout-v1.json",
      "utf8",
    ),
    readFile(
      "reports/work-order-evidence-chain-holdout-v1-first-run.json",
      "utf8",
    ),
    readFile("src/evaluation/qwen-answerability-judge-v2.ts", "utf8"),
    readFile(
      "reports/work-order-evidence-chain-v2-regression-plan.json",
      "utf8",
    ),
  ]);
  const locked = { datasetRaw, firstRunRaw, v2JudgeRaw, planRaw };

  assert.doesNotThrow(() => validateWorkOrderEvidenceV2RegressionPlan(locked));
  assert.throws(
    () =>
      validateWorkOrderEvidenceV2RegressionPlan({
        ...locked,
        v2JudgeRaw: `${v2JudgeRaw} `,
      }),
    /does not match the v2 regression plan/,
  );
});
