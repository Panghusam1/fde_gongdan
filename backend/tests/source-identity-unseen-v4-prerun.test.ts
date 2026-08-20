import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

export const sourceIdentityUnseenV4FrozenPaths = [
  "data/evaluation/source-identity-unseen-v4.json",
  "src/evaluation/source-identity-unseen-v4-dataset.ts",
  "src/evaluation/source-identity-unseen-executor-v4.ts",
  "src/evaluation/confirmed-source-work-order-judge.ts",
  "src/evaluation/qwen-answerability-judge-v8.ts",
  "src/evaluation/qwen-answerability-judge-v7.ts",
  "src/evaluation/qwen-answerability-judge-v6.ts",
  "src/evaluation/qwen-answerability-judge-v5.ts",
  "src/evaluation/qwen-answerability-judge.ts",
  "src/evaluation/source-aware-work-order-judge.ts",
  "src/coordinator/work-order-main-chain-v4.ts",
  "tests/confirmed-source-work-order-judge.test.ts",
  "tests/work-order-main-chain-v4.test.ts",
  "tests/source-identity-unseen-v4-dataset.test.ts",
  "tests/source-identity-unseen-executor-v4.test.ts",
  "tests/source-identity-unseen-v4-prerun.test.ts",
  "tests/source-identity-unseen-v4-real.integration.test.ts"
] as const;

test("R319：结构化来源第四批未见集必须在真实模型首跑前完成散列封存", async () => {
  const record = JSON.parse(
    await readFile("reports/source-identity-unseen-v4-prerun.json", "utf8"),
  ) as {
    status: string;
    first_model_run_completed: boolean;
    frozen_inputs: Array<{ path: string; sha256: string }>;
  };
  assert.equal(record.status, "frozen_before_first_model_run");
  assert.equal(record.first_model_run_completed, false);
  assert.equal(record.frozen_inputs.length, sourceIdentityUnseenV4FrozenPaths.length);
  for (const item of record.frozen_inputs) {
    assert.ok(
      sourceIdentityUnseenV4FrozenPaths.includes(
        item.path as (typeof sourceIdentityUnseenV4FrozenPaths)[number],
      ),
    );
    const actual = createHash("sha256")
      .update(await readFile(item.path))
      .digest("hex");
    assert.equal(actual, item.sha256, `${item.path} changed after freeze`);
  }
});
