import assert from "node:assert/strict";
import test from "node:test";

import { loadSourceIdentityUnseenV3Dataset } from "../src/evaluation/source-identity-unseen-v3-dataset.ts";

test("R307：第三批未见集必须同时覆盖语义等价、多候选顺序和来源覆盖", async () => {
  const dataset = await loadSourceIdentityUnseenV3Dataset();
  assert.equal(dataset.dataset_id, "source-identity-unseen-v3");
  assert.equal(dataset.strategy.judge_prompt_version, "answerability-v8-candidate-isolated");
  assert.equal(dataset.cases.length, 12);
  assert.equal(
    dataset.cases.filter(({ source_expectation }) => source_expectation === "mismatch").length,
    6,
  );
  assert.ok(dataset.cases.filter(({ candidate_keys }) => candidate_keys.length > 1).length >= 5);
  assert.ok(
    dataset.cases.filter(({ mismatch_dimensions }) =>
      mismatch_dimensions.includes("instruction_override"),
    ).length >= 4,
  );
  assert.ok(dataset.cases.some(({ question }) => /范围|方面|涵盖/.test(question)));
});
