import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createWorkOrderMainChainV4FromEnvironment } from "../src/coordinator/work-order-main-chain-v4.ts";
import { loadSourceIdentityUnseenV4Dataset } from "../src/evaluation/source-identity-unseen-v4-dataset.ts";
import { executeSourceIdentityUnseenEvaluationV4 } from "../src/evaluation/source-identity-unseen-executor-v4.ts";

const sourceIdentityUnseenV4FrozenPaths = [
  "data/evaluation/source-identity-unseen-v4.json",
  "src/evaluation/source-identity-unseen-v4-dataset.ts",
  "src/evaluation/source-identity-unseen-executor-v4.ts",
  "src/evaluation/confirmed-source-work-order-judge.ts",
  "src/evaluation/qwen-answerability-judge-v8.ts",
  "src/evaluation/qwen-answerability-judge-v7.ts",
  "src/evaluation/qwen-answerability-judge-v6.ts",
  "src/evaluation/qwen-answerability-judge-v5.ts",
  "src/evaluation/qwen-answerability-judge.ts",
  "src/evaluation/source-aware-work-order-judge.ts",
  "src/coordinator/work-order-main-chain-v4.ts",
  "tests/confirmed-source-work-order-judge.test.ts",
  "tests/work-order-main-chain-v4.test.ts",
  "tests/source-identity-unseen-v4-dataset.test.ts",
  "tests/source-identity-unseen-executor-v4.test.ts",
  "tests/source-identity-unseen-v4-prerun.test.ts",
  "tests/source-identity-unseen-v4-real.integration.test.ts",
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
  "R320：结构化来源第四版正式主链必须通过首次真实模型未见验证",
  {
    skip: process.env.RUN_QWEN_SOURCE_IDENTITY_UNSEEN_V4 !== "1",
    timeout: 900_000,
  },
  async () => {
    const [dataset, preRunRaw] = await Promise.all([
      loadSourceIdentityUnseenV4Dataset(),
      readFile("reports/source-identity-unseen-v4-prerun.json", "utf8"),
    ]);
    const preRun = JSON.parse(preRunRaw) as {
      status: string;
      first_model_run_completed: boolean;
      frozen_inputs: Array<{ path: string; sha256: string }>;
      acceptance_target: {
        exact_case_count_minimum: number;
        unmatched_source_accept_count_maximum: number;
        judge_error_count_maximum: number;
      };
    };
    assert.equal(preRun.status, "frozen_before_first_model_run");
    assert.equal(preRun.first_model_run_completed, false);
    assert.equal(
      preRun.frozen_inputs.length,
      sourceIdentityUnseenV4FrozenPaths.length,
    );
    for (const item of preRun.frozen_inputs) {
      assert.ok(
        sourceIdentityUnseenV4FrozenPaths.includes(
          item.path as (typeof sourceIdentityUnseenV4FrozenPaths)[number],
        ),
      );
      assert.equal(await sha256File(item.path), item.sha256, `${item.path} changed`);
    }

    const environment = {
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
      QWEN_COORDINATOR_MODEL: "qwen3.7-plus",
    };
    const startedAt = performance.now();
    const result = await executeSourceIdentityUnseenEvaluationV4({
      dataset,
      createMainChain: (database, embedder) =>
        createWorkOrderMainChainV4FromEnvironment(
          database,
          embedder,
          environment,
        ),
    });
    const report = {
      first_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      data_role: "project_authored_unseen_not_production_data",
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-source-identity-unseen-v4-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.ok(
      report.exact_case_count >=
        preRun.acceptance_target.exact_case_count_minimum,
      JSON.stringify(report.cases, null, 2),
    );
    assert.ok(
      report.unmatched_source_accept_count <=
        preRun.acceptance_target.unmatched_source_accept_count_maximum,
      JSON.stringify(report.cases, null, 2),
    );
    assert.ok(
      report.judge_error_count <=
        preRun.acceptance_target.judge_error_count_maximum,
      JSON.stringify(report.cases, null, 2),
    );
    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);
