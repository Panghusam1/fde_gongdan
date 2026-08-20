import assert from "node:assert/strict";
import test from "node:test";

test("R195：二次排序评测只对可回答题计算命中并保留拒答题原始得分", async () => {
  const { evaluateReranker } = await import(
    "../src/evaluation/reranker-evaluation.ts"
  );
  const report = await evaluateReranker({
    reranker: {
      modelId: "fake-reranker",
      async rerank(query, documents) {
        return query.includes("复位")
          ? [
              { index: 1, relevanceScore: 0.9 },
              { index: 0, relevanceScore: 0.3 },
            ]
          : documents.map((_, index) => ({ index, relevanceScore: 0.5 }));
      },
    },
    documents: new Map([
      ["definition", "OHF表示设备过热"],
      ["reset", "原因消失后可以手动复位OHF"],
    ]),
    cases: [
      {
        caseId: "Q01",
        query: "OHF怎么复位",
        expectedId: "reset",
        candidateIds: ["definition", "reset"],
      },
      {
        caseId: "Q02",
        query: "ATV320市场价格",
        expectedId: null,
        candidateIds: ["definition", "reset"],
      },
    ],
  });

  assert.equal(report.caseCount, 2);
  assert.equal(report.answerableCaseCount, 1);
  assert.equal(report.validOutputRate, 1);
  assert.equal(report.answerableHitAt1, 1);
  assert.equal(report.cases[1].scores.length, 2);
});

