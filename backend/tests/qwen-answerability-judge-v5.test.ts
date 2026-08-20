import assert from "node:assert/strict";
import test from "node:test";

async function loadJudgeV5() {
  try {
    return await import("../src/evaluation/qwen-answerability-judge-v5.ts");
  } catch {
    assert.fail("第五版两阶段事实判断与证据选择策略尚未实现");
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

const candidates = [
  {
    id: "manual-reset",
    sectionTitle: "手动清除错误",
    sources: [{ pageNumber: 310, text: "分配的输入或位将变为 1。" }],
  },
];

test("R250：第五版相关问题必须先判断事实再单独选择证据", async () => {
  const { createQwenAnswerabilityJudgeV5 } = await loadJudgeV5();
  const prompts: string[] = [];
  const outputs = [
    {
      sameBusinessObject: true,
      premiseSupported: true,
      requestedFactSupported: false,
      reason: "同一设备且资料支持输入位变为1，但没有毫秒数。",
    },
    {
      candidateId: "manual-reset",
      sourcePageNumber: 310,
      supportingQuote: "分配的输入或位将变为 1。",
      reason: "该原文支持问题前提。",
    },
  ];
  let callIndex = 0;
  const judge = createQwenAnswerabilityJudgeV5({
    apiKey: "test-only-key",
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      prompts.push(
        body.messages.find(({ role }) => role === "system")?.content ?? "",
      );
      return providerResponse(outputs[callIndex++]);
    },
  });

  const decision = await judge.judge({
    question: "手动复位输入保持为1的脉冲宽度需要多少毫秒？",
    candidates,
  });

  assert.equal(judge.promptVersion, "answerability-v5-two-stage");
  assert.equal(callIndex, 2);
  assert.equal(decision.verdict, "partially_related");
  assert.equal(decision.candidateId, "manual-reset");
  assert.match(prompts[0], /只判断三个布尔事实/);
  assert.match(prompts[0], /最终类别由程序生成/);
  assert.match(prompts[1], /只负责选择支持问题前提的证据/);
  assert.match(prompts[1], /连续逐字原文.*不得拼接/s);
});

test("R251：第五版不同业务对象必须由程序直接拒答且不发起证据调用", async () => {
  const { createQwenAnswerabilityJudgeV5 } = await loadJudgeV5();
  let calls = 0;
  const judge = createQwenAnswerabilityJudgeV5({
    apiKey: "test-only-key",
    fetchImplementation: async () => {
      calls += 1;
      return providerResponse({
        sameBusinessObject: false,
        premiseSupported: false,
        requestedFactSupported: false,
        reason: "网站和变频器属于不同业务对象。",
      });
    },
  });

  const decision = await judge.judge({
    question: "网站关闭错误检测后由哪个平台监控？",
    candidates,
  });

  assert.equal(calls, 1);
  assert.deepEqual(decision, {
    verdict: "not_answerable",
    candidateId: null,
    sourcePageNumber: null,
    supportingQuote: null,
    reason: "网站和变频器属于不同业务对象。",
  });
});

test("R252：第五版必须拒绝矛盾事实和伪造证据", async () => {
  const { createQwenAnswerabilityJudgeV5 } = await loadJudgeV5();
  const contradictory = createQwenAnswerabilityJudgeV5({
    apiKey: "test-only-key",
    fetchImplementation: async () =>
      providerResponse({
        sameBusinessObject: false,
        premiseSupported: true,
        requestedFactSupported: false,
        reason: "矛盾输出。",
      }),
  });
  await assert.rejects(
    contradictory.judge({ question: "网站问题", candidates }),
    /answerability v5 model facts/,
  );

  const outputs = [
    {
      sameBusinessObject: true,
      premiseSupported: true,
      requestedFactSupported: false,
      reason: "同一对象并支持前提。",
    },
    {
      candidateId: "manual-reset",
      sourcePageNumber: 310,
      supportingQuote: "资料里不存在的伪造句子。",
      reason: "伪造证据。",
    },
  ];
  let callIndex = 0;
  const forged = createQwenAnswerabilityJudgeV5({
    apiKey: "test-only-key",
    fetchImplementation: async () => providerResponse(outputs[callIndex++]),
  });
  await assert.rejects(
    forged.judge({ question: "脉冲宽度是多少？", candidates }),
    /supportingQuote is not in the source/,
  );
});

test("R285：第六版必须在两阶段请求中保留独立的资料编号、版本和语言", async () => {
  const { createQwenAnswerabilityJudgeV6 } = await import(
    "../src/evaluation/qwen-answerability-judge-v6.ts"
  );
  const receivedCandidates: Array<Record<string, unknown>> = [];
  const outputs = [
    {
      sameBusinessObject: true,
      premiseSupported: true,
      requestedFactSupported: true,
      reason: "资料编号和原文共同支持问题。",
    },
    {
      candidateId: "41",
      sourcePageNumber: 395,
      supportingQuote: "解决措施 检查电机负载、变频器通风情况和环境温度。",
      reason: "指定资料原文直接列出三项检查。",
    },
  ];
  let callIndex = 0;
  const judge = createQwenAnswerabilityJudgeV6({
    apiKey: "test-only-key",
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userContent = JSON.parse(
        body.messages.find(({ role }) => role === "user")!.content,
      ) as { candidates: Array<Record<string, unknown>> };
      receivedCandidates.push(userContent.candidates[0]);
      return providerResponse(outputs[callIndex++]);
    },
  });
  const decision = await judge.judge({
    question: "NVE41300的OHF解决措施列出了哪三项检查？",
    candidates: [
      {
        id: "41",
        sectionTitle: "变频器过热的核查项",
        documentReference: "NVE41300",
        versionLabel: "05",
        languageCode: "zh-CN",
        sources: [
          {
            pageNumber: 395,
            text: "解决措施 检查电机负载、变频器通风情况和环境温度。",
          },
        ],
      },
    ],
  });
  assert.equal(judge.promptVersion, "answerability-v6-source-aware");
  assert.equal(callIndex, 2);
  assert.equal(decision.verdict, "directly_answerable");
  assert.equal(receivedCandidates.length, 2);
  for (const candidate of receivedCandidates) {
    assert.equal(candidate.documentReference, "NVE41300");
    assert.equal(candidate.versionLabel, "05");
    assert.equal(candidate.languageCode, "zh-CN");
  }
});
