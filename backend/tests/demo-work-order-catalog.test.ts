import assert from "node:assert/strict";
import test from "node:test";

import { loadDemoWorkOrderCatalog } from "../src/demo/load-demo-work-order-catalog.ts";

test("R329：每张工单必须返回与当前阶段和业务分支一致的证据预览", async () => {
  const catalog = await loadDemoWorkOrderCatalog();
  const byCase = new Map(catalog.items.map((item) => [item.caseId, item]));

  assert.equal(byCase.get("U301")?.evidencePreview.state, "not_started");
  assert.equal(byCase.get("U303")?.evidencePreview.state, "verified_manual");
  assert.equal(byCase.get("U303")?.evidencePreview.pageNumber, 395);
  assert.match(byCase.get("U303")?.evidencePreview.excerpt ?? "", /电机负载/u);
  assert.equal(byCase.get("U308")?.evidencePreview.state, "risk_blocked");
  assert.equal(byCase.get("U308")?.evidencePreview.excerpt, null);
  assert.equal(byCase.get("U310")?.evidencePreview.state, "insufficient_evidence");
  assert.equal(byCase.get("U312")?.evidencePreview.state, "access_blocked");
  assert.equal(
    byCase.get("DEMO-SOURCE-MISMATCH")?.evidencePreview.state,
    "source_mismatch",
  );
});

test("R330：只有已核验手册的工单可以展示手册图片和原文摘录", async () => {
  const catalog = await loadDemoWorkOrderCatalog();

  for (const item of catalog.items) {
    if (item.evidencePreview.state === "verified_manual") {
      assert.equal(item.evidencePreview.visual, "manual_page");
      assert.equal(typeof item.evidencePreview.excerpt, "string");
      assert.ok((item.evidencePreview.excerpt?.length ?? 0) > 0);
    } else {
      assert.equal(item.evidencePreview.visual, "status_card");
      assert.equal(item.evidencePreview.excerpt, null);
      assert.equal(item.evidencePreview.pageNumber, null);
    }
  }
});
