import assert from "node:assert/strict";
import test from "node:test";

async function loadJudgeV2() {
  try {
    return await import("../src/evaluation/qwen-answerability-judge-v2.ts");
  } catch {
    assert.fail("第二版证据分类提示策略尚未实现");
  }
}

test("R234：第二版提示必须用互斥顺序区分直接回答、部分相关和完全无关", async () => {
  const { createQwenAnswerabilityJudgeV2 } = await loadJudgeV2();
  let systemPrompt = "";
  const judge = createQwenAnswerabilityJudgeV2({
    apiKey: "test-only-key",
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      systemPrompt =
        body.messages.find(({ role }) => role === "system")?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "partially_related",
                  candidateId: "vent-check",
                  sourcePageNumber: 911,
                  supportingQuote:
                    "低风险检查：保持设备完整，仅从外部观察通风口是否被遮挡。",
                  reason: "资料提到通风口，但没有说明它与OHF的因果关系。",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await judge.judge({
    question: "能否确认通风口堵塞就是OHF的直接原因？",
    candidates: [
      {
        id: "vent-check",
        sectionTitle: "外部通风检查",
        sources: [
          {
            pageNumber: 911,
            text: "低风险检查：保持设备完整，仅从外部观察通风口是否被遮挡。",
          },
        ],
      },
    ],
  });

  assert.equal(judge.promptVersion, "answerability-v2");
  assert.equal(result.verdict, "partially_related");
  assert.match(systemPrompt, /必须严格按以下顺序判断/);
  assert.match(systemPrompt, /先判断.*directly_answerable/s);
  assert.match(systemPrompt, /再判断.*partially_related/s);
  assert.match(systemPrompt, /最后才判断.*not_answerable/s);
  assert.match(systemPrompt, /关键对象.*缺少.*关系、数值或步骤/s);
  assert.match(systemPrompt, /通风口.*OHF.*partially_related/s);
});
