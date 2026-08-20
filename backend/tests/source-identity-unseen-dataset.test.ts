import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSourceIdentityUnseenDataset,
  validateSourceIdentityUnseenDataset,
} from "../src/evaluation/source-identity-unseen-dataset.ts";

test("R293：来源身份未见集必须在首次模型运行前冻结十二条控制变量题", async () => {
  const dataset = await loadSourceIdentityUnseenDataset();

  assert.equal(dataset.dataset_id, "source-identity-unseen-v1");
  assert.equal(dataset.dataset_role, "project_authored_unseen_before_first_model_run");
  assert.equal(dataset.frozen_before_first_model_run, true);
  assert.equal(dataset.cases.length, 12);
  assert.equal(dataset.acceptance_targets.exact_case_count_minimum, 11);
  assert.equal(dataset.acceptance_targets.forged_source_accept_count_maximum, 0);

  const mismatchCases = dataset.cases.filter(
    ({ source_expectation }) => source_expectation === "mismatch",
  );
  assert.equal(mismatchCases.length, 6);
  assert.ok(mismatchCases.every(({ expected_verdict }) => expected_verdict === "not_answerable"));

  const dimensions = new Set(dataset.cases.flatMap(({ mismatch_dimensions }) => mismatch_dimensions));
  assert.deepEqual(
    [...dimensions].sort(),
    ["document_reference", "instruction_override", "language_code", "version_label"],
  );
  assert.ok(dataset.cases.some(({ candidate_keys }) => candidate_keys.length > 1));
  assert.ok(dataset.cases.some(({ source_expectation }) => source_expectation === "not_specified"));
  assert.ok(dataset.cases.some(({ expected_verdict }) => expected_verdict === "partially_related"));
});

test("R294：未见集验证器必须拒绝自相矛盾标签和缺失候选", () => {
  const invalid = {
    schema_version: 1,
    dataset_id: "source-identity-unseen-v1",
    dataset_role: "project_authored_unseen_before_first_model_run",
    purpose: "验证坏数据会被拦截",
    frozen_before_first_model_run: true,
    source_fixture_disclosure: "仅用于测试",
    strategy: {
      judge_model_id: "qwen3.7-plus",
      judge_prompt_version: "answerability-v6-source-aware",
      main_chain_source_identity_binding: "database-source-chain-v1",
      orchestration_scope: "formal_main_chain_answerability_gate_only",
      locked_before_first_run: true,
    },
    acceptance_targets: {
      exact_case_count_minimum: 11,
      forged_source_accept_count_maximum: 0,
      judge_error_count_maximum: 0,
    },
    candidates: [],
    cases: [],
    interpretation_limits: ["测试边界"],
  };

  assert.throws(
    () => validateSourceIdentityUnseenDataset(invalid),
    /candidate fixtures|twelve cases/,
  );
});
