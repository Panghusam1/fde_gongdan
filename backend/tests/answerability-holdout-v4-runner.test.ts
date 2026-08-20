import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadRunner() {
  try {
    return await import(
      "../src/evaluation/answerability-holdout-v4-runner.ts"
    );
  } catch {
    assert.fail("第三批未见题的封存首跑运行器尚未实现");
  }
}

const paths = {
  dataset: "data/evaluation/ohf-answerability-holdout-v4.json",
  manifest:
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
  judge: "src/evaluation/qwen-answerability-judge-v5.ts",
  evaluator: "src/evaluation/answerability-adjudicated-evaluation.ts",
  runner: "src/evaluation/answerability-holdout-v4-runner.ts",
  preRun: "reports/ohf-answerability-holdout-v4-prerun.json",
};

test("R260：第三批首跑必须锁定题库、候选、第五版判断器、多证据计分器和运行器", async () => {
  const { validateAnswerabilityHoldoutV4Freeze } = await loadRunner();
  const [datasetRaw, manifestRaw, judgeRaw, evaluatorRaw, runnerRaw, preRunRaw] =
    await Promise.all(Object.values(paths).map((path) => readFile(path, "utf8")));
  const record = validateAnswerabilityHoldoutV4Freeze({
    datasetRaw,
    manifestRaw,
    judgeRaw,
    evaluatorRaw,
    runnerRaw,
    preRunRaw,
  });
  assert.equal(record.status, "frozen_before_first_model_run");
  assert.equal(record.dataset_role, "project_authored_unseen_holdout_not_production_data");
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV4Freeze({
        datasetRaw: `${datasetRaw}\n`,
        manifestRaw,
        judgeRaw,
        evaluatorRaw,
        runnerRaw,
        preRunRaw,
      }),
    /does not match the pre-run freeze record/,
  );
  assert.throws(
    () =>
      validateAnswerabilityHoldoutV4Freeze({
        datasetRaw,
        manifestRaw,
        judgeRaw,
        evaluatorRaw,
        runnerRaw: `${runnerRaw}\n`,
        preRunRaw,
      }),
    /does not match the pre-run freeze record/,
  );
});

test("R261：第三批运行器必须复用E5前五并分别计算类别与多证据联合门槛", async () => {
  const { runAnswerabilityHoldoutV4 } = await loadRunner();
  const dataset = JSON.parse(await readFile(paths.dataset, "utf8")) as {
    cases: Array<{
      query: string;
      expected_verdict:
        | "directly_answerable"
        | "partially_related"
        | "not_answerable";
      primary_candidate_key: string | null;
    }>;
  };
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as {
    candidates: Array<{
      candidate_key: string;
      sources: Array<{ pdf_page_number: number; excerpt: string }>;
    }>;
  };
  const caseByQuery = new Map(dataset.cases.map((item) => [item.query, item]));
  const candidateById = new Map(
    manifest.candidates.map((item) => [item.candidate_key, item]),
  );
  const allIds = manifest.candidates.map(({ candidate_key }) => candidate_key);
  const judgeInputs: string[][] = [];
  const report = await runAnswerabilityHoldoutV4({
    rankCandidates: async (question) => {
      const item = caseByQuery.get(question)!;
      const order = item.primary_candidate_key === null
        ? allIds
        : [
            item.primary_candidate_key,
            ...allIds.filter((id) => id !== item.primary_candidate_key),
          ];
      return order.map((id, index) => ({ id, score: 1 - index / 10 }));
    },
    judge: {
      modelId: "qwen3.7-plus",
      promptVersion: "answerability-v5-two-stage",
      async judge(input) {
        judgeInputs.push(input.candidates.map(({ id }) => id));
        const item = caseByQuery.get(input.question)!;
        if (item.expected_verdict === "not_answerable") {
          return {
            verdict: "not_answerable",
            candidateId: null,
            sourcePageNumber: null,
            supportingQuote: null,
            reason: "测试替身按冻结标签拒答。",
          };
        }
        const candidate = candidateById.get(item.primary_candidate_key!)!;
        return {
          verdict: item.expected_verdict,
          candidateId: item.primary_candidate_key,
          sourcePageNumber: candidate.sources[0].pdf_page_number,
          supportingQuote: candidate.sources[0].excerpt,
          reason: "测试替身按冻结标签返回证据。",
        };
      },
    },
  });

  assert.equal(report.datasetRole, "project_authored_unseen_holdout_first_run");
  assert.equal(report.evaluation.caseCount, 18);
  assert.equal(report.evaluation.overallVerdictAccuracy, 1);
  assert.equal(report.evaluation.overallAdjudicatedExactAccuracy, 1);
  assert.equal(report.passed, true);
  assert.equal(judgeInputs.length, 18);
  assert.ok(judgeInputs.every((ids) => ids.length === 5));
  assert.equal(report.rankingModel.kind, "injected_test_ranker");
  assert.ok(
    report.evaluation.cases.some(
      ({ acceptableCandidateIds }) => acceptableCandidateIds?.length === 2,
    ),
  );
});
