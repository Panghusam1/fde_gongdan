import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { loadModelTestRegistry } from "../src/evaluation/model-test-registry.ts";

test("R204：每个默认跳过的模型测试都必须登记原因、运行命令和真实状态", async () => {
  const testDirectory = new URL("./", import.meta.url);
  const files = (await readdir(testDirectory)).filter((name) =>
    name.endsWith(".test.ts"),
  );
  const discovered: Array<{
    ruleCode: string;
    testFile: string;
    enableVariable: string;
  }> = [];
  for (const testFile of files) {
    const source = await readFile(new URL(testFile, testDirectory), "utf8");
    const skipPattern =
      /skip:\s*process\.env\.([A-Z0-9_]+)\s*!==\s*"1"/g;
    for (const match of source.matchAll(skipPattern)) {
      const prefix = source.slice(Math.max(0, match.index - 500), match.index);
      const ruleCodes = [...prefix.matchAll(/R(\d+)：/g)];
      assert.ok(ruleCodes.length > 0, `${testFile}的跳过测试缺少规则编号`);
      discovered.push({
        ruleCode: `R${ruleCodes.at(-1)![1]}`,
        testFile: `tests/${testFile}`,
        enableVariable: match[1],
      });
    }
  }

  const registry = await loadModelTestRegistry(
    "data/evaluation/model-test-registry-v1.json",
  );
  assert.deepEqual(
    registry.tests.map((item) => ({
      ruleCode: item.rule_code,
      testFile: item.test_file,
      enableVariable: item.enable_variable,
    })),
    discovered.sort((left, right) =>
      left.ruleCode.localeCompare(right.ruleCode, undefined, { numeric: true }),
    ),
  );
  assert.deepEqual(
    Object.fromEntries(
      registry.tests.map((item) => [item.rule_code, item.last_explicit_run.status]),
    ),
    {
      R133: "passed",
      R182: "passed",
      R183: "passed",
      R187: "passed",
      R196: "blocked",
      R203: "failed",
      R215: "passed",
      R221: "passed",
      R228: "passed",
      R233: "failed",
      R236: "passed",
      R243: "failed",
      R247: "failed",
      R255: "failed",
      R262: "passed",
      R270: "failed",
      R277: "passed",
      R282: "passed",
      R286: "passed",
      R291: "failed",
      R292: "passed",
      R297: "failed",
      R302: "passed",
      R304: "failed",
      R309: "passed",
      R311: "failed",
      R320: "passed",
    },
  );
});
