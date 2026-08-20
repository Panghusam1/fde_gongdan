import assert from "node:assert/strict";
import test from "node:test";

async function loadDatasetModule() {
  try {
    return await import(
      "../src/evaluation/answerability-holdout-v4-dataset.ts"
    );
  } catch {
    assert.fail("带可接受证据集合的第三批未见题库加载器尚未实现");
  }
}

test("R258：第三批未见集必须18题三类平衡并为六份候选各安排直接与部分相关题", async () => {
  const { loadAnswerabilityHoldoutV4 } = await loadDatasetModule();
  const dataset = await loadAnswerabilityHoldoutV4();

  assert.equal(dataset.dataset_id, "ohf-answerability-holdout-v4");
  assert.equal(dataset.dataset_role, "unseen_holdout_before_first_run");
  assert.equal(
    dataset.source_data_role,
    "official_manual_excerpts_not_domain_engineer_approved",
  );
  assert.equal(dataset.strategy.judge_prompt_version, "answerability-v5-two-stage");
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
  const primaryCoverage = new Map<string, Set<string>>();
  for (const item of dataset.cases) {
    if (item.primary_candidate_key === null) continue;
    const verdicts = primaryCoverage.get(item.primary_candidate_key) ??
      new Set<string>();
    verdicts.add(item.expected_verdict);
    primaryCoverage.set(item.primary_candidate_key, verdicts);
  }
  assert.equal(primaryCoverage.size, 6);
  assert.ok(
    [...primaryCoverage.values()].every(
      (verdicts) =>
        verdicts.has("directly_answerable") &&
        verdicts.has("partially_related") &&
        verdicts.size === 2,
    ),
  );
  assert.deepEqual(dataset.acceptance_targets, {
    overall_verdict_accuracy_minimum: 17 / 18,
    per_class_verdict_accuracy_minimum: 5 / 6,
    overall_adjudicated_exact_accuracy_minimum: 17 / 18,
    per_class_adjudicated_exact_accuracy_minimum: 5 / 6,
    unsafe_direct_accept_count_maximum: 0,
    judge_error_count_maximum: 0,
  });
});

test("R259：非拒答题必须预先保存可接受证据集合，无答案题必须保存跨业务表面词陷阱", async () => {
  const { loadAnswerabilityHoldoutV4 } = await loadDatasetModule();
  const dataset = await loadAnswerabilityHoldoutV4();

  for (const item of dataset.cases) {
    if (item.expected_verdict === "not_answerable") {
      assert.equal(item.primary_candidate_key, null);
      assert.deepEqual(item.acceptable_evidence, []);
      assert.equal(
        item.boundary_kind,
        "same_surface_terms_different_business_unit",
      );
      assert.ok(item.surface_overlap_terms.length > 0);
      assert.ok(
        item.surface_overlap_terms.every((term) => item.query.includes(term)),
      );
      continue;
    }
    assert.ok(item.acceptable_evidence.length > 0);
    assert.ok(
      item.acceptable_evidence.some(
        ({ candidate_key }) => candidate_key === item.primary_candidate_key,
      ),
    );
    assert.equal(
      new Set(item.acceptable_evidence.map(({ candidate_key }) => candidate_key))
        .size,
      item.acceptable_evidence.length,
    );
    assert.ok(
      item.acceptable_evidence.every(({ pdf_pages }) => pdf_pages.length > 0),
    );
  }
  assert.ok(
    dataset.cases.some(({ acceptable_evidence }) =>
      acceptable_evidence.length > 1
    ),
    "题库必须在首跑前真实包含至少一道多合理证据题",
  );
});
