import assert from "node:assert/strict";
import test from "node:test";

async function loadQwenRuntime() {
  try {
    return await import("../src/coordinator/qwen-coordinator-runtime.ts");
  } catch {
    assert.fail("百炼协调模型环境配置入口尚未实现");
  }
}

function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("R180：百炼基础地址和超时配置必须转换为可调用的协调模型", async () => {
  const { createQwenCoordinatorModelFromEnvironment } = await loadQwenRuntime();
  let capturedUrl = "";
  let capturedSignal: AbortSignal | null | undefined;
  let capturedBody: Record<string, unknown> | null = null;
  const model = createQwenCoordinatorModelFromEnvironment(
    {
      DASHSCOPE_API_KEY: "test-only-key",
      DASHSCOPE_BASE_URL:
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
      PROVIDER_TIMEOUT_SECONDS: "45",
      CREATIVE_MODEL: "qwen3.7-plus",
    },
    {
      fetchImplementation: async (input, init) => {
        capturedUrl = String(input);
        capturedSignal = init?.signal;
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(
          JSON.stringify({
            action: "search_official_knowledge",
            queryText: "OHF 外部低风险检查",
          }),
        );
      },
    },
  );

  await model.decide({
    userMessage: "继续排查",
    workOrderContext: { status: "investigating" },
    allowedActions: ["search_official_knowledge"],
  });

  assert.equal(
    capturedUrl,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(model.modelId, "qwen3.7-plus");
  assert.equal(capturedBody?.model, "qwen3.7-plus");
});

test("R181：缺少密钥或错误超时时间必须在联网前拒绝", async () => {
  const { createQwenCoordinatorModelFromEnvironment } = await loadQwenRuntime();

  assert.throws(
    () => createQwenCoordinatorModelFromEnvironment({}),
    /DASHSCOPE_API_KEY/,
  );
  assert.throws(
    () =>
      createQwenCoordinatorModelFromEnvironment({
        DASHSCOPE_API_KEY: "test-only-key",
        PROVIDER_TIMEOUT_SECONDS: "0",
      }),
    /PROVIDER_TIMEOUT_SECONDS/,
  );
});

test("R275：新版协调模型必须沿用百炼环境配置并标记状态绑定版本", async () => {
  const { createQwenCoordinatorModelV3FromEnvironment } = await import(
    "../src/coordinator/qwen-coordinator-runtime-v3.ts"
  );
  let capturedUrl = "";
  const model = createQwenCoordinatorModelV3FromEnvironment(
    {
      DASHSCOPE_API_KEY: "test-only-key",
      DASHSCOPE_BASE_URL:
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
      PROVIDER_TIMEOUT_SECONDS: "45",
      CREATIVE_MODEL: "qwen3.7-plus",
    },
    {
      fetchImplementation: async (input) => {
        capturedUrl = String(input);
        return jsonResponse(
          JSON.stringify({
            action: "search_official_knowledge",
            queryText: "OHF 外部低风险检查",
          }),
        );
      },
    },
  );
  await model.decide({
    userMessage: "继续排查",
    workOrderContext: { status: "investigating" },
    allowedActions: ["search_official_knowledge"],
  });
  assert.equal(
    capturedUrl,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(model.modelId, "qwen3.7-plus");
  assert.equal(model.promptVersion, "coordinator-v3-state-bound");
});
