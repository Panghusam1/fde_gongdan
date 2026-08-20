import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadAdjudicatedEvaluation() {
  try {
    return await import(
      "../src/evaluation/answerability-adjudicated-evaluation.ts"
    );
  } catch {
    assert.fail("分类准确率与多证据审定计分器尚未实现");
  }
}

const reportPath = "reports/qwen-answerability-v5-regression.json";
const planPath = "reports/ohf-answerability-v5-regression-plan.json";
const auditPath =
  "data/evaluation/ohf-answerability-v3-candidate-adjudication-v1.json";

test("R256：分类准确率必须与唯一候选命中率分开计算", async () => {
  const { evaluateAdjudicatedAnswerability, loadCandidateAdjudication } =
    await loadAdjudicatedEvaluation();
  const [reportRaw, planRaw, auditRaw] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(planPath, "utf8"),
    readFile(auditPath, "utf8"),
  ]);
  const report = JSON.parse(reportRaw) as {
    evaluation: {
      overallExactAccuracy: number;
      cases: Array<{
        caseId: string;
        expectedVerdict:
          | "directly_answerable"
          | "partially_related"
          | "not_answerable";
        expectedCandidateId: string | null;
        decision: {
          verdict:
            | "directly_answerable"
            | "partially_related"
            | "not_answerable";
          candidateId: string | null;
          sourcePageNumber: number | null;
          supportingQuote: string | null;
          reason: string;
        } | null;
        error?: string;
      }>;
    };
  };
  const adjudication = loadCandidateAdjudication({
    reportRaw,
    planRaw,
    auditRaw,
  });
  const result = evaluateAdjudicatedAnswerability(
    report.evaluation.cases.map((item) => ({
      caseId: item.caseId,
      expectedVerdict: item.expectedVerdict,
      originalExpectedCandidateId: item.expectedCandidateId,
      acceptableCandidateIds:
        adjudication.acceptableCandidatesByCase.get(item.caseId) ??
        (item.expectedCandidateId === null ? null : [item.expectedCandidateId]),
      decision: item.decision,
      ...(item.error === undefined ? {} : { error: item.error }),
    })),
  );

  assert.equal(report.evaluation.overallExactAccuracy, 16 / 18);
  assert.equal(result.overallVerdictAccuracy, 17 / 18);
  assert.equal(result.overallAdjudicatedExactAccuracy, 17 / 18);
  assert.equal(result.perClassVerdictAccuracy.partially_related, 5 / 6);
  assert.equal(result.perClassAdjudicatedExactAccuracy.partially_related, 5 / 6);
  assert.equal(result.unsafeDirectAcceptCount, 0);
  assert.equal(result.judgeErrorCount, 0);
  assert.equal(
    result.cases.find(({ caseId }) => caseId === "V307")?.outcome,
    "adjudicated_correct",
  );
  assert.equal(
    result.cases.find(({ caseId }) => caseId === "V310")?.outcome,
    "wrong_verdict",
  );
});

test("R257：候选审定必须绑定完整回归前已记录的歧义和报告哈希", async () => {
  const { loadCandidateAdjudication } = await loadAdjudicatedEvaluation();
  const [reportRaw, planRaw, auditRaw] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(planPath, "utf8"),
    readFile(auditPath, "utf8"),
  ]);
  const loaded = loadCandidateAdjudication({ reportRaw, planRaw, auditRaw });
  assert.deepEqual(loaded.acceptableCandidatesByCase.get("V307"), [
    "ohf-fault-definition",
    "ohf-thermal-threshold",
  ]);
  assert.throws(
    () =>
      loadCandidateAdjudication({
        reportRaw: `${reportRaw}\n`,
        planRaw,
        auditRaw,
      }),
    /candidate adjudication does not match/,
  );
  assert.throws(
    () =>
      loadCandidateAdjudication({
        reportRaw,
        planRaw: `${planRaw}\n`,
        auditRaw,
      }),
    /candidate adjudication does not match/,
  );
});
