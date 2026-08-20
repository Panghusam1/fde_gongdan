import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("独立前端在根地址提供工单演示台", () => {
  assert.equal(existsSync(resolve(root, "app/page.tsx")), true);
  assert.match(read("app/page.tsx"), /Atv320LiveWorkbench/);
});

test("独立前端不再依赖作品集外壳", () => {
  assert.equal(existsSync(resolve(root, "app/layout.tsx")), true);
  assert.doesNotMatch(read("app/layout.tsx"), /site-shell|content\/portfolio/);
  assert.doesNotMatch(
    read("components/projects/atv320-live-workbench.tsx"),
    /href="\/projects\/atv320-workorder-agent"/,
  );
});

test("发布包名称清楚指向工单演示前端", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.name, "atv320-workorder-agent-frontend");
});

test("六种证据状态的图片均随仓库发布", () => {
  const imageNames = [
    "atv320-evidence-provenance-v1.png",
    "atv320-evidence-high-risk-v1.png",
    "atv320-evidence-insufficient-v1.png",
    "atv320-evidence-source-mismatch-v1.png",
    "atv320-evidence-access-blocked-v1.png",
    "atv320-evidence-retrieval-pending-v1.png",
  ];

  for (const imageName of imageNames) {
    assert.equal(
      existsSync(resolve(root, "public/images/projects/atv320", imageName)),
      true,
      `${imageName} should exist`,
    );
  }
});
