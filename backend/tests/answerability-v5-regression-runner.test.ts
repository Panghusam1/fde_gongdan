import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadRunner() {
  try {
    return await import(
      "../src/evaluation/answerability-holdout-v5-regression-runner.ts"
    );
  } catch {
    assert.fail("第五版两阶段受控回归运行器尚未实现");
  }
}

const paths = {
  firstRun: "reports/qwen-answerability-holdout-v3-first-run.json",
  v3Run: "reports/qwen-answerability-v3-regression.json",
  manifest:
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
  judge: "src/evaluation/qwen-answerability-judge-v5.ts",
  evaluator: "src/evaluation/answerability-three-class-evaluation.ts",
  runner: "src/evaluation/answerability-holdout-v5-regression-runner.ts",
  plan: "reports/ohf-answerability-v5-regression-plan.json",
};

test("R253：第五版回归必须锁定首跑、第三版报告、候选、判断器和计分链", async () => {
  const { validateAnswerabilityV5RegressionFreeze } = await loadRunner();
  const [
    firstRunRaw,
    v3RunRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    planRaw,
  ] = await Promise.all(Object.values(paths).map((path) => readFile(path, "utf8")));

  const record = validateAnswerabilityV5RegressionFreeze({
    firstRunRaw,
    v3RunRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    planRaw,
  });
  assert.equal(record.status, "frozen_before_full_v5_regression");
  assert.equal(record.single_changed_variable.name, "judgment_orchestration");
  assert.throws(
    () =>
      validateAnswerabilityV5RegressionFreeze({
        firstRunRaw,
        v3RunRaw: `${v3RunRaw}\n`,
        manifestRaw,
        judgeRaw,
        evaluatorRaw,
        runnerRaw,
        planRaw,
      }),
    /does not match the freeze record/,
  );
});

test("R254：第五版回归必须复用首跑候选并沿用原门槛独立计分", async () => {
  const { runAnswerabilityHoldoutV5Regression } = await loadRunner();
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
  const report = await runAnswerabilityHoldoutV5Regression({
    judge: {
      modelId: "qwen3.7-plus",
      promptVersion: "answerability-v5-two-stage",
      async judge(input) {
        seenCandidateIds.push(input.candidates.map(({ id }) => id));
        const expected = expectedByQuery.get(input.question)!;
        if (expected.expectedVerdict === "not_answerable") {
          return {
            verdict: "not_answerable",
            candidateId: null,
            sourcePageNumber: null,
            supportingQuote: null,
            reason: "冻结标签测试替身。",
          };
        }
        const candidate = candidateById.get(expected.expectedCandidateId!)!;
        return {
          verdict: expected.expectedVerdict,
          candidateId: expected.expectedCandidateId,
          sourcePageNumber: candidate.sources[0].pdf_page_number,
          supportingQuote: candidate.sources[0].excerpt,
          reason: "冻结标签测试替身。",
        };
      },
    },
  });

  assert.equal(report.evaluation.caseCount, 18);
  assert.equal(report.evaluation.overallExactAccuracy, 1);
  assert.equal(report.comparison.firstRunOverallExactAccuracy, 11 / 18);
  assert.equal(report.comparison.v3OverallExactAccuracy, 15 / 18);
  assert.equal(report.passed, true);
  assert.ok(seenCandidateIds.every((ids) => ids.length === 5));
  assert.equal(report.ranking.reusedFromFailedFirstRun, true);
  assert.equal(report.singleChangedVariable.name, "judgment_orchestration");
});
