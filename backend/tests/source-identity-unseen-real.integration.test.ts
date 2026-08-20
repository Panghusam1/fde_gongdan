import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createWorkOrderMainChainFromEnvironment } from "../src/coordinator/work-order-main-chain.ts";
import { loadSourceIdentityUnseenDataset } from "../src/evaluation/source-identity-unseen-dataset.ts";
import { executeSourceIdentityUnseenEvaluation } from "../src/evaluation/source-identity-unseen-executor.ts";

const frozenPaths = [
  "data/evaluation/source-identity-unseen-v1.json",
  "src/evaluation/source-identity-unseen-dataset.ts",
  "src/evaluation/source-identity-unseen-executor.ts",
  "src/evaluation/source-aware-work-order-judge.ts",
  "src/evaluation/qwen-answerability-judge.ts",
  "src/evaluation/qwen-answerability-judge-v5.ts",
  "src/evaluation/qwen-answerability-judge-v6.ts",
  "src/coordinator/work-order-main-chain.ts",
  "tests/source-identity-unseen-dataset.test.ts",
  "tests/source-identity-unseen-executor.test.ts",
  "tests/source-identity-unseen-prerun.test.ts",
  "tests/source-identity-unseen-real.integration.test.ts",
] as const;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

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
  "R297：正式第六版主链必须通过全新来源身份未见集首次真实测评",
  {
    skip: process.env.RUN_QWEN_SOURCE_IDENTITY_UNSEEN_V1 !== "1",
    timeout: 900_000,
  },
  async () => {
    const [dataset, preRunRaw] = await Promise.all([
      loadSourceIdentityUnseenDataset(),
      readFile("reports/source-identity-unseen-v1-prerun.json", "utf8"),
    ]);
    const preRun = JSON.parse(preRunRaw) as {
      status: string;
      dataset_role: string;
      first_model_run_completed: boolean;
      frozen_inputs: Array<{ path: string; sha256: string }>;
      acceptance_target: {
        exact_case_count_minimum: number;
        forged_source_accept_count_maximum: number;
        judge_error_count_maximum: number;
      };
    };
    assert.equal(preRun.status, "frozen_before_first_model_run");
    assert.equal(preRun.dataset_role, "project_authored_unseen_not_production_data");
    assert.equal(preRun.first_model_run_completed, false);
    assert.equal(preRun.frozen_inputs.length, frozenPaths.length);
    for (const item of preRun.frozen_inputs) {
      assert.ok(frozenPaths.includes(item.path as (typeof frozenPaths)[number]));
      assert.equal(await sha256File(item.path), item.sha256, `${item.path} changed`);
    }

    const environment = {
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
      QWEN_COORDINATOR_MODEL: "qwen3.7-plus",
    };
    const startedAt = performance.now();
    const result = await executeSourceIdentityUnseenEvaluation({
      dataset,
      createMainChain(database, embedder) {
        return createWorkOrderMainChainFromEnvironment(
          database,
          embedder,
          environment,
        );
      },
    });
    const report = {
      first_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      data_role: "project_authored_unseen_not_production_data",
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-source-identity-unseen-v1-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );

    assert.ok(
      report.exact_case_count >= preRun.acceptance_target.exact_case_count_minimum,
      JSON.stringify(report.cases, null, 2),
    );
    assert.ok(
      report.forged_source_accept_count <=
        preRun.acceptance_target.forged_source_accept_count_maximum,
      JSON.stringify(report.cases, null, 2),
    );
    assert.ok(
      report.judge_error_count <= preRun.acceptance_target.judge_error_count_maximum,
      JSON.stringify(report.cases, null, 2),
    );
    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);
