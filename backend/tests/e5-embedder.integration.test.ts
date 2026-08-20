import assert from "node:assert/strict";
import test from "node:test";

function dot(left: number[], right: number[]): number {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function norm(vector: number[]): number {
  return Math.sqrt(dot(vector, vector));
}

test(
  "R133：真实multilingual-e5-small生成384维归一化向量并区分相关文本",
  { skip: process.env.RUN_E5_INTEGRATION !== "1" },
  async () => {
    let createMultilingualE5SmallEmbedder: Function;
    try {
      ({ createMultilingualE5SmallEmbedder } = await import(
        "../src/retrieval/multilingual-e5-small.ts"
      ));
    } catch {
      assert.fail("真实E5适配器尚未实现");
    }

    const embedder = await createMultilingualE5SmallEmbedder({
      cacheDirectory: "tmp/huggingface-cache",
      localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
      remoteHost: process.env.HF_REMOTE_HOST,
    });
    const query = await embedder.embedQuery("机器外壳摸起来很烫");
    const related = await embedder.embedPassage("OHF表示设备过热。");
    const unrelated = await embedder.embedPassage("Modbus通信地址设置说明。");

    assert.equal(query.length, 384);
    assert.equal(related.length, 384);
    assert.ok(Math.abs(norm(query) - 1) < 0.001);
    assert.ok(Math.abs(norm(related) - 1) < 0.001);
    assert.ok(dot(query, related) > dot(query, unrelated));
  },
);
