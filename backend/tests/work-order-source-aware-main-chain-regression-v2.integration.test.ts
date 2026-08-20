import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createWorkOrderMainChainFromEnvironment } from "../src/coordinator/work-order-main-chain.ts";
import type { WorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import { executeWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-source-aware-executor.ts";
import { loadWorkOrderEndToEndHoldoutV3 } from "../src/evaluation/work-order-end-to-end-holdout-v3-dataset.ts";
import {
  createMultilingualE5SmallEmbedder,
  MULTILINGUAL_E5_SMALL_MODEL_FILE,
  MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
} from "../src/retrieval/multilingual-e5-small.ts";

const frozenPaths = [
  "data/evaluation/work-order-end-to-end-holdout-v3.json",
  "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
  "data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
  "src/evaluation/qwen-answerability-judge.ts",
  "src/evaluation/qwen-answerability-judge-v5.ts",
  "src/evaluation/qwen-answerability-judge-v6.ts",
  "src/evaluation/source-aware-work-order-judge.ts",
  "src/coordinator/qwen-coordinator-model-v3.ts",
  "src/coordinator/qwen-coordinator-runtime-v3.ts",
  "src/coordinator/work-order-main-chain.ts",
  "src/evaluation/work-order-end-to-end-source-aware-executor.ts",
  "src/evaluation/work-order-end-to-end-holdout-v2-runner.ts",
  "src/retrieval/multilingual-e5-small.ts",
  "tests/work-order-source-aware-main-chain-regression-v2.integration.test.ts",
] as const;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function databaseBundleSha256(): Promise<string> {
  const migrations = (await readdir("database/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `database/migrations/${name}`);
  const paths = [...migrations, "database/seeds/001_atv320_nve41300.sql"];
  const values = await Promise.all(
    paths.map(async (path) => `${path}\n${await readFile(path, "utf8")}`),
  );
  return createHash("sha256").update(values.join("\n\0\n")).digest("hex");
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
  "R292：正式第六版主链必须在十二条已暴露工单上完成真实模型升级回归",
  {
    skip: process.env.RUN_QWEN_SOURCE_AWARE_MAIN_CHAIN_REGRESSION_V2 !== "1",
    timeout: 900_000,
  },
  async () => {
    const [sourceDataset, preRunRaw] = await Promise.all([
      loadWorkOrderEndToEndHoldoutV3(),
      readFile(
        "reports/work-order-source-aware-main-chain-regression-v2-prerun.json",
        "utf8",
      ),
    ]);
    const preRun = JSON.parse(preRunRaw) as {
      status: string;
      data_role: string;
      frozen_inputs: Array<{ path: string; sha256: string }>;
      database_bundle_sha256: string;
      strategy: { embedding_model_file_sha256: string };
      acceptance_target: {
        exact_case_count: number;
        safety_case_pass_count: number;
        unsafe_proposal_count_maximum: number;
        judge_error_count_maximum: number;
      };
    };
    assert.equal(preRun.status, "frozen_before_exposed_regression_run");
    assert.equal(preRun.data_role, "exposed_regression_not_unseen");
    assert.equal(preRun.frozen_inputs.length, frozenPaths.length);
    for (const item of preRun.frozen_inputs) {
      assert.ok(frozenPaths.includes(item.path as (typeof frozenPaths)[number]));
      assert.equal(await sha256File(item.path), item.sha256, `${item.path} changed`);
    }
    assert.equal(await databaseBundleSha256(), preRun.database_bundle_sha256);
    assert.equal(
      preRun.strategy.embedding_model_file_sha256,
      MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
    );

    const dataset = {
      ...sourceDataset,
      dataset_id: "work-order-source-aware-main-chain-regression-v2",
      dataset_role: "exposed_regression_not_unseen",
      purpose: "验证正式主链从第五版升级到带数据库来源身份的第六版后，十二条已暴露工单仍形成预期终态。",
      strategy: {
        ...sourceDataset.strategy,
        judge_prompt_version: "answerability-v6-source-aware",
      },
      acceptance_targets: {
        case_exact_count_minimum: preRun.acceptance_target.exact_case_count,
        safety_case_pass_count_minimum:
          preRun.acceptance_target.safety_case_pass_count,
        unsafe_proposal_count_maximum:
          preRun.acceptance_target.unsafe_proposal_count_maximum,
        judge_error_count_maximum:
          preRun.acceptance_target.judge_error_count_maximum,
      },
      interpretation_limits: [
        "十二条工单和U301问题已经暴露，本轮只能证明正式主链升级回归。",
        "项目自建题不能代表真实工厂准确率。",
        "资料和低风险用途尚未获得ATV320领域工程师审核。",
      ],
    } as unknown as WorkOrderEndToEndHoldoutV2;

    const cacheDirectory = "tmp/huggingface-cache";
    const embedder = await createMultilingualE5SmallEmbedder({
      cacheDirectory,
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
    });
    const modelPath = `${cacheDirectory}/${embedder.modelId}/${embedder.modelRevision}/${MULTILINGUAL_E5_SMALL_MODEL_FILE}`;
    assert.equal(await sha256File(modelPath), MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256);

    const environment = {
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
      QWEN_COORDINATOR_MODEL: "qwen3.7-plus",
    };
    const startedAt = performance.now();
    const result = await executeWorkOrderEndToEndHoldoutV2({
      dataset,
      embedder,
      createMainChain(database, runtimeEmbedder) {
        return createWorkOrderMainChainFromEnvironment(
          database,
          runtimeEmbedder,
          environment,
        );
      },
    });
    const report = {
      regression_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      data_role: "exposed_regression_not_unseen",
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      e5_model_file_sha256: MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
      main_chain: {
        coordinator_prompt_version: "coordinator-v3-state-bound",
        answerability_prompt_version: "answerability-v6-source-aware",
        source_identity_binding: "database-source-chain-v1",
      },
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-work-order-source-aware-main-chain-regression-v2-result.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );

    assert.equal(report.exact_case_count, preRun.acceptance_target.exact_case_count);
    assert.equal(
      report.safety_case_pass_count,
      preRun.acceptance_target.safety_case_pass_count,
    );
    assert.equal(
      report.unsafe_proposal_count,
      preRun.acceptance_target.unsafe_proposal_count_maximum,
    );
    assert.equal(
      report.judge_error_count,
      preRun.acceptance_target.judge_error_count_maximum,
    );
    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);


