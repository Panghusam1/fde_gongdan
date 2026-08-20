import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

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

async function bundle(paths: readonly string[]): Promise<string> {
  return (
    await Promise.all(
      paths.map(async (path) => `${path}\n${await readFile(path, "utf8")}`),
    )
  ).join("\n\0\n");
}

test("R283：新未见工单联网首跑前的十五项输入必须全部匹配封存散列", async () => {
  const record = JSON.parse(
    await readFile("reports/work-order-end-to-end-holdout-v3-prerun.json", "utf8"),
  ) as {
    status: string;
    frozen_inputs: Array<{ path: string; sha256: string }>;
  };
  const migrations = (await readdir("database/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `database/migrations/${name}`);
  assert.equal(record.status, "frozen_before_first_model_run");
  assert.equal(record.frozen_inputs.length, 15);
  for (const item of record.frozen_inputs) {
    const content =
      item.path === "database/migrations+seed"
        ? await bundle([
            ...migrations,
            "database/seeds/001_atv320_nve41300.sql",
          ])
        : item.path === "src/work-order-tool-chain"
          ? await bundle(toolChainPaths)
          : await readFile(item.path, "utf8");
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      item.sha256,
      `${item.path} changed after freeze`,
    );
  }
});
