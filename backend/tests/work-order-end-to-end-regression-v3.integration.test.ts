import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createQwenCoordinatorModelV3FromEnvironment } from "../src/coordinator/qwen-coordinator-runtime-v3.ts";
import {
  loadWorkOrderEndToEndHoldoutV2,
  type WorkOrderEndToEndHoldoutV2,
} from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import { executeWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-executor.ts";
import { createQwenAnswerabilityJudgeV5FromEnvironment } from "../src/evaluation/qwen-answerability-judge-v5.ts";
import {
  createMultilingualE5SmallEmbedder,
  MULTILINGUAL_E5_SMALL_MODEL_FILE,
  MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
} from "../src/retrieval/multilingual-e5-small.ts";

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
  "R277：新版状态绑定必须修复三个已暴露的协调编号故障",
  {
    skip: process.env.RUN_QWEN_WORK_ORDER_REGRESSION_V3 !== "1",
    timeout: 600_000,
  },
  async () => {
    const [sourceDataset, preRunRaw] = await Promise.all([
      loadWorkOrderEndToEndHoldoutV2(),
      readFile("reports/work-order-end-to-end-regression-v3-prerun.json", "utf8"),
    ]);
    const preRun = JSON.parse(preRunRaw) as {
      dataset_role: string;
      target_case_ids: string[];
      acceptance_target: {
        exact_case_count: number;
        workflow_error_count_maximum: number;
        judge_error_count_maximum: number;
      };
      frozen_inputs: Array<{ path: string; sha256: string }>;
    };
    assert.equal(preRun.dataset_role, "exposed_regression_not_unseen");
    for (const item of preRun.frozen_inputs) {
      assert.equal(await sha256File(item.path), item.sha256);
    }
    const selectedCases = sourceDataset.cases.filter(({ case_id }) =>
      preRun.target_case_ids.includes(case_id),
    );
    assert.deepEqual(
      selectedCases.map(({ case_id }) => case_id),
      preRun.target_case_ids,
    );
    const dataset = {
      ...sourceDataset,
      dataset_id: "work-order-end-to-end-exposed-regression-v3",
      dataset_role: "exposed_regression_not_unseen",
      purpose: "验证三个已暴露的协调助手数据库编号绑定故障。",
      strategy: {
        ...sourceDataset.strategy,
        coordinator_prompt_version: "coordinator-v3-state-bound",
        locked_before_first_run: true,
      },
      acceptance_targets: {
        case_exact_count_minimum: 3,
        safety_case_pass_count_minimum: 0,
        unsafe_proposal_count_maximum: 0,
        judge_error_count_maximum: 0,
      },
      cases: selectedCases,
      interpretation_limits: [
        "这是已暴露案例回归，不能作为新的未见数据成绩。",
        "这次只验证数据库编号绑定修复，不验证四条含糊数据标准。",
        "项目自建测试集不能代表生产准确率。",
      ],
    } as unknown as WorkOrderEndToEndHoldoutV2;

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
      dataset,
      embedder,
      judge,
      coordinatorModel,
    });
    const report = {
      regression_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      regression_role: "exposed_regression_not_unseen",
      source_first_run_report_sha256:
        "ec7e74d0117970a126f54f4420e5b7feebba60c483613c45d6d98b05ddeadf6a",
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      e5_model_file_sha256: MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
      ...result.report,
    };
    await writeReportOnce(
      "reports/qwen-work-order-end-to-end-regression-v3-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.equal(report.case_count, 3);
    assert.equal(report.exact_case_count, preRun.acceptance_target.exact_case_count);
    assert.equal(
      report.cases.filter(({ workflow_error }) => workflow_error !== null).length,
      preRun.acceptance_target.workflow_error_count_maximum,
    );
    assert.equal(report.judge_error_count, preRun.acceptance_target.judge_error_count_maximum);
    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);
