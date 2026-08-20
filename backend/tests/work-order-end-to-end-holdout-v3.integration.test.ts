import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createQwenCoordinatorModelV3FromEnvironment } from "../src/coordinator/qwen-coordinator-runtime-v3.ts";
import type { WorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import { loadWorkOrderEndToEndHoldoutV3 } from "../src/evaluation/work-order-end-to-end-holdout-v3-dataset.ts";
import { executeWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-executor.ts";
import { createQwenAnswerabilityJudgeV5FromEnvironment } from "../src/evaluation/qwen-answerability-judge-v5.ts";
import {
  createMultilingualE5SmallEmbedder,
  MULTILINGUAL_E5_SMALL_MODEL_FILE,
  MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
} from "../src/retrieval/multilingual-e5-small.ts";

const toolChainPaths = [
  "src/agent-tools/assess-evidence-and-run-risk.ts",
  "src/agent-tools/assess-work-order-evidence.ts",
  "src/agent-tools/draft-resolution-proposal.ts",
  "src/agent-tools/get-work-order-context.ts",
  "src/agent-tools/record-user-confirmation.ts",
  "src/agent-tools/request-user-confirmation.ts",
  "src/agent-tools/run-risk-assessment.ts",
  "src/agent-tools/search-official-knowledge.ts",
  "src/coordinator/run-work-order-coordinator.ts",
  "src/knowledge/create-knowledge-chunk-candidate.ts",
  "src/knowledge/review-knowledge-chunk.ts",
  "src/retrieval/index-approved-knowledge-chunk.ts",
  "src/work-orders/create-draft-work-order.ts",
  "src/work-orders/transition-work-order.ts",
] as const;

async function readBundle(paths: readonly string[]): Promise<string> {
  const values = await Promise.all(
    paths.map(async (path) => `${path}\n${await readFile(path, "utf8")}`),
  );
  return values.join("\n\0\n");
}

async function loadFrozenInputs(): Promise<Record<string, string>> {
  const migrations = (await readdir("database/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `database/migrations/${name}`);
  const paths = [
    "data/evaluation/work-order-end-to-end-holdout-v3.json",
    "src/evaluation/work-order-end-to-end-holdout-v3-dataset.ts",
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
    "data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
    "src/evaluation/qwen-answerability-judge-v5.ts",
    "src/coordinator/qwen-coordinator-model.ts",
    "src/coordinator/qwen-coordinator-runtime.ts",
    "src/coordinator/qwen-coordinator-model-v3.ts",
    "src/coordinator/qwen-coordinator-runtime-v3.ts",
    "src/evaluation/work-order-end-to-end-holdout-v2-executor.ts",
    "src/evaluation/work-order-end-to-end-holdout-v2-runner.ts",
    "src/retrieval/multilingual-e5-small.ts",
    "tests/work-order-end-to-end-holdout-v3.integration.test.ts",
  ] as const;
  const entries = await Promise.all(
    paths.map(async (path) => [path, await readFile(path, "utf8")] as const),
  );
  return {
    ...Object.fromEntries(entries),
    "database/migrations+seed": await readBundle([
      ...migrations,
      "database/seeds/001_atv320_nve41300.sql",
    ]),
    "src/work-order-tool-chain": await readBundle(toolChainPaths),
  };
}

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
  "R282：状态绑定修复后必须在十二条全新工单上通过真实端到端能力门",
  {
    skip: process.env.RUN_QWEN_WORK_ORDER_END_TO_END_V3 !== "1",
    timeout: 600_000,
  },
  async () => {
    const [dataset, frozenInputs, preRunRaw] = await Promise.all([
      loadWorkOrderEndToEndHoldoutV3(),
      loadFrozenInputs(),
      readFile("reports/work-order-end-to-end-holdout-v3-prerun.json", "utf8"),
    ]);
    const preRun = JSON.parse(preRunRaw) as {
      status: string;
      dataset_role: string;
      strategy: { embedding_model_file_sha256: string };
      frozen_inputs: Array<{ path: string; sha256: string }>;
    };
    assert.equal(preRun.status, "frozen_before_first_model_run");
    assert.equal(
      preRun.dataset_role,
      "project_authored_unseen_end_to_end_before_first_run",
    );
    assert.equal(
      preRun.strategy.embedding_model_file_sha256,
      MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
    );
    assert.equal(preRun.frozen_inputs.length, Object.keys(frozenInputs).length);
    const remaining = new Map(Object.entries(frozenInputs));
    for (const item of preRun.frozen_inputs) {
      const content = remaining.get(item.path);
      assert.ok(content !== undefined, `unknown frozen input ${item.path}`);
      assert.equal(
        createHash("sha256").update(content).digest("hex"),
        item.sha256,
        `${item.path} changed after pre-run freeze`,
      );
      remaining.delete(item.path);
    }
    assert.equal(remaining.size, 0);

    const cacheDirectory = "tmp/huggingface-cache";
    const embedder = await createMultilingualE5SmallEmbedder({
      cacheDirectory,
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
    });
    const modelPath = `${cacheDirectory}/${embedder.modelId}/${embedder.modelRevision}/${MULTILINGUAL_E5_SMALL_MODEL_FILE}`;
    assert.equal(
      await sha256File(modelPath),
      MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
    );
    const judge = createQwenAnswerabilityJudgeV5FromEnvironment(process.env);
    const coordinatorModel =
      createQwenCoordinatorModelV3FromEnvironment(process.env);
    const startedAt = performance.now();
    const result = await executeWorkOrderEndToEndHoldoutV2({
      dataset: dataset as unknown as WorkOrderEndToEndHoldoutV2,
      embedder,
      judge,
      coordinatorModel,
    });
    const report = {
      first_model_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      e5_model_file_sha256: MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-work-order-end-to-end-holdout-v3-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);
