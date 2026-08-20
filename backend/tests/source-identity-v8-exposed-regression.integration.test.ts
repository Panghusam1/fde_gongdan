import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createWorkOrderMainChainV3FromEnvironment } from "../src/coordinator/work-order-main-chain-v3.ts";
import { loadSourceIdentityUnseenV2Dataset } from "../src/evaluation/source-identity-unseen-v2-dataset.ts";
import { executeSourceIdentityUnseenEvaluationV3 } from "../src/evaluation/source-identity-unseen-executor-v3.ts";

async function writeReportOnce(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (caught) {
    if (
      typeof caught !== "object" ||
      caught === null ||
      !("code" in caught) ||
      caught.code !== "EEXIST"
    ) throw caught;
  }
}

test(
  "R309：第八版必须修复第二批已暴露题中的语义拒绝和多候选波动",
  {
    skip: process.env.RUN_QWEN_SOURCE_IDENTITY_V8_EXPOSED_REGRESSION !== "1",
    timeout: 900_000,
  },
  async () => {
    const [dataset, failedRaw] = await Promise.all([
      loadSourceIdentityUnseenV2Dataset(),
      readFile("reports/qwen-source-identity-unseen-v2-first-run.json", "utf8"),
    ]);
    const failed = JSON.parse(failedRaw) as {
      passed: boolean;
      exact_case_count: number;
      forged_source_accept_count: number;
    };
    assert.equal(failed.passed, false);
    assert.equal(failed.exact_case_count, 10);
    assert.equal(failed.forged_source_accept_count, 0);
    const environment = {
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
      QWEN_COORDINATOR_MODEL: "qwen3.7-plus",
    };
    const startedAt = performance.now();
    const result = await executeSourceIdentityUnseenEvaluationV3({
      dataset,
      createMainChain: (database, embedder) =>
        createWorkOrderMainChainV3FromEnvironment(database, embedder, environment),
    });
    const report = {
      regression_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      data_role: "exposed_regression_after_failed_unseen_run",
      source_failed_first_run_sha256: createHash("sha256").update(failedRaw).digest("hex"),
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-source-identity-v8-exposed-regression.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.equal(report.exact_case_count, 12, JSON.stringify(report.cases, null, 2));
    assert.equal(report.forged_source_accept_count, 0);
    assert.equal(report.judge_error_count, 0);
    assert.equal(report.passed, true);
  },
);
