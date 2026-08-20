import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("R287：U301真实回归前必须锁定旧报告、单一改动和数据库链路", async () => {
  const record = JSON.parse(
    await readFile("reports/source-aware-u301-regression-prerun.json", "utf8"),
  ) as {
    status: string;
    data_role: string;
    target_case_id: string;
    frozen_inputs: Array<{ path: string; sha256: string }>;
    database_bundle: { paths: string[]; sha256: string };
  };
  assert.equal(record.status, "frozen_before_exposed_regression_run");
  assert.equal(record.data_role, "exposed_regression_not_unseen");
  assert.equal(record.target_case_id, "U301");
  assert.equal(record.frozen_inputs.length, 10);
  for (const item of record.frozen_inputs) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(item.path, "utf8"))
        .digest("hex"),
      item.sha256,
      `${item.path} changed after freeze`,
    );
  }
  const bundle = (
    await Promise.all(
      record.database_bundle.paths.map(
        async (path) => `${path}\n${await readFile(path, "utf8")}`,
      ),
    )
  ).join("\n\0\n");
  assert.equal(
    createHash("sha256").update(bundle).digest("hex"),
    record.database_bundle.sha256,
  );
});
