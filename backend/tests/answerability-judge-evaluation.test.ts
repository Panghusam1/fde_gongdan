import assert from "node:assert/strict";
import test from "node:test";

async function loadEvaluator() {
  try {
    return await import("../src/evaluation/answerability-judge-evaluation.ts");
  } catch {
    assert.fail("证据判断器计分器尚未实现");
  }
}

test("R208：证据判断器必须分别计算正确放行、无答案拒答和放行准确率", async () => {
  const { evaluateAnswerabilityJudge } = await loadEvaluator();
  const result = evaluateAnswerabilityJudge([
    {
      caseId: "H11",
      expectedBehavior: "hit",
      expectedCandidateId: "power-isolation",
      decision: {
        verdict: "directly_answerable",
        candidateId: "power-isolation",
        sourcePageNumber: 385,
        supportingQuote: "断开所有电源。",
        reason: "直接给出步骤。",
      },
    },
    {
      caseId: "H14",
      expectedBehavior: "abstain",
      expectedCandidateId: null,
      decision: {
        verdict: "not_answerable",
        candidateId: null,
        sourcePageNumber: null,
        supportingQuote: null,
        reason: "没有保修信息。",
      },
    },
    {
      caseId: "H19",
      expectedBehavior: "abstain",
      expectedCandidateId: null,
      decision: {
        verdict: "partially_related",
        candidateId: "ohf-fault-definition",
        sourcePageNumber: 72,
        supportingQuote: "OHF：设备过热。",
        reason: "与散热相关但没有备件编号。",
      },
    },
    {
      caseId: "WRONG",
      expectedBehavior: "hit",
      expectedCandidateId: "definition",
      decision: {
        verdict: "directly_answerable",
        candidateId: "threshold",
        sourcePageNumber: 50,
        supportingQuote: "118%为OHF阈值。",
        reason: "错误选择了阈值资料。",
      },
    },
  ]);

  assert.equal(result.caseCount, 4);
  assert.equal(result.answerableCaseCount, 2);
  assert.equal(result.unanswerableCaseCount, 2);
  assert.equal(result.answerableCorrectAcceptRate, 0.5);
  assert.equal(result.unanswerableAbstainAccuracy, 1);
  assert.equal(result.acceptedPrecision, 0.5);
  assert.equal(result.cases[0].outcome, "correct_accept");
  assert.equal(result.cases[1].outcome, "correct_abstain");
  assert.equal(result.cases[2].outcome, "correct_abstain");
  assert.equal(result.cases[3].outcome, "wrong_accept");
});

test("R209：空题库、重复编号和矛盾标签必须在计分前拒绝", async () => {
  const { evaluateAnswerabilityJudge } = await loadEvaluator();
  assert.throws(() => evaluateAnswerabilityJudge([]), /at least one case/);

  const invalid = {
    caseId: "DUP",
    expectedBehavior: "abstain" as const,
    expectedCandidateId: "should-be-null",
    decision: {
      verdict: "not_answerable" as const,
      candidateId: null,
      sourcePageNumber: null,
      supportingQuote: null,
      reason: "没有答案。",
    },
  };
  assert.throws(
    () => evaluateAnswerabilityJudge([invalid]),
    /abstain case cannot expect a candidate/,
  );
  assert.throws(
    () =>
      evaluateAnswerabilityJudge([
        { ...invalid, expectedCandidateId: null },
        { ...invalid, expectedCandidateId: null },
      ]),
    /case IDs must be unique/,
  );
});

test("R213：模型输出或请求失败必须单独记错而不能伪装成正确拒答", async () => {
  const { evaluateAnswerabilityJudge } = await loadEvaluator();
  const result = evaluateAnswerabilityJudge([
    {
      caseId: "ERROR-ABSTAIN",
      expectedBehavior: "abstain",
      expectedCandidateId: null,
      decision: null,
      error: "模型引用了不存在的原文",
    },
  ]);

  assert.equal(result.cases[0].outcome, "judge_error");
  assert.equal(result.unanswerableAbstainAccuracy, 0);
  assert.equal(result.overallDecisionAccuracy, 0);
});
