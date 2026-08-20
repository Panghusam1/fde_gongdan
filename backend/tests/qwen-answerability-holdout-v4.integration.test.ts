import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R262：第五版两阶段判断必须在第三批18道新未见题上达到类别与多证据冻结门槛",
  {
    skip: process.env.RUN_QWEN_ANSWERABILITY_HOLDOUT_V4 !== "1",
    timeout: 900_000,
  },
  async () => {
    const [
      { createQwenAnswerabilityJudgeV5FromEnvironment },
      { runAnswerabilityHoldoutV4 },
    ] = await Promise.all([
      import("../src/evaluation/qwen-answerability-judge-v5.ts"),
      import("../src/evaluation/answerability-holdout-v4-runner.ts"),
    ]);
    const judge = createQwenAnswerabilityJudgeV5FromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
    });
    const report = await runAnswerabilityHoldoutV4({
      judge,
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
      remoteHost: process.env.HF_REMOTE_HOST,
    });
    try {
      await writeFile(
        "reports/qwen-answerability-holdout-v4-first-run.json",
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
            ({ outcome }) => outcome !== "adjudicated_correct",
          ),
        },
        null,
        2,
      ),
    );
  },
);
