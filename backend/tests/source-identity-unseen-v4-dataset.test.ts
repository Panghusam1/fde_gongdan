import assert from "node:assert/strict";
import test from "node:test";

import { loadSourceIdentityUnseenV4Dataset } from "../src/evaluation/source-identity-unseen-v4-dataset.ts";

test("R317：第四批未见集必须分离原始问题、确认内容和结构化来源", async () => {
  const dataset = await loadSourceIdentityUnseenV4Dataset();
  assert.equal(dataset.dataset_id, "source-identity-unseen-v4");
  assert.equal(dataset.strategy.source_constraint, "confirmed-source-exact-v1");
  assert.equal(dataset.cases.length, 12);
  assert.ok(
    dataset.cases.filter(({ expected_program_reject }) => expected_program_reject)
      .length >= 5,
  );
  assert.ok(
    dataset.cases.filter(({ raw_override_present }) => raw_override_present)
      .length >= 8,
  );
  for (const item of dataset.cases) {
    assert.notEqual(item.raw_question, item.confirmed_content_question);
    assert.equal(
      /NVE41300|NHA80940|zh-CN|en-US|第0?\d版/i.test(
        item.confirmed_content_question,
      ),
      false,
      `${item.case_id} confirmed question still contains source identity`,
    );
    assert.equal(
      item.expected_program_reject,
      item.expected_model_invoked === false,
      `${item.case_id} model-call expectation is inconsistent`,
    );
  }
});
