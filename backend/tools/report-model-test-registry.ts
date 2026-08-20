import { loadModelTestRegistry } from "../src/evaluation/model-test-registry.ts";

const registry = await loadModelTestRegistry(
  "data/evaluation/model-test-registry-v1.json",
);
for (const item of registry.tests) {
  console.log(
    [
      item.rule_code,
      item.last_explicit_run.status,
      `默认跳过原因：${item.default_skip_reason}`,
      `最近结果：${item.last_explicit_run.summary}`,
      `运行命令：${item.explicit_command}`,
      `证据：${item.last_explicit_run.evidence_paths.join(", ")}`,
    ].join("\n"),
  );
  console.log("");
}
