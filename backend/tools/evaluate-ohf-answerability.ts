import { mkdir, writeFile } from "node:fs/promises";

import { runE5AnswerabilityHoldout } from "../src/evaluation/e5-answerability-holdout-runner.ts";

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
console.log(
  JSON.stringify(
    {
      evaluation: report.evaluation,
      gates: report.gates,
      passed: report.passed,
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
