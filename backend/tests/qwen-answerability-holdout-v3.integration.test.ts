import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R243：固定E5与第二版千问必须在18道新未见三分类题上达到冻结门槛",
  {
    skip: process.env.RUN_QWEN_ANSWERABILITY_HOLDOUT_V3 !== "1",
    timeout: 900_000,
  },
  async () => {
    const [
      { createQwenAnswerabilityJudgeV2FromEnvironment },
      { runAnswerabilityHoldoutV3 },
    ] = await Promise.all([
      import("../src/evaluation/qwen-answerability-judge-v2.ts"),
      import("../src/evaluation/answerability-holdout-v3-runner.ts"),
    ]);
    const judge = createQwenAnswerabilityJudgeV2FromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
    });
    const report = await runAnswerabilityHoldoutV3({
      judge,
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
      remoteHost: process.env.HF_REMOTE_HOST,
    });
    try {
      await writeFile(
        "reports/qwen-answerability-holdout-v3-first-run.json",
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
