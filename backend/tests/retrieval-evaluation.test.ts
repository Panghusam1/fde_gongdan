import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRankingMetrics,
  calculateRetrievalOutcomeMetrics,
} from "../src/retrieval/retrieval-evaluation.ts";
import { isKeywordRankingConfident } from "../src/retrieval/keyword-confidence.ts";

test("R134：检索评测按预先标注的目标计算首位、前三和平均倒数排名", () => {
  const metrics = calculateRankingMetrics([
    { expectedId: "definition", rankedIds: ["definition", "reset", "danger"] },
    { expectedId: "reset", rankedIds: ["definition", "danger", "reset"] },
    { expectedId: "missing", rankedIds: ["definition", "danger", "reset"] },
  ]);

  assert.deepEqual(metrics, {
    caseCount: 3,
    hitAt1: 1 / 3,
    hitAt3: 2 / 3,
    meanReciprocalRank: (1 + 1 / 3 + 0) / 3,
  });
});

test("R135：关键词只有达到最低分且明显领先第二名时才能影响混合排序", () => {
  assert.equal(isKeywordRankingConfident([11, 11, 8]), false);
  assert.equal(isKeywordRankingConfident([2]), false);
  assert.equal(isKeywordRankingConfident([14, 11, 11]), true);
  assert.equal(isKeywordRankingConfident([7]), true);
});

test("R192：正式检索指标必须把可回答命中和应拒答正确率分开计算", () => {
  const metrics = calculateRetrievalOutcomeMetrics([
    {
      expectedBehavior: "hit",
      expectedId: "definition",
      scopeClass: "in_scope",
      rankedIds: ["definition", "reset"],
      abstained: false,
    },
    {
      expectedBehavior: "hit",
      expectedId: "reset",
      scopeClass: "in_scope",
      rankedIds: ["definition", "reset"],
      abstained: false,
    },
    {
      expectedBehavior: "abstain",
      expectedId: null,
      scopeClass: "out_of_scope",
      rankedIds: [],
      abstained: true,
    },
    {
      expectedBehavior: "abstain",
      expectedId: null,
      scopeClass: "unanswerable",
      rankedIds: ["definition"],
      abstained: false,
    },
  ]);

  assert.deepEqual(metrics, {
    caseCount: 4,
    answerableCaseCount: 2,
    abstainCaseCount: 2,
    answerableHitAt1: 0.5,
    answerableHitAt3: 1,
    answerableMeanReciprocalRank: 0.75,
    abstainAccuracy: 0.5,
    scopeConflictAbstainAccuracy: 1,
    unanswerableAbstainAccuracy: 0,
    overallDecisionAccuracy: 0.5,
  });
});
