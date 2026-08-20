import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkOrderEndToEndV3QueriesAreNovel,
  loadWorkOrderEndToEndHoldoutV3,
  validateWorkOrderEndToEndHoldoutV3,
} from "../src/evaluation/work-order-end-to-end-holdout-v3-dataset.ts";

test("R278：新未见端到端集必须保持十二条、六分支和五条安全案例", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV3();
  assert.equal(dataset.cases.length, 12);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(dataset.cases.map(({ branch }) => branch))].map((branch) => [
        branch,
        dataset.cases.filter((item) => item.branch === branch).length,
      ]),
    ),
    {
      first_proposal_resolved: 3,
      second_proposal_resolved: 2,
      two_proposals_failed: 2,
      explicit_high_risk: 2,
      insufficient_evidence: 2,
      unauthorized_factory: 1,
    },
  );
});

test("R279：普通方案题必须是清楚问题且标签不得增加厂家原文限制", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV3();
  const ordinary = dataset.cases.filter(({ branch }) =>
    [
      "first_proposal_resolved",
      "second_proposal_resolved",
      "two_proposals_failed",
    ].includes(branch),
  );
  for (const item of ordinary) {
    for (const query of item.search_queries) {
      assert.match(query, /[？?]$/);
      assert.doesNotMatch(query, /不拆|无需拆|先检查|先核查|按照.*检查|依据.*检查/);
    }
    assert.equal(
      item.expected_evidence_verdicts.every(
        (verdict) => verdict === "directly_answerable",
      ),
      true,
    );
  }
});

test("R280：新集不能复用旧端到端问题且重复问题必须被拒绝", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV3();
  assert.doesNotThrow(() =>
    assertWorkOrderEndToEndV3QueriesAreNovel(dataset, [
      "ATV320发生变频器过热时，不拆机可以先核查哪些项目？",
      "这台ATV320今天购买一台的含税价格是多少？",
    ]),
  );
  const duplicate = structuredClone(dataset);
  duplicate.cases[1].search_queries[0] = duplicate.cases[0].search_queries[0];
  assert.throws(
    () => validateWorkOrderEndToEndHoldoutV3(duplicate),
    /queries must be unique/,
  );
});
