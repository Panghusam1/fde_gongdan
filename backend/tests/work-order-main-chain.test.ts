import assert from "node:assert/strict";
import test from "node:test";

import type { PGliteInterface } from "@electric-sql/pglite";

async function loadMainChain() {
  try {
    return await import("../src/coordinator/work-order-main-chain.ts");
  } catch {
    assert.fail("正式工单主链组装入口尚未实现");
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

test("R288：正式工单主链必须固定组装数据库来源适配器和第六版判断器", async () => {
  const { createWorkOrderMainChainFromEnvironment } = await loadMainChain();
  const receivedCandidates: Array<Record<string, unknown>> = [];
  const outputs = [
    {
      sameBusinessObject: true,
      premiseSupported: true,
      requestedFactSupported: true,
      reason: "来源身份和正文均支持问题。",
    },
    {
      candidateId: "41",
      sourcePageNumber: 395,
      supportingQuote: "解决措施 检查电机负载、变频器通风情况和环境温度。",
      reason: "指定资料中的连续原文直接回答问题。",
    },
  ];
  let answerabilityCall = 0;
  const database = {
    async query() {
      return {
        rows: [
          {
            candidate_id: "41",
            document_reference: "NVE41300",
            version_label: "05",
            language_code: "zh-CN",
          },
        ],
      };
    },
  } as unknown as PGliteInterface;
  const embedder = {
    modelId: "controlled-embedder",
    modelRevision: "1",
    dimensions: 3,
    isNormalized: true,
    async embedQuery() {
      return [1, 0, 0];
    },
  };
  const runtime = createWorkOrderMainChainFromEnvironment(
    database,
    embedder,
    {
      DASHSCOPE_API_KEY: "test-only-key",
      QWEN_ANSWERABILITY_MODEL: "qwen3.7-plus",
      QWEN_COORDINATOR_MODEL: "qwen3.7-plus",
    },
    {
      answerabilityFetchImplementation: async (_request, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const userContent = JSON.parse(
          body.messages.find(({ role }) => role === "user")!.content,
        ) as { candidates: Array<Record<string, unknown>> };
        receivedCandidates.push(userContent.candidates[0]);
        return providerResponse(outputs[answerabilityCall++]);
      },
      coordinatorFetchImplementation: async () => {
        throw new Error("coordinator must not be called in this contract test");
      },
    },
  );

  assert.equal(runtime.versions.coordinatorPrompt, "coordinator-v3-state-bound");
  assert.equal(runtime.versions.answerabilityPrompt, "answerability-v6-source-aware");
  assert.equal(runtime.versions.sourceIdentityBinding, "database-source-chain-v1");

  const decision = await runtime.answerabilityJudge.judge({
    question: "NVE41300第05版中文资料列出了哪三项检查？",
    candidates: [
      {
        id: "41",
        sectionTitle: "变频器过热的核查项",
        sources: [
          {
            pageNumber: 395,
            text: "解决措施 检查电机负载、变频器通风情况和环境温度。",
          },
        ],
      },
    ],
  });

  assert.equal(decision.verdict, "directly_answerable");
  assert.equal(answerabilityCall, 2);
  assert.equal(receivedCandidates.length, 2);
  for (const candidate of receivedCandidates) {
    assert.equal(candidate.documentReference, "NVE41300");
    assert.equal(candidate.versionLabel, "05");
    assert.equal(candidate.languageCode, "zh-CN");
  }
});

test("R289：正式主链必须在组装时拒绝第五版判断器回退", async () => {
  const module = await loadMainChain();
  assert.equal(
    typeof module.createWorkOrderMainChain,
    "function",
    "正式主链缺少可供整链测试复用的受控组装入口",
  );
  const database = { query: async () => ({ rows: [] }) } as unknown as PGliteInterface;
  const embedder = {
    modelId: "controlled-embedder",
    modelRevision: "1",
    dimensions: 3,
    isNormalized: true,
    async embedQuery() {
      return [1, 0, 0];
    },
  };
  assert.throws(
    () =>
      module.createWorkOrderMainChain(database, embedder, {
        coordinatorModel: {
          modelId: "controlled-coordinator",
          promptVersion: "coordinator-v3-state-bound",
          async decide() {
            throw new Error("not called");
          },
        },
        sourceAwareAnswerabilityModel: {
          modelId: "controlled-answerability",
          promptVersion: "answerability-v5-two-stage",
          async judge() {
            throw new Error("not called");
          },
        },
      }),
    /formal work-order main chain requires answerability v6/,
  );
});
