import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { QwenAnswerabilityJudge } from "../src/evaluation/qwen-answerability-judge.ts";

async function loadRunner() {
  try {
    return await import("../src/evaluation/answerability-holdout-v2-runner.ts");
  } catch {
    assert.fail("第二版答案存在性未见评测运行器尚未实现");
  }
}

test("R219：题库、候选资料或判断策略在封存后变化必须在模型调用前阻断", async () => {
  const { validateAnswerabilityHoldoutV2Freeze } = await loadRunner();
  const [datasetRaw, manifestRaw, judgeImplementationRaw, preRunRaw] =
    await Promise.all([
      readFile("data/evaluation/ohf-answerability-holdout-v2.json", "utf8"),
      readFile(
        "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
        "utf8",
      ),
      readFile("src/evaluation/qwen-answerability-judge.ts", "utf8"),
      readFile("reports/ohf-answerability-holdout-v2-prerun.json", "utf8"),
    ]);

  assert.doesNotThrow(() =>
    validateAnswerabilityHoldoutV2Freeze({
      datasetRaw,
      manifestRaw,
      judgeImplementationRaw,
      preRunRaw,
    }),
  );
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV2Freeze({
        datasetRaw: `${datasetRaw} `,
        manifestRaw,
        judgeImplementationRaw,
        preRunRaw,
      }),
    /does not match the pre-run freeze record/,
  );
});

test("R220：新未见评测必须使用前五候选并按冻结的四项门槛计分", async () => {
  const { runAnswerabilityHoldoutV2 } = await loadRunner();
  const dataset = JSON.parse(
    await readFile("data/evaluation/ohf-answerability-holdout-v2.json", "utf8"),
  ) as {
    cases: Array<{
      query: string;
      expected_behavior: "hit" | "abstain";
      expected_candidate_key: string | null;
    }>;
  };
  const expectedByQuestion = new Map(
    dataset.cases.map((item) => [item.query, item]),
  );
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen3.7-plus",
    promptVersion: "answerability-v1",
    async judge(input) {
      const expected = expectedByQuestion.get(input.question)!;
      if (expected.expected_behavior === "abstain") {
        return {
          verdict: "not_answerable",
          candidateId: null,
          sourcePageNumber: null,
          supportingQuote: null,
          reason: "固定测试判断器拒答。",
        };
      }
      const candidate = input.candidates.find(
        ({ id }) => id === expected.expected_candidate_key,
      )!;
      return {
        verdict: "directly_answerable",
        candidateId: candidate.id,
        sourcePageNumber: candidate.sources[0].pageNumber,
        supportingQuote: candidate.sources[0].text,
        reason: "固定测试判断器选择标注资料。",
      };
    },
  };

  const report = await runAnswerabilityHoldoutV2({
    judge,
    rankCandidates: async (question, documents) => {
      const expected = expectedByQuestion.get(question)!;
      return [...documents]
        .sort((left, right) => {
          if (left.id === expected.expected_candidate_key) return -1;
          if (right.id === expected.expected_candidate_key) return 1;
          return left.id.localeCompare(right.id);
        })
        .map((item, index) => ({ id: item.id, score: 1 - index / 10 }));
    },
  });

  assert.equal(report.datasetRole, "project_authored_unseen_holdout_first_run");
  assert.equal(report.candidateLimit, 5);
  assert.equal(report.evaluation.caseCount, 36);
  assert.equal(report.evaluation.answerableCorrectAcceptRate, 1);
  assert.equal(report.evaluation.unanswerableAbstainAccuracy, 1);
  assert.equal(report.evaluation.acceptedPrecision, 1);
  assert.equal(report.judgeErrorCount, 0);
  assert.equal(report.passed, true);
});
