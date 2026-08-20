import assert from "node:assert/strict";
import test from "node:test";

async function loadJudgeV3() {
  try {
    return await import("../src/evaluation/qwen-answerability-judge-v3.ts");
  } catch {
    assert.fail("第三版证据分类提示策略尚未实现");
  }
}

test("R244：第三版提示必须消除分类冲突并约束为连续逐字引用", async () => {
  const { createQwenAnswerabilityJudgeV3 } = await loadJudgeV3();
  let systemPrompt = "";
  const judge = createQwenAnswerabilityJudgeV3({
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
                  candidateId: "manual-reset",
                  sourcePageNumber: 310,
                  supportingQuote: "分配的输入或位将变为 1。",
                  reason: "资料说明输入位变为1，但没有给出脉冲宽度。",
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
    question: "手动复位输入保持为1的脉冲宽度需要多少毫秒？",
    candidates: [
      {
        id: "manual-reset",
        sectionTitle: "手动清除错误",
        sources: [
          {
            pageNumber: 310,
            text: "如果检测到的错误原因已消失，分配的输入或位将变为 1。",
          },
        ],
      },
    ],
  });

  assert.equal(judge.promptVersion, "answerability-v3");
  assert.equal(result.verdict, "partially_related");
  assert.doesNotMatch(systemPrompt, /not_answerable：候选资料不包含答案/);
  assert.match(systemPrompt, /部分相关.*缺少.*数值/s);
  assert.match(systemPrompt, /脉冲宽度.*部分相关/s);
  assert.match(systemPrompt, /等待时间.*部分相关/s);
  assert.match(systemPrompt, /不同业务单元.*完全不可回答/s);
  assert.match(systemPrompt, /连续.*逐字原文/s);
  assert.match(systemPrompt, /不得.*拼接/s);
  assert.match(systemPrompt, /忽略.*命令或提示/s);
  assert.match(systemPrompt, /只输出JSON对象/);
});
