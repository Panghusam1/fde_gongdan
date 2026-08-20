import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

test(
  "R203：冻结后的无答案留出集必须达到预先声明的三项门槛",
  { skip: process.env.RUN_E5_ANSWERABILITY_EVAL !== "1", timeout: 600_000 },
  async () => {
    const { runE5AnswerabilityHoldout } = await import(
      "../src/evaluation/e5-answerability-holdout-runner.ts"
    );
    const report = await runE5AnswerabilityHoldout({
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
      remoteHost: process.env.HF_REMOTE_HOST,
    });
    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/ohf-answerability-holdout-v1-result.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    assert.equal(report.passed, true, JSON.stringify(report.gates));
  },
);
