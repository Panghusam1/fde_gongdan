import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createWorkOrderMainChainV2FromEnvironment } from "../src/coordinator/work-order-main-chain-v2.ts";
import { loadSourceIdentityUnseenDataset } from "../src/evaluation/source-identity-unseen-dataset.ts";
import { executeSourceIdentityUnseenEvaluationV2 } from "../src/evaluation/source-identity-unseen-executor-v2.ts";

async function writeReportOnce(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (caught) {
    if (
      typeof caught !== "object" ||
      caught === null ||
      !("code" in caught) ||
      caught.code !== "EEXIST"
    ) {
      throw caught;
    }
  }
}

test(
  "R302：第七版必须修复第一批已暴露来源身份题中的覆盖指令缺陷",
  {
    skip: process.env.RUN_QWEN_SOURCE_IDENTITY_V7_EXPOSED_REGRESSION !== "1",
    timeout: 900_000,
  },
  async () => {
    const [dataset, failedFirstRunRaw] = await Promise.all([
      loadSourceIdentityUnseenDataset(),
      readFile("reports/qwen-source-identity-unseen-v1-first-run.json", "utf8"),
    ]);
    const failedFirstRun = JSON.parse(failedFirstRunRaw) as {
      passed: boolean;
      exact_case_count: number;
      forged_source_accept_count: number;
    };
    assert.equal(failedFirstRun.passed, false);
    assert.equal(failedFirstRun.exact_case_count, 11);
    assert.equal(failedFirstRun.forged_source_accept_count, 1);

    const environment = {
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
      QWEN_COORDINATOR_MODEL: "qwen3.7-plus",
    };
    const startedAt = performance.now();
    const result = await executeSourceIdentityUnseenEvaluationV2({
      dataset,
      createMainChain(database, embedder) {
        return createWorkOrderMainChainV2FromEnvironment(
          database,
          embedder,
          environment,
        );
      },
    });
    const report = {
      regression_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      data_role: "exposed_regression_after_failed_unseen_run",
      source_failed_first_run_sha256: createHash("sha256")
        .update(failedFirstRunRaw)
        .digest("hex"),
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-source-identity-v7-exposed-regression.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.equal(report.exact_case_count, 12, JSON.stringify(report.cases, null, 2));
    assert.equal(report.forged_source_accept_count, 0);
    assert.equal(report.judge_error_count, 0);
    assert.equal(report.passed, true);
  },
);
