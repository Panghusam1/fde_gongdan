import assert from "node:assert/strict";
import test from "node:test";

import { createWorkOrderMainChainV4 } from "../src/coordinator/work-order-main-chain-v4.ts";
import { loadSourceIdentityUnseenV4Dataset } from "../src/evaluation/source-identity-unseen-v4-dataset.ts";
import { executeSourceIdentityUnseenEvaluationV4 } from "../src/evaluation/source-identity-unseen-executor-v4.ts";

test("R318：第四版执行器必须在程序拒绝案例中保持零模型调用", async () => {
  const dataset = await loadSourceIdentityUnseenV4Dataset();
  const expectedByConfirmedQuestion = new Map(
    dataset.cases.map((item) => [item.confirmed_content_question, item]),
  );
  const rawQuestions = new Set(dataset.cases.map((item) => item.raw_question));
  let modelCalls = 0;
  const result = await executeSourceIdentityUnseenEvaluationV4({
    dataset,
    createMainChain(database, embedder) {
      return createWorkOrderMainChainV4(database, embedder, {
        coordinatorModel: {
          modelId: "controlled-coordinator-not-called",
          promptVersion: "coordinator-v3-state-bound",
          async decide(): Promise<never> {
            throw new Error("not called");
          },
        },
        sourceAwareAnswerabilityModel: {
          modelId: "controlled-v8",
          promptVersion: "answerability-v8-candidate-isolated",
          async judge(input) {
            modelCalls += 1;
            assert.equal(rawQuestions.has(input.question), false);
            const expected = expectedByConfirmedQuestion.get(input.question);
            assert.ok(expected, `unexpected confirmed question: ${input.question}`);
            assert.equal(expected.expected_model_invoked, true);
            for (const candidate of input.candidates) {
              assert.equal(
                candidate.documentReference.toLowerCase(),
                expected.requested_source_identity.document_reference.toLowerCase(),
              );
              assert.equal(
                candidate.versionLabel.toLowerCase(),
                expected.requested_source_identity.version_label.toLowerCase(),
              );
              assert.equal(
                candidate.languageCode.toLowerCase(),
                expected.requested_source_identity.language_code.toLowerCase(),
              );
            }
            const selected = input.candidates.find(({ sources }) =>
              sources.some(
                ({ pageNumber }) =>
                  pageNumber === expected.expected_source_page_number,
              ),
            );
            assert.ok(selected);
            return {
              verdict: expected.expected_verdict,
              candidateId: selected.id,
              sourcePageNumber: expected.expected_source_page_number,
              supportingQuote: selected.sources[0].text,
              reason: "受控内容判断。",
            };
          },
        },
      });
    },
  });

  assert.equal(modelCalls, 7);
  assert.equal(result.report.exact_case_count, 12);
  assert.equal(result.report.program_reject_observed_count, 5);
  assert.equal(result.report.unmatched_source_accept_count, 0);
  assert.equal(result.report.passed, true);
});
