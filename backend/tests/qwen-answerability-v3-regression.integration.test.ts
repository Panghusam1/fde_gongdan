import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R247：第三版千问必须在18道已暴露题的受控回归中达到原冻结门槛",
  {
    skip: process.env.RUN_QWEN_ANSWERABILITY_V3_REGRESSION !== "1",
    timeout: 900_000,
  },
  async () => {
    const [
      { createQwenAnswerabilityJudgeV3FromEnvironment },
      { runAnswerabilityHoldoutV3Regression },
    ] = await Promise.all([
      import("../src/evaluation/qwen-answerability-judge-v3.ts"),
      import(
        "../src/evaluation/answerability-holdout-v3-regression-runner.ts"
      ),
    ]);
    const judge = createQwenAnswerabilityJudgeV3FromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
    });
    const report = await runAnswerabilityHoldoutV3Regression({ judge });
    try {
      await writeFile(
        "reports/qwen-answerability-v3-regression.json",
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
