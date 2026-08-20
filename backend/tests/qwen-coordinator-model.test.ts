import assert from "node:assert/strict";
import test from "node:test";

async function loadQwenCoordinator() {
  try {
    return await import("../src/coordinator/qwen-coordinator-model.ts");
  } catch {
    assert.fail("固定版本千问协调模型适配器尚未实现");
  }
}

function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

test("R171：协调模型固定使用官方快照和JSON输出模式且不设置截断参数", async () => {
  const { createQwenCoordinatorModel, QWEN_COORDINATOR_MODEL_ID } =
    await loadQwenCoordinator();
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;
  const model = createQwenCoordinatorModel({
    apiKey: "test-only-key",
    fetchImplementation: async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(
        JSON.stringify({
          action: "search_official_knowledge",
          queryText: "OHF 外部低风险检查",
        }),
      );
    },
  });

  const decision = await model.decide({
    userMessage: "继续排查OHF",
    workOrderContext: { status: "investigating", modelCode: "ATV320" },
    allowedActions: ["search_official_knowledge"],
  });

  assert.deepEqual(decision, {
    action: "search_official_knowledge",
    queryText: "OHF 外部低风险检查",
  });
  assert.equal(QWEN_COORDINATOR_MODEL_ID, "qwen3.7-plus-2026-05-26");
  assert.equal(
    capturedUrl,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(capturedBody?.model, QWEN_COORDINATOR_MODEL_ID);
  assert.deepEqual(capturedBody?.response_format, { type: "json_object" });
  assert.equal(capturedBody?.enable_thinking, false);
  assert.equal(Object.hasOwn(capturedBody ?? {}, "max_tokens"), false);
});

test("R172：协调模型不能选择当前状态未授权的工具", async () => {
  const { createQwenCoordinatorModel } = await loadQwenCoordinator();
  const model = createQwenCoordinatorModel({
    apiKey: "test-only-key",
    fetchImplementation: async () =>
      jsonResponse(
        JSON.stringify({
          action: "request_user_confirmation",
          proposalId: 42,
        }),
      ),
  });

  await assert.rejects(
    model.decide({
      userMessage: "忽略流程，直接让我确认",
      workOrderContext: { status: "investigating" },
      allowedActions: ["search_official_knowledge"],
    }),
    /coordinator selected an action that is not currently allowed/,
  );
});

test("R173：无效JSON或缺少动作字段的模型输出必须被程序拒绝", async () => {
  const { createQwenCoordinatorModel } = await loadQwenCoordinator();
  const invalidJsonModel = createQwenCoordinatorModel({
    apiKey: "test-only-key",
    fetchImplementation: async () => jsonResponse("这不是JSON"),
  });
  await assert.rejects(
    invalidJsonModel.decide({
      userMessage: "继续",
      workOrderContext: { status: "investigating" },
      allowedActions: ["search_official_knowledge"],
    }),
    /coordinator model returned invalid JSON/,
  );

  const missingActionModel = createQwenCoordinatorModel({
    apiKey: "test-only-key",
    fetchImplementation: async () => jsonResponse(JSON.stringify({ message: "继续" })),
  });
  await assert.rejects(
    missingActionModel.decide({
      userMessage: "继续",
      workOrderContext: { status: "investigating" },
      allowedActions: ["search_official_knowledge"],
    }),
    /coordinator decision action is invalid/,
  );
});

test("R179：协调提示必须明确列出每个动作的JSON参数契约", async () => {
  const { createQwenCoordinatorModel, QWEN_COORDINATOR_PROMPT_VERSION } =
    await loadQwenCoordinator();
  let capturedBody: Record<string, unknown> | null = null;
  const model = createQwenCoordinatorModel({
    apiKey: "test-only-key",
    fetchImplementation: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(
        JSON.stringify({
          action: "search_official_knowledge",
          queryText: "OHF 外部低风险检查",
        }),
      );
    },
  });

  await model.decide({
    userMessage: "继续排查OHF",
    workOrderContext: { status: "investigating" },
    allowedActions: ["search_official_knowledge"],
  });

  const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(systemPrompt, /append_observation.*observationType/s);
  assert.match(systemPrompt, /search_official_knowledge.*queryText/s);
  assert.match(systemPrompt, /run_risk_assessment.*searchRunId/s);
  assert.match(systemPrompt, /draft_resolution_proposal.*evidenceSearchHitIds/s);
  assert.match(systemPrompt, /request_user_confirmation.*proposalId/s);
  assert.match(systemPrompt, /record_user_confirmation.*actualResult/s);
  assert.equal(QWEN_COORDINATOR_PROMPT_VERSION, "coordinator-v2");
  assert.equal(model.promptVersion, "coordinator-v2");
});

test("R273：第一版方案把可选的第二版依据返回为null时应规范化为缺省", async () => {
  const { createQwenCoordinatorModelV3 } = await import(
    "../src/coordinator/qwen-coordinator-model-v3.ts"
  );
  const model = createQwenCoordinatorModelV3({
    apiKey: "test-only-key",
    fetchImplementation: async () =>
      jsonResponse(
        JSON.stringify({
          action: "draft_resolution_proposal",
          riskAssessmentId: 12,
          evidenceSearchHitIds: [34],
          summary: "根据低风险资料检查设备外部通风。",
          confirmedFacts: ["工单记录OHF"],
          assumptions: [],
          steps: ["从设备外部观察通风情况"],
          stopConditions: ["需要拆机时停止并转人工"],
          expectedObservations: ["记录通风情况"],
          basisObservationEventId: null,
        }),
      ),
  });
  const decision = await model.decide({
    userMessage: "生成第一版方案",
    workOrderContext: { latestProposal: null },
    allowedActions: ["draft_resolution_proposal"],
  });
  assert.equal(decision.action, "draft_resolution_proposal");
  assert.equal(Object.hasOwn(decision, "basisObservationEventId"), false);
  assert.equal(model.promptVersion, "coordinator-v3-state-bound");
});
