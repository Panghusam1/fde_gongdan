import assert from "node:assert/strict";
import test from "node:test";

import { loadAnswerabilityHoldoutDataset } from "../src/evaluation/answerability-holdout-dataset.ts";
import { evaluateAnswerabilityThreshold } from "../src/evaluation/answerability-evaluation.ts";

const datasetPath = "data/evaluation/ohf-answerability-holdout-v1.json";
const developmentDatasetPath = "data/evaluation/ohf-retrieval-cases-v2.json";
const candidateManifestPath =
  "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";

test("R201：无答案留出集必须在首次模型运行前冻结且与40题开发集无重复", async () => {
  const dataset = await loadAnswerabilityHoldoutDataset({
    datasetPath,
    developmentDatasetPath,
    candidateManifestPath,
  });

  assert.equal(dataset.cases.length, 24);
  assert.equal(
    dataset.cases.filter((item) => item.expected_behavior === "hit").length,
    12,
  );
  assert.equal(
    dataset.cases.filter((item) => item.expected_behavior === "abstain").length,
    12,
  );
  assert.equal(dataset.frozen_before_first_model_run, true);
  assert.equal(dataset.threshold_policy.vector_similarity_minimum, 0.86);
  assert.deepEqual(
    [...new Set(
      dataset.cases
        .filter((item) => item.expected_behavior === "hit")
        .map((item) => item.expected_candidate_key),
    )].sort(),
    [
      "ohf-error-detection-disable-danger",
      "ohf-fault-definition",
      "ohf-manual-reset-condition",
      "ohf-thermal-threshold",
      "product-restart-warning",
      "unresettable-fault-power-isolation-procedure",
    ],
  );
});

test("R202：无答案阈值评测必须分别计算正确接收、错误接收和正确拒答", () => {
  const evaluation = evaluateAnswerabilityThreshold({
    threshold: 0.86,
    cases: [
      {
        caseId: "positive-correct",
        expectedBehavior: "hit",
        expectedCandidateId: "definition",
        ranking: [
          { id: "definition", score: 0.9 },
          { id: "reset", score: 0.8 },
        ],
      },
      {
        caseId: "positive-below-threshold",
        expectedBehavior: "hit",
        expectedCandidateId: "reset",
        ranking: [{ id: "reset", score: 0.85 }],
      },
      {
        caseId: "negative-rejected",
        expectedBehavior: "abstain",
        expectedCandidateId: null,
        ranking: [{ id: "definition", score: 0.82 }],
      },
      {
        caseId: "negative-false-accept",
        expectedBehavior: "abstain",
        expectedCandidateId: null,
        ranking: [{ id: "definition", score: 0.88 }],
      },
    ],
  });

  assert.equal(evaluation.answerableCorrectAcceptRate, 0.5);
  assert.equal(evaluation.unanswerableAbstainAccuracy, 0.5);
  assert.equal(evaluation.acceptedPrecision, 0.5);
  assert.equal(evaluation.overallDecisionAccuracy, 0.5);
  assert.deepEqual(
    evaluation.cases.map((item) => item.outcome),
    [
      "correct_accept",
      "false_abstain",
      "correct_abstain",
      "false_accept",
    ],
  );
});
