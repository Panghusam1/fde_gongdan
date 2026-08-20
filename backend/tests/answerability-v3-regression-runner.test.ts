import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadRegressionRunner() {
  try {
    return await import(
      "../src/evaluation/answerability-holdout-v3-regression-runner.ts"
    );
  } catch {
    assert.fail("第三版分类提示的受控回归运行器尚未实现");
  }
}

const paths = {
  firstRun: "reports/qwen-answerability-holdout-v3-first-run.json",
  manifest:
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
  judge: "src/evaluation/qwen-answerability-judge-v3.ts",
  evaluator: "src/evaluation/answerability-three-class-evaluation.ts",
  runner: "src/evaluation/answerability-holdout-v3-regression-runner.ts",
  plan: "reports/ohf-answerability-v3-regression-plan.json",
};

test("R245：第三版完整回归必须锁定失败首跑、候选、判断器、计分器与运行器", async () => {
  const { validateAnswerabilityV3RegressionFreeze } =
    await loadRegressionRunner();
  const [firstRunRaw, manifestRaw, judgeRaw, evaluatorRaw, runnerRaw, planRaw] =
    await Promise.all(Object.values(paths).map((path) => readFile(path, "utf8")));

  const record = validateAnswerabilityV3RegressionFreeze({
    firstRunRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    planRaw,
  });
  assert.equal(record.status, "frozen_before_full_v3_regression");
  assert.equal(record.single_changed_variable.name, "answerability_prompt");

  assert.throws(
    () =>
      validateAnswerabilityV3RegressionFreeze({
        firstRunRaw: `${firstRunRaw}\n`,
        manifestRaw,
        judgeRaw,
        evaluatorRaw,
        runnerRaw,
        planRaw,
      }),
    /does not match the freeze record/,
  );
  assert.throws(
    () =>
      validateAnswerabilityV3RegressionFreeze({
        firstRunRaw,
        manifestRaw,
        judgeRaw,
        evaluatorRaw,
        runnerRaw: `${runnerRaw}\n`,
        planRaw,
      }),
    /does not match the freeze record/,
  );
});

test("R246：受控回归必须复用首跑前五候选且沿用原门槛重新计分", async () => {
  const { runAnswerabilityHoldoutV3Regression } =
    await loadRegressionRunner();
  const firstRun = JSON.parse(await readFile(paths.firstRun, "utf8")) as {
    evaluation: {
      cases: Array<{
        query: string;
        expectedVerdict:
          | "directly_answerable"
          | "partially_related"
          | "not_answerable";
        expectedCandidateId: string | null;
      }>;
    };
  };
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as {
    candidates: Array<{
      candidate_key: string;
      sources: Array<{ pdf_page_number: number; excerpt: string }>;
    }>;
  };
  const expectedByQuery = new Map(
    firstRun.evaluation.cases.map((item) => [item.query, item]),
  );
  const candidateById = new Map(
    manifest.candidates.map((item) => [item.candidate_key, item]),
  );
  const seenCandidateIds: string[][] = [];

  const report = await runAnswerabilityHoldoutV3Regression({
    judge: {
      modelId: "qwen3.7-plus",
      promptVersion: "answerability-v3",
      async judge(input) {
        seenCandidateIds.push(input.candidates.map(({ id }) => id));
        const expected = expectedByQuery.get(input.question)!;
        if (expected.expectedVerdict === "not_answerable") {
          return {
            verdict: "not_answerable",
            candidateId: null,
            sourcePageNumber: null,
            supportingQuote: null,
            reason: "测试替身按冻结标签返回完全不可回答。",
          };
        }
        const candidate = candidateById.get(expected.expectedCandidateId!)!;
        return {
          verdict: expected.expectedVerdict,
          candidateId: expected.expectedCandidateId,
          sourcePageNumber: candidate.sources[0].pdf_page_number,
          supportingQuote: candidate.sources[0].excerpt,
          reason: "测试替身按冻结标签返回候选。",
        };
      },
    },
  });

  assert.equal(report.evaluation.caseCount, 18);
  assert.equal(report.evaluation.overallExactAccuracy, 1);
  assert.equal(report.comparison.firstRunOverallExactAccuracy, 11 / 18);
  assert.equal(report.passed, true);
  assert.equal(seenCandidateIds.length, 18);
  assert.ok(seenCandidateIds.every((ids) => ids.length === 5));
  assert.deepEqual(
    seenCandidateIds[0],
    report.evaluation.cases[0].candidateIds,
  );
  assert.equal(report.ranking.reusedFromFailedFirstRun, true);
  assert.equal(report.singleChangedVariable.name, "answerability_prompt");
});
