import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R215：真实千问在24道旧留出回归题上改善无答案判断且达到三项门槛",
  {
    skip: process.env.RUN_QWEN_ANSWERABILITY_REGRESSION !== "1",
    timeout: 600_000,
  },
  async () => {
    const [{ createQwenAnswerabilityJudgeFromEnvironment }, { runAnswerabilityJudgeRegression }] =
      await Promise.all([
        import("../src/evaluation/qwen-answerability-judge.ts"),
        import("../src/evaluation/answerability-judge-regression-runner.ts"),
      ]);
    const judge = createQwenAnswerabilityJudgeFromEnvironment(process.env);
    const report = await runAnswerabilityJudgeRegression({ judge });
    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/qwen-answerability-regression-v1.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    assert.equal(report.passedRegressionTargets, true, JSON.stringify(report.gates));
  },
);
