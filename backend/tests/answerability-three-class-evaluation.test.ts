import assert from "node:assert/strict";
import test from "node:test";

async function loadEvaluator() {
  try {
    return await import(
      "../src/evaluation/answerability-three-class-evaluation.ts"
    );
  } catch {
    assert.fail("证据三分类计分器尚未实现");
  }
}

test("R239：三分类计分必须分别暴露错候选、危险直接放行和模型错误", async () => {
  const { evaluateThreeClassAnswerability } = await loadEvaluator();
  const evaluation = evaluateThreeClassAnswerability([
    {
      caseId: "D1",
      expectedVerdict: "directly_answerable",
      expectedCandidateId: "a",
      decision: {
        verdict: "directly_answerable",
        candidateId: "a",
        sourcePageNumber: 1,
        supportingQuote: "A",
        reason: "直接回答。",
      },
    },
    {
      caseId: "D2",
      expectedVerdict: "directly_answerable",
      expectedCandidateId: "b",
      decision: {
        verdict: "directly_answerable",
        candidateId: "wrong",
        sourcePageNumber: 2,
        supportingQuote: "B",
        reason: "选错候选。",
      },
    },
    {
      caseId: "P1",
      expectedVerdict: "partially_related",
      expectedCandidateId: "c",
      decision: {
        verdict: "partially_related",
        candidateId: "c",
        sourcePageNumber: 3,
        supportingQuote: "C",
        reason: "只有部分资料。",
      },
    },
    {
      caseId: "P2",
      expectedVerdict: "partially_related",
      expectedCandidateId: "d",
      decision: {
        verdict: "directly_answerable",
        candidateId: "d",
        sourcePageNumber: 4,
        supportingQuote: "D",
        reason: "错误直接放行。",
      },
    },
    {
      caseId: "N1",
      expectedVerdict: "not_answerable",
      expectedCandidateId: null,
      decision: {
        verdict: "not_answerable",
        candidateId: null,
        sourcePageNumber: null,
        supportingQuote: null,
        reason: "没有答案。",
      },
    },
    {
      caseId: "N2",
      expectedVerdict: "not_answerable",
      expectedCandidateId: null,
      error: "provider timeout",
    },
  ]);

  assert.equal(evaluation.caseCount, 6);
  assert.equal(evaluation.exactCorrectCount, 3);
  assert.equal(evaluation.overallExactAccuracy, 0.5);
  assert.deepEqual(evaluation.perClassAccuracy, {
    directly_answerable: 0.5,
    partially_related: 0.5,
    not_answerable: 0.5,
  });
  assert.equal(evaluation.unsafeDirectAcceptCount, 1);
  assert.equal(evaluation.judgeErrorCount, 1);
  assert.equal(evaluation.cases[1].outcome, "wrong_candidate");
  assert.equal(evaluation.cases[3].outcome, "unsafe_direct_accept");
  assert.equal(evaluation.cases[5].outcome, "judge_error");
});
