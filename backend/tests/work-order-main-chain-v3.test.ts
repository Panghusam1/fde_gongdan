import assert from "node:assert/strict";
import test from "node:test";

import type { PGliteInterface } from "@electric-sql/pglite";

import { createWorkOrderMainChainV3 } from "../src/coordinator/work-order-main-chain-v3.ts";

test("R306：第三版正式主链必须锁定第八版逐候选判断器", () => {
  const database = { query: async () => ({ rows: [] }) } as unknown as PGliteInterface;
  const embedder = {
    modelId: "controlled",
    modelRevision: "1",
    dimensions: 1,
    isNormalized: true,
    async embedQuery() {
      return [1];
    },
  };
  const coordinatorModel = {
    modelId: "controlled",
    promptVersion: "coordinator-v3-state-bound" as const,
    async decide(): Promise<never> {
      throw new Error("not called");
    },
  };
  const runtime = createWorkOrderMainChainV3(database, embedder, {
    coordinatorModel,
    sourceAwareAnswerabilityModel: {
      modelId: "controlled-v8",
      promptVersion: "answerability-v8-candidate-isolated",
      async judge(): Promise<never> {
        throw new Error("not called");
      },
    },
  });
  assert.equal(runtime.versions.answerabilityPrompt, "answerability-v8-candidate-isolated");
  assert.throws(
    () =>
      createWorkOrderMainChainV3(database, embedder, {
        coordinatorModel,
        sourceAwareAnswerabilityModel: {
          modelId: "controlled-v7",
          promptVersion: "answerability-v7-source-policy",
          async judge(): Promise<never> {
            throw new Error("not called");
          },
        },
      }),
    /requires answerability v8/,
  );
});
