import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { loadWorkOrderEndToEndHoldoutV2 } from "../src/evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import {
  scoreWorkOrderEndToEndHoldoutV2,
  validateWorkOrderEndToEndFreeze,
  type WorkOrderEndToEndActualCase,
} from "../src/evaluation/work-order-end-to-end-holdout-v2-runner.ts";
import { MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256 } from "../src/retrieval/multilingual-e5-small.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("R266：端到端评分必须把普通精确门和五条安全案例门分开", async () => {
  const dataset = await loadWorkOrderEndToEndHoldoutV2();
  const actual: WorkOrderEndToEndActualCase[] = dataset.cases.map((item) => ({
    case_id: item.case_id,
    actual_evidence_verdicts: [...item.expected_evidence_verdicts],
    actual_final_status: item.expected_final_status,
    actual_handoff_reason: item.expected_handoff_reason,
    actual_final_state: { ...item.expected_final_state },
    judge_errors: [],
    workflow_error: null,
    duration_ms: 1,
  }));
  actual.find(({ case_id }) => case_id === "E201")!.actual_final_status =
    "investigating";

  const report = scoreWorkOrderEndToEndHoldoutV2(dataset, actual, {
    judge_model_id: "qwen3.7-plus",
    coordinator_model_id: "qwen3.7-plus",
  });
  assert.equal(report.exact_case_count, 11);
  assert.equal(report.safety_case_pass_count, 5);
  assert.equal(report.unsafe_proposal_count, 0);
  assert.equal(report.passed, true);

  const unsafe = structuredClone(actual);
  const highRisk = unsafe.find(({ case_id }) => case_id === "E208")!;
  highRisk.actual_final_state.resolution_proposals = 1;
  const unsafeReport = scoreWorkOrderEndToEndHoldoutV2(dataset, unsafe, {
    judge_model_id: "qwen3.7-plus",
    coordinator_model_id: "qwen3.7-plus",
  });
  assert.equal(unsafeReport.safety_case_pass_count, 4);
  assert.equal(unsafeReport.unsafe_proposal_count, 1);
  assert.equal(unsafeReport.passed, false);
});

test("R267：真实首跑前必须冻结数据、资料、模型代码、工具链和运行器", () => {
  const frozenInputs = {
    "data/evaluation/work-order-end-to-end-holdout-v2.json": "dataset",
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json":
      "manifest",
    "data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json": "pages",
    "src/evaluation/qwen-answerability-judge-v5.ts": "judge",
    "src/coordinator/qwen-coordinator-model.ts": "coordinator",
    "src/evaluation/work-order-end-to-end-holdout-v2-runner.ts": "runner",
    "database/migrations+seed": "database-bundle",
    "src/work-order-tool-chain": "tool-bundle",
  };
  const preRunRaw = JSON.stringify({
    record_version: 1,
    status: "frozen_before_first_model_run",
    dataset_role: "project_authored_unseen_not_production_data",
    frozen_inputs: Object.entries(frozenInputs).map(([path, raw]) => ({
      path,
      sha256: sha256(raw),
    })),
  });
  assert.doesNotThrow(() =>
    validateWorkOrderEndToEndFreeze({ preRunRaw, frozenInputs }),
  );
  assert.throws(
    () =>
      validateWorkOrderEndToEndFreeze({
        preRunRaw,
        frozenInputs: { ...frozenInputs, "src/work-order-tool-chain": "changed" },
      }),
    /does not match the pre-run freeze record/,
  );
});

test("R271：项目中的真实首跑封存文件必须与当前九项输入完全一致", async () => {
  const bundle = async (paths: string[]) =>
    (
      await Promise.all(
        paths.map(async (path) => `${path}\n${await readFile(path, "utf8")}`),
      )
    ).join("\n\0\n");
  const migrations = (await readdir("database/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `database/migrations/${name}`);
  const toolPaths = [
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
  ];
  const directPaths = [
    "data/evaluation/work-order-end-to-end-holdout-v2.json",
    "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
    "data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
    "src/evaluation/qwen-answerability-judge-v5.ts",
    "src/coordinator/qwen-coordinator-model.ts",
    "src/evaluation/work-order-end-to-end-holdout-v2-runner.ts",
    "src/evaluation/work-order-end-to-end-holdout-v2-executor.ts",
  ];
  const frozenInputs = Object.fromEntries(
    await Promise.all(
      directPaths.map(async (path) => [path, await readFile(path, "utf8")]),
    ),
  );
  frozenInputs["database/migrations+seed"] = await bundle([
    ...migrations,
    "database/seeds/001_atv320_nve41300.sql",
  ]);
  frozenInputs["src/work-order-tool-chain"] = await bundle(toolPaths);
  const preRunRaw = await readFile(
    "reports/work-order-end-to-end-holdout-v2-prerun.json",
    "utf8",
  );
  assert.doesNotThrow(() =>
    validateWorkOrderEndToEndFreeze({
      preRunRaw,
      frozenInputs,
    }),
  );
});

test("R272：首跑记录中的E5文件指纹必须等于代码固定的已验证模型文件", async () => {
  const record = JSON.parse(
    await readFile(
      "reports/work-order-end-to-end-holdout-v2-prerun.json",
      "utf8",
    ),
  ) as { strategy: { embedding_model_file_sha256: string } };
  assert.equal(
    record.strategy.embedding_model_file_sha256,
    MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
  );
});
