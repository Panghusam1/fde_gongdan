import assert from "node:assert/strict";
import test from "node:test";

import type { QwenAnswerabilityJudge } from "../src/evaluation/qwen-answerability-judge.ts";

async function loadRunner() {
  try {
    return await import("../src/evaluation/answerability-judge-regression-runner.ts");
  } catch {
    assert.fail("证据判断器24题回归运行器尚未实现");
  }
}

test("R211：24道旧留出题必须按E5前五候选评估且明确标为回归数据", async () => {
  const { runAnswerabilityJudgeRegression } = await loadRunner();
  const dataset = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      "data/evaluation/ohf-answerability-holdout-v1.json",
      "utf8",
    ),
  ) as {
    cases: Array<{
      case_id: string;
      query: string;
      expected_behavior: "hit" | "abstain";
      expected_candidate_key: string | null;
    }>;
  };
  const expectedByQuestion = new Map(
    dataset.cases.map((item) => [item.query, item]),
  );
  const seenInputs: Array<{ question: string; candidateIds: string[] }> = [];
  const judge: QwenAnswerabilityJudge = {
    modelId: "fixed-test-judge",
    promptVersion: "answerability-v1",
    async judge(input) {
      seenInputs.push({
        question: input.question,
        candidateIds: input.candidates.map(({ id }) => id),
      });
      const expected = expectedByQuestion.get(input.question)!;
      if (expected.expected_behavior === "abstain") {
        return {
          verdict: "not_answerable",
          candidateId: null,
          sourcePageNumber: null,
          supportingQuote: null,
          reason: "测试判断器按标签拒答。",
        };
      }
      const candidate = input.candidates.find(
        ({ id }) => id === expected.expected_candidate_key,
      );
      assert.ok(candidate, `${expected.case_id}的正确资料必须进入前五候选`);
      return {
        verdict: "directly_answerable",
        candidateId: candidate.id,
        sourcePageNumber: candidate.sources[0].pageNumber,
        supportingQuote: candidate.sources[0].text,
        reason: "测试判断器选择预先标注的资料。",
      };
    },
  };

  const report = await runAnswerabilityJudgeRegression({ judge });

  assert.equal(report.datasetRole, "seen_regression_after_failed_holdout");
  assert.equal(report.candidateLimit, 5);
  assert.equal(report.evaluation.caseCount, 24);
  assert.equal(report.evaluation.answerableCorrectAcceptRate, 1);
  assert.equal(report.evaluation.unanswerableAbstainAccuracy, 1);
  assert.equal(report.evaluation.acceptedPrecision, 1);
  assert.equal(report.passedRegressionTargets, true);
  assert.equal(seenInputs.length, 24);
  assert.ok(seenInputs.every(({ candidateIds }) => candidateIds.length === 5));
  assert.equal(
    seenInputs
      .find(({ question }) => question.includes("PA/+和PC/-"))
      ?.candidateIds.indexOf("unresettable-fault-power-isolation-procedure"),
    3,
  );
});

test("R214：单题模型失败必须保留在完整报告中并使能力门失败", async () => {
  const { runAnswerabilityJudgeRegression } = await loadRunner();
  const judge: QwenAnswerabilityJudge = {
    modelId: "failing-test-judge",
    promptVersion: "answerability-v1",
    async judge() {
      throw new Error("模拟模型输出错误");
    },
  };

  const report = await runAnswerabilityJudgeRegression({ judge });

  assert.equal(report.evaluation.caseCount, 24);
  assert.ok(
    report.evaluation.cases.every(
      ({ outcome }) => outcome === "judge_error",
    ),
  );
  assert.equal(report.evaluation.overallDecisionAccuracy, 0);
  assert.equal(report.passedRegressionTargets, false);
});
