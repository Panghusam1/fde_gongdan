import assert from "node:assert/strict";
import test from "node:test";

import type { PGliteInterface } from "@electric-sql/pglite";

import { createWorkOrderMainChainV2 } from "../src/coordinator/work-order-main-chain-v2.ts";

const database = { query: async () => ({ rows: [] }) } as unknown as PGliteInterface;
const embedder = {
  modelId: "controlled-embedder",
  modelRevision: "1",
  dimensions: 1,
  isNormalized: true,
  async embedQuery() {
    return [1];
  },
};
const coordinatorModel = {
  modelId: "controlled-coordinator",
  promptVersion: "coordinator-v3-state-bound" as const,
  async decide(): Promise<never> {
    throw new Error("not called");
  },
};

test("R299：第二版正式主链必须固定第七版来源策略并拒绝第六版回退", () => {
  const runtime = createWorkOrderMainChainV2(database, embedder, {
    coordinatorModel,
    sourceAwareAnswerabilityModel: {
      modelId: "controlled-v7",
      promptVersion: "answerability-v7-source-policy",
      async judge(): Promise<never> {
        throw new Error("not called");
      },
    },
  });
  assert.equal(runtime.versions.answerabilityPrompt, "answerability-v7-source-policy");
  assert.equal(runtime.versions.sourceIdentityBinding, "database-source-chain-v1");

  assert.throws(
    () =>
      createWorkOrderMainChainV2(database, embedder, {
        coordinatorModel,
        sourceAwareAnswerabilityModel: {
          modelId: "controlled-v6",
          promptVersion: "answerability-v6-source-aware",
          async judge(): Promise<never> {
            throw new Error("not called");
          },
        },
      }),
    /requires answerability v7/,
  );
});
