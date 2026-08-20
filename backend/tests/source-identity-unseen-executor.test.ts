import assert from "node:assert/strict";
import test from "node:test";

import { createWorkOrderMainChain } from "../src/coordinator/work-order-main-chain.ts";
import { loadSourceIdentityUnseenDataset } from "../src/evaluation/source-identity-unseen-dataset.ts";
import { executeSourceIdentityUnseenEvaluation } from "../src/evaluation/source-identity-unseen-executor.ts";

test("R295：十二条未见题必须经正式主链和数据库来源适配器完成可控评分", async () => {
  const dataset = await loadSourceIdentityUnseenDataset();
  const expectedByQuestion = new Map(dataset.cases.map((item) => [item.question, item]));
  const fixtureByKey = new Map(dataset.candidates.map((item) => [item.candidate_key, item]));
  const observedIdentities = new Set<string>();

  const result = await executeSourceIdentityUnseenEvaluation({
    dataset,
    createMainChain(database, embedder) {
      return createWorkOrderMainChain(database, embedder, {
        coordinatorModel: {
          modelId: "controlled-coordinator-not-called",
          promptVersion: "coordinator-v3-state-bound",
          async decide() {
            throw new Error("coordinator must not run in a source identity gate evaluation");
          },
        },
        sourceAwareAnswerabilityModel: {
          modelId: "qwen3.7-plus",
          promptVersion: "answerability-v6-source-aware",
          async judge(input) {
            const expected = expectedByQuestion.get(input.question);
            assert.ok(expected, `unknown question: ${input.question}`);
            for (const candidate of input.candidates) {
              const fixture = dataset.candidates.find(
                ({ section_title, page_number, text }) =>
                  section_title === candidate.sectionTitle &&
                  page_number === candidate.sources[0]?.pageNumber &&
                  text === candidate.sources[0]?.text &&
                  expected.candidate_keys.some((key) => {
                    const item = fixtureByKey.get(key)!;
                    return (
                      item.document_reference === candidate.documentReference &&
                      item.version_label === candidate.versionLabel &&
                      item.language_code === candidate.languageCode
                    );
                  }),
              );
              assert.ok(fixture, "database source identity did not reach the formal main chain");
              observedIdentities.add(
                `${candidate.documentReference}|${candidate.versionLabel}|${candidate.languageCode}`,
              );
            }
            if (expected.expected_verdict === "not_answerable") {
              return {
                verdict: "not_answerable",
                candidateId: null,
                sourcePageNumber: null,
                supportingQuote: null,
                reason: "受控判断：来源身份不匹配。",
              };
            }
            const expectedIndex = expected.candidate_keys.indexOf(
              expected.expected_candidate_key!,
            );
            const candidate = input.candidates[expectedIndex];
            return {
              verdict: expected.expected_verdict,
              candidateId: candidate.id,
              sourcePageNumber: expected.expected_source_page_number,
              supportingQuote: candidate.sources[0].text,
              reason: "受控判断：来源身份和正文按冻结标签返回。",
            };
          },
        },
      });
    },
  });

  assert.equal(result.report.case_count, 12);
  assert.equal(result.report.exact_case_count, 12);
  assert.equal(result.report.forged_source_accept_count, 0);
  assert.equal(result.report.judge_error_count, 0);
  assert.equal(result.report.passed, true);
  assert.ok(observedIdentities.has("NVE41300|05|zh-CN"));
  assert.ok(observedIdentities.has("NVE41300|04|zh-CN"));
  assert.ok(observedIdentities.has("NVE41300|05|en-US"));
  assert.ok(observedIdentities.has("NHA80940|05|zh-CN"));
});
