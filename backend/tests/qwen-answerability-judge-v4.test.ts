import assert from "node:assert/strict";
import test from "node:test";

async function loadJudgeV4() {
  try {
    return await import("../src/evaluation/qwen-answerability-judge-v4.ts");
  } catch {
    assert.fail("第四版事实提取加程序裁决策略尚未实现");
  }
}

function providerResponse(content: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("R248：第四版必须让模型输出三个事实并由程序生成最终类别", async () => {
  const { createQwenAnswerabilityJudgeV4 } = await loadJudgeV4();
  const capturedPrompts: string[] = [];
  const outputs = [
    {
      sameBusinessObject: true,
      premiseSupported: true,
      requestedFactSupported: false,
      candidateId: "manual-reset",
      sourcePageNumber: 310,
      supportingQuote: "分配的输入或位将变为 1。",
      reason: "资料支持输入位变为1，但没有脉冲宽度。",
    },
    {
      sameBusinessObject: false,
      premiseSupported: false,
      requestedFactSupported: false,
      candidateId: null,
      sourcePageNumber: null,
      supportingQuote: null,
      reason: "网站与工业设备属于不同业务对象。",
    },
  ];
  let callIndex = 0;
  const judge = createQwenAnswerabilityJudgeV4({
    apiKey: "test-only-key",
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      capturedPrompts.push(
        body.messages.find(({ role }) => role === "system")?.content ?? "",
      );
      return providerResponse(outputs[callIndex++]);
    },
  });
  const candidate = {
    id: "manual-reset",
    sectionTitle: "手动清除错误",
    sources: [{ pageNumber: 310, text: "分配的输入或位将变为 1。" }],
  };

  const partial = await judge.judge({
    question: "手动复位输入保持为1的脉冲宽度需要多少毫秒？",
    candidates: [candidate],
  });
  const unrelated = await judge.judge({
    question: "网站关闭错误检测后由哪个平台监控？",
    candidates: [candidate],
  });

  assert.equal(judge.promptVersion, "answerability-v4-programmatic-verdict");
  assert.equal(partial.verdict, "partially_related");
  assert.equal(partial.candidateId, "manual-reset");
  assert.deepEqual(unrelated, {
    verdict: "not_answerable",
    candidateId: null,
    sourcePageNumber: null,
    supportingQuote: null,
    reason: "网站与工业设备属于不同业务对象。",
  });
  assert.ok(capturedPrompts.every((prompt) =>
    /sameBusinessObject.*premiseSupported.*requestedFactSupported/s.test(prompt),
  ));
  assert.ok(capturedPrompts.every((prompt) =>
    /最终类别由程序.*三个布尔值/s.test(prompt),
  ));
  assert.ok(capturedPrompts.every((prompt) => /问题前提.*最终所求事实/s.test(prompt)));
  assert.ok(capturedPrompts.every((prompt) => /不同业务对象.*false/s.test(prompt)));
  assert.ok(capturedPrompts.every((prompt) => /连续逐字原文.*不得拼接/s.test(prompt)));
});

test("R249：第四版必须拒绝模型缺失布尔事实或自相矛盾的证据字段", async () => {
  const { createQwenAnswerabilityJudgeV4 } = await loadJudgeV4();
  const invalidOutputs = [
    {
      sameBusinessObject: true,
      premiseSupported: true,
      candidateId: "manual-reset",
      sourcePageNumber: 310,
      supportingQuote: "分配的输入或位将变为 1。",
      reason: "缺少一个布尔字段。",
    },
    {
      sameBusinessObject: false,
      premiseSupported: true,
      requestedFactSupported: false,
      candidateId: "manual-reset",
      sourcePageNumber: 310,
      supportingQuote: "分配的输入或位将变为 1。",
      reason: "业务对象不同却声称前提成立。",
    },
  ];

  for (const output of invalidOutputs) {
    const judge = createQwenAnswerabilityJudgeV4({
      apiKey: "test-only-key",
      fetchImplementation: async () => providerResponse(output),
    });
    await assert.rejects(
      judge.judge({
        question: "网站关闭错误检测后由哪个平台监控？",
        candidates: [
          {
            id: "manual-reset",
            sectionTitle: "手动清除错误",
            sources: [
              { pageNumber: 310, text: "分配的输入或位将变为 1。" },
            ],
          },
        ],
      }),
      /answerability v4 model facts/,
    );
  }
});
