import assert from "node:assert/strict";
import test from "node:test";

import { createWorkOrderMainChainV3 } from "../src/coordinator/work-order-main-chain-v3.ts";
import { loadSourceIdentityUnseenV3Dataset } from "../src/evaluation/source-identity-unseen-v3-dataset.ts";
import { executeSourceIdentityUnseenEvaluationV3 } from "../src/evaluation/source-identity-unseen-executor-v3.ts";

test("R308：第三版执行器必须经第八版正式主链完成十二条可控评分", async () => {
  const dataset = await loadSourceIdentityUnseenV3Dataset();
  const expectedByQuestion = new Map(dataset.cases.map((item) => [item.question, item]));
  const result = await executeSourceIdentityUnseenEvaluationV3({
    dataset,
    createMainChain(database, embedder) {
      return createWorkOrderMainChainV3(database, embedder, {
        coordinatorModel: {
          modelId: "controlled-coordinator-not-called",
          promptVersion: "coordinator-v3-state-bound",
          async decide(): Promise<never> {
            throw new Error("not called");
          },
        },
        sourceAwareAnswerabilityModel: {
          modelId: "qwen3.7-plus",
          promptVersion: "answerability-v8-candidate-isolated",
          async judge(input) {
            const expected = expectedByQuestion.get(input.question)!;
            if (expected.expected_verdict === "not_answerable") {
              return {
                verdict: "not_answerable",
                candidateId: null,
                sourcePageNumber: null,
                supportingQuote: null,
                reason: "受控拒绝。",
              };
            }
            const index = expected.candidate_keys.indexOf(
              expected.expected_candidate_key!,
            );
            const candidate = input.candidates[index];
            return {
              verdict: expected.expected_verdict,
              candidateId: candidate.id,
              sourcePageNumber: expected.expected_source_page_number,
              supportingQuote: candidate.sources[0].text,
              reason: "受控通过。",
            };
          },
        },
      });
    },
  });
  assert.equal(result.report.main_chain.answerabilityPrompt, "answerability-v8-candidate-isolated");
  assert.equal(result.report.exact_case_count, 12);
  assert.equal(result.report.forged_source_accept_count, 0);
  assert.equal(result.report.passed, true);
});
