import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frozenPaths = [
  "data/evaluation/source-identity-unseen-v1.json",
  "src/evaluation/source-identity-unseen-dataset.ts",
  "src/evaluation/source-identity-unseen-executor.ts",
  "src/evaluation/source-aware-work-order-judge.ts",
  "src/evaluation/qwen-answerability-judge.ts",
  "src/evaluation/qwen-answerability-judge-v5.ts",
  "src/evaluation/qwen-answerability-judge-v6.ts",
  "src/coordinator/work-order-main-chain.ts",
  "tests/source-identity-unseen-dataset.test.ts",
  "tests/source-identity-unseen-executor.test.ts",
  "tests/source-identity-unseen-prerun.test.ts",
  "tests/source-identity-unseen-real.integration.test.ts",
] as const;

test("R296：来源身份未见题、执行器和正式主链必须在首次模型运行前完成散列封存", async () => {
  const record = JSON.parse(
    await readFile("reports/source-identity-unseen-v1-prerun.json", "utf8"),
  ) as {
    status: string;
    dataset_role: string;
    first_model_run_completed: boolean;
    frozen_inputs: Array<{ path: string; sha256: string }>;
  };
  assert.equal(record.status, "frozen_before_first_model_run");
  assert.equal(record.dataset_role, "project_authored_unseen_not_production_data");
  assert.equal(record.first_model_run_completed, false);
  assert.equal(record.frozen_inputs.length, frozenPaths.length);
  for (const item of record.frozen_inputs) {
    assert.ok(frozenPaths.includes(item.path as (typeof frozenPaths)[number]));
    const actual = createHash("sha256")
      .update(await readFile(item.path))
      .digest("hex");
    assert.equal(actual, item.sha256, `${item.path} changed after freeze`);
  }
});
