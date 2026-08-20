import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createQwenCoordinatorModelFromEnvironment } from "../src/coordinator/qwen-coordinator-runtime.ts";
import { loadWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import { executeWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-executor.ts";
import { createQwenAnswerabilityJudgeV5FromEnvironment } from "../src/evaluation/qwen-answerability-judge-v5.ts";
import { validateWorkOrderEndToEndFreeze } from "../src/evaluation/work-order-end-to-end-holdout-v2-runner.ts";
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
  return {
    "data/evaluation/work-order-end-to-end-holdout-v2.json": await readFile(
      "data/evaluation/work-order-end-to-end-holdout-v2.json",
      "utf8",
    ),
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json":
      await readFile(
        "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
        "utf8",
      ),
    "data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json":
      await readFile(
        "data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        "utf8",
      ),
    "src/evaluation/qwen-answerability-judge-v5.ts": await readFile(
      "src/evaluation/qwen-answerability-judge-v5.ts",
      "utf8",
    ),
    "src/coordinator/qwen-coordinator-model.ts": await readFile(
      "src/coordinator/qwen-coordinator-model.ts",
      "utf8",
    ),
    "src/evaluation/work-order-end-to-end-holdout-v2-runner.ts":
      await readFile(
        "src/evaluation/work-order-end-to-end-holdout-v2-runner.ts",
        "utf8",
      ),
    "src/evaluation/work-order-end-to-end-holdout-v2-executor.ts":
      await readFile(
        "src/evaluation/work-order-end-to-end-holdout-v2-executor.ts",
        "utf8",
      ),
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
  "R270：固定E5与真实千问必须在十二条未见工单上通过端到端数据库能力门",
  {
    skip: process.env.RUN_QWEN_WORK_ORDER_END_TO_END_V2 !== "1",
    timeout: 600_000,
  },
  async () => {
    const [dataset, frozenInputs, preRunRaw] = await Promise.all([
      loadWorkOrderEndToEndHoldoutV2(),
      loadFrozenInputs(),
      readFile("reports/work-order-end-to-end-holdout-v2-prerun.json", "utf8"),
    ]);
    validateWorkOrderEndToEndFreeze({ preRunRaw, frozenInputs });
    const preRun = JSON.parse(preRunRaw) as {
      strategy: {
        embedding_model_file_sha256: string;
        judge_model_id: string;
        coordinator_model_id: string;
      };
    };
    assert.equal(
      preRun.strategy.embedding_model_file_sha256,
      MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
    );

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
    const judge = createQwenAnswerabilityJudgeV5FromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: preRun.strategy.judge_model_id,
    });
    const coordinatorModel = createQwenCoordinatorModelFromEnvironment({
      ...process.env,
      QWEN_COORDINATOR_MODEL: preRun.strategy.coordinator_model_id,
    });
    const startedAt = performance.now();
    const result = await executeWorkOrderEndToEndHoldoutV2({
      dataset,
      embedder,
      judge,
      coordinatorModel,
    });
    const report = {
      first_model_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      e5_model_file_sha256: MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-work-order-end-to-end-holdout-v2-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);
