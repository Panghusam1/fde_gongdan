import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("R276：已暴露问题回归必须在联网前冻结范围、旧报告与新代码", async () => {
  const raw = await readFile(
    "reports/work-order-end-to-end-regression-v3-prerun.json",
    "utf8",
  );
  const record = JSON.parse(raw) as {
    status: string;
    dataset_role: string;
    target_case_ids: string[];
    excluded_label_ambiguity_case_ids: string[];
    acceptance_target: { exact_case_count: number };
    frozen_inputs: Array<{ path: string; sha256: string }>;
  };
  assert.equal(record.status, "frozen_before_exposed_regression_run");
  assert.equal(record.dataset_role, "exposed_regression_not_unseen");
  assert.deepEqual(record.target_case_ids, ["E201", "E202", "E205"]);
  assert.deepEqual(record.excluded_label_ambiguity_case_ids, [
    "E203",
    "E204",
    "E206",
    "E207",
  ]);
  assert.equal(record.acceptance_target.exact_case_count, 3);
  assert.equal(record.frozen_inputs.length, 8);
  for (const item of record.frozen_inputs) {
    const content = await readFile(item.path);
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      item.sha256,
      `${item.path} changed after regression freeze`,
    );
  }
});
