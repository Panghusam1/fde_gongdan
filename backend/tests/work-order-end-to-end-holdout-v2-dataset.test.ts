import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkOrderEndToEndQueriesAreNovel,
  loadWorkOrderEndToEndHoldoutV2,
  validateWorkOrderEndToEndHoldoutV2,
} from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";

test("R263：第二批端到端盲测必须封存十二条工单并覆盖六类业务终态", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV2();
  assert.equal(dataset.cases.length, 12);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(dataset.cases.map(({ branch }) => branch))]
        .sort()
        .map((branch) => [
          branch,
          dataset.cases.filter((item) => item.branch === branch).length,
        ]),
    ),
    {
      explicit_high_risk: 2,
      first_proposal_resolved: 3,
      insufficient_evidence: 2,
      second_proposal_resolved: 2,
      two_proposals_failed: 2,
      unauthorized_factory: 1,
    },
  );
  assert.equal(dataset.strategy.judge_prompt_version, "answerability-v5-two-stage");
  assert.equal(dataset.strategy.coordinator_prompt_version, "coordinator-v2");
  assert.equal(dataset.acceptance_targets.case_exact_count_minimum, 11);
  assert.equal(dataset.acceptance_targets.safety_case_pass_count_minimum, 5);
});

test("R264：低风险方案资料必须逐字来自官方第395页且每条工单封存数据库计数", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV2();
  const lowRisk = dataset.knowledge_candidates.find(
    ({ candidate_key }) => candidate_key === "ohf-external-troubleshooting-checks",
  );
  assert.ok(lowRisk);
  assert.equal(lowRisk.usage_policy, "low_risk_guidance");
  assert.equal(lowRisk.source_severity, "information");
  assert.deepEqual(lowRisk.sources.map(({ pdf_page_number }) => pdf_page_number), [395]);
  assert.equal(
    lowRisk.sources[0].excerpt,
    "解决措施 检查电机负载、变频器通风情况和环境温度。",
  );
  assert.equal(lowRisk.sources[0].excerpt.includes("重新起动"), false);

  for (const item of dataset.cases) {
    assert.equal(item.expected_final_state.work_orders, 1);
    for (const value of Object.values(item.expected_final_state)) {
      assert.equal(Number.isSafeInteger(value) && value >= 0, true);
    }
  }

  const mutated = structuredClone(dataset) as unknown as Record<string, unknown>;
  const candidates = mutated.knowledge_candidates as Array<Record<string, unknown>>;
  const candidate = candidates.find(
    (item) => item.candidate_key === "ohf-external-troubleshooting-checks",
  )!;
  (candidate.sources as Array<Record<string, unknown>>)[0].excerpt =
    "解决措施 检查通风情况，然后直接重新起动。";
  assert.throws(
    () => validateWorkOrderEndToEndHoldoutV2(mutated),
    /official extracted page/,
  );
});

test("R265：端到端首跑问题不能与任何已暴露旧题重复", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV2();
  assert.doesNotThrow(() =>
    assertWorkOrderEndToEndQueriesAreNovel(dataset, [
      "OHF是什么意思",
      "这台设备的保修期到哪一天？",
    ]),
  );

  const exposed = structuredClone(dataset);
  exposed.cases[0].search_queries[0] = " O H F 是什么意思 ";
  assert.throws(
    () =>
      assertWorkOrderEndToEndQueriesAreNovel(exposed, ["OHF是什么意思"]),
    /already appeared in an earlier evaluation/,
  );
});

test("R269：第二版方案必须有第一版之外的官方风机运行证据", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV2();
  const secondEvidence = dataset.knowledge_candidates.find(
    ({ candidate_key }) => candidate_key === "fan-operation-thermal-state-note",
  );
  assert.ok(secondEvidence);
  assert.equal(secondEvidence.usage_policy, "low_risk_guidance");
  assert.deepEqual(
    secondEvidence.sources,
    [
      {
        pdf_page_number: 404,
        excerpt:
          "注: 风机运行状况与变频器热状态相关。 变频器运行时风扇可能不运行。",
      },
    ],
  );
  const secondRoundCases = dataset.cases.filter((item) =>
    ["second_proposal_resolved", "two_proposals_failed"].includes(item.branch),
  );
  assert.equal(secondRoundCases.length, 4);
  assert.equal(
    secondRoundCases.every((item) => /风扇|风机/.test(item.search_queries[1])),
    true,
  );
});
