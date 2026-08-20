import assert from "node:assert/strict";
import test from "node:test";

test("R189：正式检索题库必须有40题并覆盖六个知识片段与两类拒答", async () => {
  const { loadRetrievalEvaluationDataset } = await import(
    "../src/retrieval/retrieval-evaluation-dataset.ts"
  );
  const dataset = await loadRetrievalEvaluationDataset({
    datasetPath: "data/evaluation/ohf-retrieval-cases-v2.json",
    candidateManifestPath:
      "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
  });

  assert.equal(dataset.cases.length, 40);
  const hitCases = dataset.cases.filter((item) => item.expected_behavior === "hit");
  const abstainCases = dataset.cases.filter(
    (item) => item.expected_behavior === "abstain",
  );
  assert.equal(hitCases.length, 30);
  assert.equal(abstainCases.length, 10);
  assert.equal(
    dataset.cases.filter((item) => item.scope_class === "out_of_scope").length,
    5,
  );
  assert.equal(
    dataset.cases.filter((item) => item.scope_class === "unanswerable").length,
    5,
  );

  const countsByCandidate = new Map<string, number>();
  for (const item of hitCases) {
    countsByCandidate.set(
      item.expected_candidate_key!,
      (countsByCandidate.get(item.expected_candidate_key!) ?? 0) + 1,
    );
  }
  assert.deepEqual([...countsByCandidate.values()].sort(), [5, 5, 5, 5, 5, 5]);
  assert.deepEqual(
    [...new Set(dataset.cases.map((item) => item.language_style))].sort(),
    ["colloquial", "exact_term", "paraphrase"],
  );
});

test("R190：正式检索题库必须逐题绑定官方候选来源或明确拒答理由", async () => {
  const { loadRetrievalEvaluationDataset } = await import(
    "../src/retrieval/retrieval-evaluation-dataset.ts"
  );
  const dataset = await loadRetrievalEvaluationDataset({
    datasetPath: "data/evaluation/ohf-retrieval-cases-v2.json",
    candidateManifestPath:
      "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
  });

  for (const item of dataset.cases) {
    if (item.expected_behavior === "hit") {
      assert.equal(item.source_basis.candidate_key, item.expected_candidate_key);
      assert.ok(item.source_basis.pdf_pages.length > 0);
    } else {
      assert.equal(item.expected_candidate_key, null);
      assert.ok(item.source_basis.reason.trim().length > 0);
    }
  }
});

test("R191：矛盾标签、未知候选和伪造页码必须在评测前拒绝", async () => {
  const { validateRetrievalEvaluationDataset } = await import(
    "../src/retrieval/retrieval-evaluation-dataset.ts"
  );
  const candidates = new Map([["known", new Set([72])]]);
  const base = {
    schema_version: 2,
    dataset_id: "invalid-fixture",
    purpose: "验证错误数据",
    product_family_code: "ATV320",
    changes_knowledge_approval_status: false,
    cases: [],
  };

  assert.throws(
    () =>
      validateRetrievalEvaluationDataset(
        {
          ...base,
          cases: [
            {
              case_id: "Q01",
              query: "测试",
              language_style: "exact_term",
              risk_class: "reference",
              scope_class: "in_scope",
              expected_behavior: "hit",
              expected_candidate_key: "missing",
              source_basis: { candidate_key: "missing", pdf_pages: [72] },
            },
          ],
        },
        candidates,
      ),
    /unknown candidate/,
  );
  assert.throws(
    () =>
      validateRetrievalEvaluationDataset(
        {
          ...base,
          cases: [
            {
              case_id: "Q01",
              query: "测试",
              language_style: "exact_term",
              risk_class: "reference",
              scope_class: "in_scope",
              expected_behavior: "hit",
              expected_candidate_key: "known",
              source_basis: { candidate_key: "known", pdf_pages: [999] },
            },
          ],
        },
        candidates,
      ),
    /source page/,
  );
});
