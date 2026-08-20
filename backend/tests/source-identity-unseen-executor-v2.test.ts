import assert from "node:assert/strict";
import test from "node:test";

import { createWorkOrderMainChainV2 } from "../src/coordinator/work-order-main-chain-v2.ts";
import { loadSourceIdentityUnseenV2Dataset } from "../src/evaluation/source-identity-unseen-v2-dataset.ts";
import { executeSourceIdentityUnseenEvaluationV2 } from "../src/evaluation/source-identity-unseen-executor-v2.ts";

test("R301：第二版执行器必须只接受第七版正式主链并完成十二条可控评分", async () => {
  const dataset = await loadSourceIdentityUnseenV2Dataset();
  const expectedByQuestion = new Map(dataset.cases.map((item) => [item.question, item]));
  let sawDatabaseIdentity = false;
  const result = await executeSourceIdentityUnseenEvaluationV2({
    dataset,
    createMainChain(database, embedder) {
      return createWorkOrderMainChainV2(database, embedder, {
        coordinatorModel: {
          modelId: "controlled-coordinator-not-called",
          promptVersion: "coordinator-v3-state-bound",
          async decide(): Promise<never> {
            throw new Error("not called");
          },
        },
        sourceAwareAnswerabilityModel: {
          modelId: "qwen3.7-plus",
          promptVersion: "answerability-v7-source-policy",
          async judge(input) {
            const expected = expectedByQuestion.get(input.question)!;
            sawDatabaseIdentity ||= input.candidates.every(
              ({ documentReference, versionLabel, languageCode }) =>
                Boolean(documentReference && versionLabel && languageCode),
            );
            if (expected.expected_verdict === "not_answerable") {
              return {
                verdict: "not_answerable",
                candidateId: null,
                sourcePageNumber: null,
                supportingQuote: null,
                reason: "受控拒绝来源覆盖。",
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
              reason: "受控返回冻结标签。",
            };
          },
        },
      });
    },
  });

  assert.equal(result.report.main_chain.answerabilityPrompt, "answerability-v7-source-policy");
  assert.equal(result.report.exact_case_count, 12);
  assert.equal(result.report.forged_source_accept_count, 0);
  assert.equal(result.report.passed, true);
  assert.equal(sawDatabaseIdentity, true);
});
