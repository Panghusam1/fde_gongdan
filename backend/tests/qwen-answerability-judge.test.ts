import assert from "node:assert/strict";
import test from "node:test";

async function loadAnswerabilityJudge() {
  try {
    return await import("../src/evaluation/qwen-answerability-judge.ts");
  } catch {
    assert.fail("独立证据存在性判断器尚未实现");
  }
}

function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const candidates = [
  {
    id: "ohf-fault-definition",
    sectionTitle: "检测到的错误代码",
    sources: [{ pageNumber: 72, text: "OHF：设备过热。" }],
  },
  {
    id: "ohf-thermal-threshold",
    sectionTitle: "变频器热状态",
    sources: [{ pageNumber: 50, text: "118%为OHF阈值。" }],
  },
  {
    id: "ohf-reset",
    sectionTitle: "故障复位",
    sources: [{ pageNumber: 310, text: "原因消失后可手动清除OHF。" }],
  },
  {
    id: "power-isolation",
    sectionTitle: "不可复位故障",
    sources: [
      {
        pageNumber: 385,
        text: "断开所有电源并锁定隔离开关，等待15分钟，测量PA/+和PC/-之间的直流母线电压，确保低于42 Vdc。",
      },
    ],
  },
  {
    id: "restart-warning",
    sectionTitle: "产品重启",
    sources: [{ pageNumber: 310, text: "重启可能导致未预期的设备运行。" }],
  },
];

test("R205：证据判断器能从E5前五候选中选中第四位的直接答案", async () => {
  const {
    createQwenAnswerabilityJudge,
    QWEN_ANSWERABILITY_MODEL_ID,
    QWEN_ANSWERABILITY_PROMPT_VERSION,
  } = await loadAnswerabilityJudge();
  let capturedBody: Record<string, unknown> | null = null;
  const judge = createQwenAnswerabilityJudge({
    apiKey: "test-only-key",
    fetchImplementation: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(
        JSON.stringify({
          verdict: "directly_answerable",
          candidateId: "power-isolation",
          sourcePageNumber: 385,
          supportingQuote:
            "断开所有电源并锁定隔离开关，等待15分钟，测量PA/+和PC/-之间的直流母线电压，确保低于42 Vdc。",
          reason: "原文直接给出了隔离、等待、测量位置和电压条件。",
        }),
      );
    },
  });

  const decision = await judge.judge({
    question: "测量PA/+和PC/-以前要做什么？",
    candidates,
  });

  assert.deepEqual(decision, {
    verdict: "directly_answerable",
    candidateId: "power-isolation",
    sourcePageNumber: 385,
    supportingQuote:
      "断开所有电源并锁定隔离开关，等待15分钟，测量PA/+和PC/-之间的直流母线电压，确保低于42 Vdc。",
    reason: "原文直接给出了隔离、等待、测量位置和电压条件。",
  });
  assert.equal(judge.modelId, QWEN_ANSWERABILITY_MODEL_ID);
  assert.equal(judge.promptVersion, QWEN_ANSWERABILITY_PROMPT_VERSION);
  assert.equal(capturedBody?.model, QWEN_ANSWERABILITY_MODEL_ID);
  assert.deepEqual(capturedBody?.response_format, { type: "json_object" });
  assert.equal(capturedBody?.enable_thinking, false);
  assert.equal(capturedBody?.temperature, 0);
  assert.equal(Object.hasOwn(capturedBody ?? {}, "max_tokens"), false);
  const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(systemPrompt, /只能使用候选资料中的原文/);
  assert.match(systemPrompt, /directly_answerable/);
  assert.match(systemPrompt, /partially_related/);
  assert.match(systemPrompt, /not_answerable/);
});

test("R206：模型伪造原文、资料编号或拒答字段时必须被程序拒绝", async () => {
  const { createQwenAnswerabilityJudge } = await loadAnswerabilityJudge();
  const outputs = [
    {
      verdict: "directly_answerable",
      candidateId: "ohf-thermal-threshold",
      sourcePageNumber: 50,
      supportingQuote: "本产品保修期为两年。",
      reason: "声称能够回答保修问题。",
    },
    {
      verdict: "directly_answerable",
      candidateId: "made-up-document",
      sourcePageNumber: 999,
      supportingQuote: "伪造内容",
      reason: "声称存在资料。",
    },
    {
      verdict: "not_answerable",
      candidateId: "ohf-fault-definition",
      sourcePageNumber: 72,
      supportingQuote: "OHF：设备过热。",
      reason: "当前资料没有保修信息。",
    },
  ];

  for (const output of outputs) {
    const judge = createQwenAnswerabilityJudge({
      apiKey: "test-only-key",
      fetchImplementation: async () => jsonResponse(JSON.stringify(output)),
    });
    await assert.rejects(
      judge.judge({ question: "这台变频器保修几年？", candidates }),
      /answerability decision/,
    );
  }
});

test("R207：判断器在联网前拒绝空问题、重复候选和超过五份候选", async () => {
  const { createQwenAnswerabilityJudge } = await loadAnswerabilityJudge();
  let calls = 0;
  const judge = createQwenAnswerabilityJudge({
    apiKey: "test-only-key",
    fetchImplementation: async () => {
      calls += 1;
      return jsonResponse("{}");
    },
  });

  await assert.rejects(
    judge.judge({ question: "  ", candidates }),
    /question/,
  );
  await assert.rejects(
    judge.judge({
      question: "OHF是什么？",
      candidates: [candidates[0], candidates[0]],
    }),
    /candidate IDs must be unique/,
  );
  await assert.rejects(
    judge.judge({
      question: "OHF是什么？",
      candidates: [...candidates, { ...candidates[0], id: "sixth" }],
    }),
    /at most five candidates/,
  );
  assert.equal(calls, 0);
});

test("R210：百炼配置只能设置连接参数且缺少密钥时不得联网", async () => {
  const { createQwenAnswerabilityJudgeFromEnvironment } =
    await loadAnswerabilityJudge();
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;
  const judge = createQwenAnswerabilityJudgeFromEnvironment(
    {
      DASHSCOPE_API_KEY: "test-only-key",
      DASHSCOPE_BASE_URL:
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
      PROVIDER_TIMEOUT_SECONDS: "45",
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
    },
    {
      fetchImplementation: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(
          JSON.stringify({
            verdict: "not_answerable",
            candidateId: null,
            sourcePageNumber: null,
            supportingQuote: null,
            reason: "没有保修信息。",
          }),
        );
      },
    },
  );

  await judge.judge({ question: "保修几年？", candidates });
  assert.equal(
    capturedUrl,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(judge.modelId, "qwen3.7-plus");
  assert.equal(capturedBody?.model, "qwen3.7-plus");
  assert.throws(
    () => createQwenAnswerabilityJudgeFromEnvironment({}),
    /DASHSCOPE_API_KEY/,
  );
  assert.throws(
    () =>
      createQwenAnswerabilityJudgeFromEnvironment({
        DASHSCOPE_API_KEY: "test-only-key",
        PROVIDER_TIMEOUT_SECONDS: "0",
      }),
    /PROVIDER_TIMEOUT_SECONDS/,
  );
});

test("R212：同一页有多段来源时允许引用其中任一真实原文", async () => {
  const { createQwenAnswerabilityJudge } = await loadAnswerabilityJudge();
  const judge = createQwenAnswerabilityJudge({
    apiKey: "test-only-key",
    fetchImplementation: async () =>
      jsonResponse(
        JSON.stringify({
          verdict: "directly_answerable",
          candidateId: "manual-reset",
          sourcePageNumber: 310,
          supportingQuote: "OHF属于可手动清除的错误。",
          reason: "第二段原文明确列出OHF。",
        }),
      ),
  });

  const decision = await judge.judge({
    question: "OHF能否手动清除？",
    candidates: [
      {
        id: "manual-reset",
        sectionTitle: "故障复位",
        sources: [
          { pageNumber: 310, text: "原因消失后可以手动清除。" },
          { pageNumber: 310, text: "OHF属于可手动清除的错误。" },
        ],
      },
    ],
  });

  assert.equal(decision.candidateId, "manual-reset");
  assert.equal(decision.supportingQuote, "OHF属于可手动清除的错误。");
});

test("R216：PDF换行或空格差异不能把逐字引用误判为伪造", async () => {
  const { createQwenAnswerabilityJudge } = await loadAnswerabilityJudge();
  const judge = createQwenAnswerabilityJudge({
    apiKey: "test-only-key",
    fetchImplementation: async () =>
      jsonResponse(
        JSON.stringify({
          verdict: "directly_answerable",
          candidateId: "disable-danger",
          sourcePageNumber: 329,
          supportingQuote: "进行充分与相应响应的其他监控功能。",
          reason: "原文要求提供替代监控。",
        }),
      ),
  });

  const decision = await judge.judge({
    question: "为什么需要替代监控？",
    candidates: [
      {
        id: "disable-danger",
        sectionTitle: "错误检测禁用",
        sources: [
          {
            pageNumber: 329,
            text: "进行充分\n与相应响应的其他监控功能。",
          },
        ],
      },
    ],
  });

  assert.equal(decision.verdict, "directly_answerable");
});
