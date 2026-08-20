import assert from "node:assert/strict";
import test from "node:test";

import { loadSourceIdentityUnseenV2Dataset } from "../src/evaluation/source-identity-unseen-v2-dataset.ts";

test("R300：第二批未见集必须冻结十二条新题并覆盖六种用户覆盖来源身份的表达", async () => {
  const dataset = await loadSourceIdentityUnseenV2Dataset();
  assert.equal(dataset.dataset_id, "source-identity-unseen-v2");
  assert.equal(dataset.strategy.judge_prompt_version, "answerability-v7-source-policy");
  assert.equal(dataset.cases.length, 12);
  const mismatchCases = dataset.cases.filter(
    ({ source_expectation }) => source_expectation === "mismatch",
  );
  assert.equal(mismatchCases.length, 6);
  assert.ok(
    mismatchCases.every(({ mismatch_dimensions }) =>
      mismatch_dimensions.includes("instruction_override"),
    ),
  );
  assert.equal(
    new Set(dataset.cases.map(({ question }) => question)).size,
    dataset.cases.length,
  );
});
