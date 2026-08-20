import assert from "node:assert/strict";
import test from "node:test";

async function loadDatasetModule() {
  try {
    return await import(
      "../src/evaluation/answerability-holdout-v3-dataset.ts"
    );
  } catch {
    assert.fail("第二版三分类新未见题库加载器尚未实现");
  }
}

test("R237：第二版新未见集必须18题三类平衡并让六份官方候选各覆盖直接与部分相关", async () => {
  const { loadAnswerabilityHoldoutV3 } = await loadDatasetModule();
  const dataset = await loadAnswerabilityHoldoutV3();

  assert.equal(dataset.dataset_id, "ohf-answerability-holdout-v3");
  assert.equal(dataset.dataset_role, "unseen_holdout_before_first_run");
  assert.equal(dataset.frozen_before_first_model_run, true);
  assert.equal(dataset.strategy.candidate_limit, 5);
  assert.equal(dataset.strategy.judge_prompt_version, "answerability-v2");
  assert.equal(dataset.cases.length, 18);
  assert.deepEqual(
    Object.fromEntries(
      ["directly_answerable", "partially_related", "not_answerable"].map(
        (verdict) => [
          verdict,
          dataset.cases.filter(
            ({ expected_verdict }) => expected_verdict === verdict,
          ).length,
        ],
      ),
    ),
    {
      directly_answerable: 6,
      partially_related: 6,
      not_answerable: 6,
    },
  );
  const candidateCoverage = new Map<string, Set<string>>();
  for (const item of dataset.cases) {
    if (item.expected_candidate_key === null) continue;
    const verdicts = candidateCoverage.get(item.expected_candidate_key) ??
      new Set<string>();
    verdicts.add(item.expected_verdict);
    candidateCoverage.set(item.expected_candidate_key, verdicts);
  }
  assert.equal(candidateCoverage.size, 6);
  assert.ok(
    [...candidateCoverage.values()].every(
      (verdicts) =>
        verdicts.has("directly_answerable") &&
        verdicts.has("partially_related") &&
        verdicts.size === 2,
    ),
  );
  assert.deepEqual(dataset.acceptance_targets, {
    overall_exact_accuracy_minimum: 17 / 18,
    per_class_accuracy_minimum: 5 / 6,
    unsafe_direct_accept_count_maximum: 0,
    judge_error_count_maximum: 0,
  });
});

test("R238：六道无答案题必须共享表面词但属于不同业务单元，不能用简单无关题刷拒答率", async () => {
  const { loadAnswerabilityHoldoutV3 } = await loadDatasetModule();
  const dataset = await loadAnswerabilityHoldoutV3();
  const negatives = dataset.cases.filter(
    ({ expected_verdict }) => expected_verdict === "not_answerable",
  );

  assert.equal(negatives.length, 6);
  for (const item of negatives) {
    assert.equal(
      item.boundary_kind,
      "same_surface_terms_different_business_unit",
    );
    assert.ok(Array.isArray(item.surface_overlap_terms));
    assert.ok(item.surface_overlap_terms.length > 0);
    assert.ok(
      item.surface_overlap_terms.every(
        (term) => typeof term === "string" && item.query.includes(term),
      ),
    );
  }
});
