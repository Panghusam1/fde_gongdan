import assert from "node:assert/strict";
import test from "node:test";

test("R193：千问排序适配器按官方接口发送查询和候选并保留原始编号", async () => {
  const { createQwenReranker } = await import(
    "../src/retrieval/qwen-reranker.ts"
  );
  let requestUrl = "";
  let requestBody: Record<string, unknown> | null = null;
  const reranker = createQwenReranker({
    apiKey: "test-key",
    workspaceId: "ws-test",
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          object: "list",
          results: [
            { index: 1, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.42 },
          ],
          model: "qwen3-rerank",
          id: "request-test",
          usage: { total_tokens: 42 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await reranker.rerank("OHF能否手动复位", [
    "OHF表示设备过热。",
    "错误原因消失后可手动清除OHF。",
  ]);

  assert.equal(
    requestUrl,
    "https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks",
  );
  assert.deepEqual(requestBody, {
    model: "qwen3-rerank",
    query: "OHF能否手动复位",
    documents: ["OHF表示设备过热。", "错误原因消失后可手动清除OHF。"],
    top_n: 2,
    instruct:
      "Given an industrial equipment support query, retrieve passages that directly answer the query, including applicable safety warnings.",
  });
  assert.deepEqual(result, [
    { index: 1, relevanceScore: 0.91 },
    { index: 0, relevanceScore: 0.42 },
  ]);
});

test("R194：排序适配器在联网前拒绝缺失配置并在联网后拒绝非法编号", async () => {
  const { createQwenReranker, createQwenRerankerFromEnvironment } = await import(
    "../src/retrieval/qwen-reranker.ts"
  );
  assert.throws(
    () => createQwenRerankerFromEnvironment({}),
    /QWEN_RERANKER_API_KEY/,
  );
  assert.throws(
    () =>
      createQwenRerankerFromEnvironment({
        DASHSCOPE_API_KEY: "token-plan-key",
        DASHSCOPE_WORKSPACE_ID: "ws-test",
        DASHSCOPE_BASE_URL:
          "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      }),
    /QWEN_RERANKER_API_KEY/,
  );
  const reranker = createQwenReranker({
    apiKey: "test-key",
    workspaceId: "ws-test",
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 3, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.4 },
          ],
          model: "qwen3-rerank",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    reranker.rerank("测试", ["候选一", "候选二"]),
    /result index is invalid/,
  );
});
