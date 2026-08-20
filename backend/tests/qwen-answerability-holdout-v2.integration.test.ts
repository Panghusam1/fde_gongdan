import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R221：前五候选加真实千问证据判断在封存的36道新题上达到四项门槛",
  {
    skip: process.env.RUN_QWEN_ANSWERABILITY_HOLDOUT_V2 !== "1",
    timeout: 900_000,
  },
  async () => {
    const [{ createQwenAnswerabilityJudgeFromEnvironment }, { runAnswerabilityHoldoutV2 }] =
      await Promise.all([
        import("../src/evaluation/qwen-answerability-judge.ts"),
        import("../src/evaluation/answerability-holdout-v2-runner.ts"),
      ]);
    const judge = createQwenAnswerabilityJudgeFromEnvironment(process.env);
    const report = await runAnswerabilityHoldoutV2({
      judge,
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
      remoteHost: process.env.HF_REMOTE_HOST,
    });
    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/qwen-answerability-holdout-v2-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    assert.equal(report.passed, true, JSON.stringify(report.gates));
  },
);
