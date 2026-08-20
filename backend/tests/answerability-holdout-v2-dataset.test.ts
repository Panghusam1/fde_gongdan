import assert from "node:assert/strict";
import test from "node:test";

async function loadDatasetModule() {
  try {
    return await import("../src/evaluation/answerability-holdout-v2-dataset.ts");
  } catch {
    assert.fail("第二版答案存在性未见题库加载器尚未实现");
  }
}

test("R217：新未见题库必须36题、正负平衡、六候选全覆盖且与旧题无重复", async () => {
  const { loadAnswerabilityHoldoutV2 } = await loadDatasetModule();
  const dataset = await loadAnswerabilityHoldoutV2();

  assert.equal(dataset.dataset_id, "ohf-answerability-holdout-v2");
  assert.equal(dataset.dataset_role, "unseen_holdout_before_first_run");
  assert.equal(dataset.frozen_before_first_model_run, true);
  assert.equal(dataset.strategy.locked_before_first_run, true);
  assert.equal(dataset.strategy.candidate_limit, 5);
  assert.equal(dataset.cases.length, 36);
  assert.equal(
    dataset.cases.filter(({ expected_behavior }) => expected_behavior === "hit").length,
    18,
  );
  assert.equal(
    dataset.cases.filter(({ expected_behavior }) => expected_behavior === "abstain").length,
    18,
  );
  const counts = new Map<string, number>();
  for (const item of dataset.cases) {
    if (item.expected_candidate_key) {
      counts.set(
        item.expected_candidate_key,
        (counts.get(item.expected_candidate_key) ?? 0) + 1,
      );
    }
  }
  assert.deepEqual([...counts.values()].sort(), [3, 3, 3, 3, 3, 3]);
});

test("R218：未知候选、伪造页码、矛盾拒答标签和重复旧问题必须在模型运行前拒绝", async () => {
  const { validateAnswerabilityHoldoutV2 } = await loadDatasetModule();
  const validCase = {
    case_id: "X01",
    query: "一个新问题",
    expected_behavior: "hit" as const,
    expected_candidate_key: "known",
    expected_pdf_pages: [72],
  };
  const base = {
    schema_version: 1,
    dataset_id: "test",
    purpose: "test",
    dataset_role: "unseen_holdout_before_first_run",
    product_family_code: "ATV320",
    frozen_before_first_model_run: true,
    changes_knowledge_approval_status: false,
    strategy: {
      strategy_id: "test",
      candidate_limit: 5,
      embedding_model_id: "e5",
      embedding_model_revision: "rev",
      judge_model_id: "qwen",
      judge_prompt_version: "answerability-v1",
      locked_before_first_run: true,
    },
    acceptance_targets: {
      answerable_correct_accept_rate_minimum: 0.9,
      unanswerable_abstain_accuracy_minimum: 1,
      accepted_precision_minimum: 0.9,
      judge_error_count_maximum: 0,
    },
    cases: [validCase],
  };
  const candidatePages = new Map([["known", new Set([72])]]);
  const oldQueries = new Set(["已经用过的问题"]);

  assert.throws(
    () =>
      validateAnswerabilityHoldoutV2(
        { ...base, cases: [{ ...validCase, expected_candidate_key: "missing" }] },
        candidatePages,
        oldQueries,
        { enforceProductionShape: false },
      ),
    /unknown candidate/,
  );
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV2(
        { ...base, cases: [{ ...validCase, expected_pdf_pages: [999] }] },
        candidatePages,
        oldQueries,
        { enforceProductionShape: false },
      ),
    /forged candidate pages/,
  );
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV2(
        {
          ...base,
          cases: [
            {
              ...validCase,
              expected_behavior: "abstain",
              expected_candidate_key: "known",
              expected_pdf_pages: [],
              abstain_reason: "没有答案",
            },
          ],
        },
        candidatePages,
        oldQueries,
        { enforceProductionShape: false },
      ),
    /abstain case cannot expect a candidate/,
  );
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV2(
        { ...base, cases: [{ ...validCase, query: "已经用过的问题" }] },
        candidatePages,
        oldQueries,
        { enforceProductionShape: false },
      ),
    /repeats an earlier query/,
  );
});
