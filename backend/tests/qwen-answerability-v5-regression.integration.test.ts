import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R255：第五版两阶段判断必须在18道已暴露题回归中达到原冻结门槛",
  {
    skip: process.env.RUN_QWEN_ANSWERABILITY_V5_REGRESSION !== "1",
    timeout: 900_000,
  },
  async () => {
    const [
      { createQwenAnswerabilityJudgeV5FromEnvironment },
      { runAnswerabilityHoldoutV5Regression },
    ] = await Promise.all([
      import("../src/evaluation/qwen-answerability-judge-v5.ts"),
      import(
        "../src/evaluation/answerability-holdout-v5-regression-runner.ts"
      ),
    ]);
    const judge = createQwenAnswerabilityJudgeV5FromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
    });
    const report = await runAnswerabilityHoldoutV5Regression({ judge });
    try {
      await writeFile(
        "reports/qwen-answerability-v5-regression.json",
        `${JSON.stringify(report, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    assert.equal(
      report.passed,
      true,
      JSON.stringify(
        {
          gates: report.gates,
          failedCases: report.evaluation.cases.filter(
            ({ outcome }) => outcome !== "correct",
          ),
        },
        null,
        2,
      ),
    );
  },
);
