import assert from "node:assert/strict";
import test from "node:test";

import { createQwenAnswerabilityJudgeV8 } from "../src/evaluation/qwen-answerability-judge-v8.ts";

function providerResponse(content: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("R305：第八版必须逐候选隔离判断，并承认列举对象可以回答范围类问题", async () => {
  const candidateCounts: number[] = [];
  const systemPrompts: string[] = [];
  const judge = createQwenAnswerabilityJudgeV8({
    apiKey: "test-only-key",
    modelId: "qwen3.7-plus",
    fetchImplementation: async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const system = body.messages.find(({ role }) => role === "system")?.content ?? "";
      const user = JSON.parse(
        body.messages.find(({ role }) => role === "user")!.content,
      ) as {
        candidates: Array<{
          id: string;
          versionLabel: string;
          sources: Array<{ pageNumber: number; text: string }>;
        }>;
      };
      candidateCounts.push(user.candidates.length);
      systemPrompts.push(system);
      const candidate = user.candidates[0];
      if (candidate.versionLabel === "04") {
        return providerResponse({
          sameBusinessObject: false,
          premiseSupported: false,
          requestedFactSupported: false,
          reason: "版本不匹配。",
        });
      }
      if (system.includes("证据摘录员")) {
        return providerResponse({
          candidateId: candidate.id,
          sourcePageNumber: candidate.sources[0].pageNumber,
          supportingQuote: candidate.sources[0].text,
          reason: "列举内容回答了检查范围。",
        });
      }
      return providerResponse({
        sameBusinessObject: true,
        premiseSupported: true,
        requestedFactSupported: true,
        reason: "列举对象与范围问题语义等价。",
      });
    },
  });

  const decision = await judge.judge({
    question: "哪份NVE41300第05版zh-CN资料描述了OHF检查范围？",
    candidates: [
      {
        id: "4",
        documentReference: "NVE41300",
        versionLabel: "04",
        languageCode: "zh-CN",
        sectionTitle: "旧版",
        sources: [{ pageNumber: 395, text: "检查电机负载、通风和环境温度。" }],
      },
      {
        id: "5",
        documentReference: "NVE41300",
        versionLabel: "05",
        languageCode: "zh-CN",
        sectionTitle: "当前版",
        sources: [{ pageNumber: 395, text: "检查电机负载、通风和环境温度。" }],
      },
    ],
  });

  assert.equal(judge.promptVersion, "answerability-v8-candidate-isolated");
  assert.equal(decision.verdict, "directly_answerable");
  assert.equal(decision.candidateId, "5");
  assert.ok(candidateCounts.every((count) => count === 1));
  assert.ok(systemPrompts.every((prompt) => /语义等价/.test(prompt)));
  assert.ok(systemPrompts.every((prompt) => /列举.*范围.*方面.*对象/.test(prompt)));
});
