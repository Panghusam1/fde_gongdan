import assert from "node:assert/strict";
import test from "node:test";

async function createLiveModel() {
  const { createQwenCoordinatorModelFromEnvironment } = await import(
    "../src/coordinator/qwen-coordinator-runtime.ts"
  );
  return createQwenCoordinatorModelFromEnvironment(process.env);
}

test(
  "R182：真实千问能够选择官方知识检索并返回合法查询词",
  { skip: process.env.RUN_QWEN_INTEGRATION !== "1", timeout: 120_000 },
  async () => {
    const model = await createLiveModel();
    const decision = await model.decide({
      userMessage: "ATV320显示OHF，请先根据当前官方资料继续排查。",
      workOrderContext: {
        workOrder: {
          status: "investigating",
          manufacturerName: "Schneider Electric",
          productFamilyCode: "ATV320",
          modelCode: "ATV320U07N4C",
          faultCode: "OHF",
        },
        latestSearch: null,
        latestRiskAssessment: null,
        latestProposal: null,
      },
      allowedActions: ["search_official_knowledge"],
    });

    assert.equal(decision.action, "search_official_knowledge");
    assert.ok(decision.queryText.trim().length > 0);
  },
);

test(
  "R183：真实千问能够只根据当前证据草拟字段完整的低风险方案",
  { skip: process.env.RUN_QWEN_INTEGRATION !== "1", timeout: 120_000 },
  async () => {
    const model = await createLiveModel();
    const decision = await model.decide({
      userMessage: "请给出一份可以让我直接确认的完整低风险方案。",
      workOrderContext: {
        workOrder: {
          status: "investigating",
          manufacturerName: "Schneider Electric",
          productFamilyCode: "ATV320",
          modelCode: "ATV320U07N4C",
          faultCode: "OHF",
        },
        observations: [
          { eventId: 601, eventType: "observation_added", content: "外壳温度较高，冷却风扇不转，尚未拆检。" },
        ],
        latestSearch: {
          searchRunId: 501,
          hits: [
            {
              searchHitId: 801,
              knowledgeChunkId: 901,
              verifiedText: "低风险检查：保持设备完整，仅从外部观察通风口是否被遮挡。",
              contentKind: "procedure",
              sourceSeverity: "information",
              usagePolicy: "low_risk_guidance",
              documentReference: "NVE41300",
              pdfPageNumber: 72,
            },
          ],
        },
        latestRiskAssessment: {
          riskAssessmentId: 701,
          searchRunId: 501,
          decision: "proposal_allowed",
          overallRiskLevel: "low",
        },
        latestProposal: null,
      },
      allowedActions: ["draft_resolution_proposal"],
    });

    assert.equal(decision.action, "draft_resolution_proposal");
    assert.equal(decision.riskAssessmentId, 701);
    assert.deepEqual(decision.evidenceSearchHitIds, [801]);
    assert.ok(decision.steps.length > 0);
    assert.ok(decision.stopConditions.length > 0);
    assert.ok(decision.expectedObservations.length > 0);
  },
);
