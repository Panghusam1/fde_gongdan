import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("R65：缺少PDF依赖时应提示可直接执行的安装命令", () => {
  const result = spawnSync(
    "python",
    ["-S", "tools/extract_pdf_pages.py", "--help"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /python -m pip install -r requirements-pages\.txt/);
  assert.doesNotMatch(result.stderr, /Traceback/);
});

test("R66：页级提取工具必须锁定已经验证的pypdf版本", async () => {
  const requirements = await readFile("requirements-pages.txt", "utf8");

  assert.match(requirements, /^pypdf==6\.10\.0\s*$/m);
});

