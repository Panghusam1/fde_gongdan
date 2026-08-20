import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadRunner() {
  try {
    return await import(
      "../src/evaluation/answerability-holdout-v3-runner.ts"
    );
  } catch {
    assert.fail("第二版三分类新未见运行器尚未实现");
  }
}

test("R240：题库、官方候选、第二版判断器或计分器在封存后变化必须在联网前阻断", async () => {
  const { validateAnswerabilityHoldoutV3Freeze } = await loadRunner();
  const [datasetRaw, manifestRaw, judgeRaw, evaluatorRaw, runnerRaw, preRunRaw] =
    await Promise.all([
      readFile("data/evaluation/ohf-answerability-holdout-v3.json", "utf8"),
      readFile(
        "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
        "utf8",
      ),
      readFile("src/evaluation/qwen-answerability-judge-v2.ts", "utf8"),
      readFile(
        "src/evaluation/answerability-three-class-evaluation.ts",
        "utf8",
      ),
      readFile(
        "src/evaluation/answerability-holdout-v3-runner.ts",
        "utf8",
      ),
      readFile(
        "reports/ohf-answerability-holdout-v3-prerun.json",
        "utf8",
      ),
    ]);
  const frozen = {
    datasetRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    preRunRaw,
  };

  assert.doesNotThrow(() => validateAnswerabilityHoldoutV3Freeze(frozen));
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV3Freeze({
        ...frozen,
        evaluatorRaw: `${evaluatorRaw} `,
      }),
    /does not match the pre-run freeze record/,
  );
});

test("R242：前五截取、E5排序和门槛计算所在的运行器也必须进入预运行封存", async () => {
  const { validateAnswerabilityHoldoutV3Freeze } = await loadRunner();
  const [datasetRaw, manifestRaw, judgeRaw, evaluatorRaw, runnerRaw, preRunRaw] =
    await Promise.all([
      readFile("data/evaluation/ohf-answerability-holdout-v3.json", "utf8"),
      readFile(
        "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
        "utf8",
      ),
      readFile("src/evaluation/qwen-answerability-judge-v2.ts", "utf8"),
      readFile(
        "src/evaluation/answerability-three-class-evaluation.ts",
        "utf8",
      ),
      readFile(
        "src/evaluation/answerability-holdout-v3-runner.ts",
        "utf8",
      ),
      readFile(
        "reports/ohf-answerability-holdout-v3-prerun.json",
        "utf8",
      ),
    ]);

  assert.throws(
    () =>
      validateAnswerabilityHoldoutV3Freeze({
        datasetRaw,
        manifestRaw,
        judgeRaw,
        evaluatorRaw,
        runnerRaw: `${runnerRaw} `,
        preRunRaw,
      }),
    /does not match the pre-run freeze record/,
  );
});

test("R241：新未见运行器必须使用前五候选并按冻结的三分类与安全门槛计分", async () => {
  const { runAnswerabilityHoldoutV3 } = await loadRunner();
  const dataset = JSON.parse(
    await readFile(
      "data/evaluation/ohf-answerability-holdout-v3.json",
      "utf8",
    ),
  ) as {
    cases: Array<{
      query: string;
      expected_verdict:
        | "directly_answerable"
        | "partially_related"
        | "not_answerable";
      expected_candidate_key: string | null;
    }>;
  };
  const expectedByQuery = new Map(
    dataset.cases.map((item) => [item.query, item]),
  );
  const judge = {
    modelId: "qwen3.7-plus",
    promptVersion: "answerability-v2",
    async judge(input: {
      question: string;
      candidates: Array<{
        id: string;
        sources: Array<{ pageNumber: number; text: string }>;
      }>;
    }) {
      const expected = expectedByQuery.get(input.question)!;
      if (expected.expected_verdict === "not_answerable") {
        return {
          verdict: "not_answerable" as const,
          candidateId: null,
          sourcePageNumber: null,
          supportingQuote: null,
          reason: "固定测试判断器确认属于其他业务单元。",
        };
      }
      const candidate = input.candidates.find(
        ({ id }) => id === expected.expected_candidate_key,
      )!;
      return {
        verdict: expected.expected_verdict,
        candidateId: candidate.id,
        sourcePageNumber: candidate.sources[0].pageNumber,
        supportingQuote: candidate.sources[0].text,
        reason: "固定测试判断器返回预期分类。",
      };
    },
  };

  const report = await runAnswerabilityHoldoutV3({
    judge,
    rankCandidates: async (question, documents) => {
      const expected = expectedByQuery.get(question)!;
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
  assert.equal(report.evaluation.caseCount, 18);
  assert.equal(report.evaluation.overallExactAccuracy, 1);
  assert.deepEqual(report.evaluation.perClassAccuracy, {
    directly_answerable: 1,
    partially_related: 1,
    not_answerable: 1,
  });
  assert.equal(report.evaluation.unsafeDirectAcceptCount, 0);
  assert.equal(report.evaluation.judgeErrorCount, 0);
  assert.equal(report.passed, true);
});
