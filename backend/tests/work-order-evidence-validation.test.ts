import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { assessEvidenceAndRunRisk } from "../src/agent-tools/assess-evidence-and-run-risk.ts";
import { searchOfficialKnowledge } from "../src/agent-tools/search-official-knowledge.ts";
import { coordinateWorkOrderTurn } from "../src/coordinator/run-work-order-coordinator.ts";
import { coordinateWorkOrderTurnV2 } from "../src/coordinator/run-work-order-coordinator-v2.ts";
import type { QwenAnswerabilityJudge } from "../src/evaluation/qwen-answerability-judge.ts";
import { createQwenAnswerabilityJudgeFromEnvironment } from "../src/evaluation/qwen-answerability-judge.ts";
import { createQwenAnswerabilityJudgeV2FromEnvironment } from "../src/evaluation/qwen-answerability-judge-v2.ts";
import {
  loadWorkOrderEvidenceChainHoldout,
  scoreWorkOrderEvidenceChainHoldout,
  validateWorkOrderEvidenceChainFreeze,
  validateWorkOrderEvidenceV2RegressionPlan,
  type WorkOrderEvidenceChainActualCase,
  type WorkOrderEvidenceChainHoldout,
  type WorkOrderEvidenceControlledCandidate,
} from "../src/evaluation/work-order-evidence-chain-holdout.ts";
import { createKnowledgeChunkCandidate } from "../src/knowledge/create-knowledge-chunk-candidate.ts";
import { reviewKnowledgeChunk } from "../src/knowledge/review-knowledge-chunk.ts";
import { indexApprovedKnowledgeChunk } from "../src/retrieval/index-approved-knowledge-chunk.ts";
import { createDraftWorkOrder } from "../src/work-orders/create-draft-work-order.ts";
import { transitionWorkOrder } from "../src/work-orders/transition-work-order.ts";

async function openMigratedDatabase(): Promise<PGlite> {
  const database = await PGlite.create({
    dataDir: "memory://",
    extensions: { vector },
  });
  const directory = new URL("../database/migrations/", import.meta.url);
  const migrations = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    await database.exec(await readFile(new URL(migration, directory), "utf8"));
  }
  await database.exec(
    await readFile(
      new URL("../database/seeds/001_atv320_nve41300.sql", import.meta.url),
      "utf8",
    ),
  );
  return database;
}

function createTestEmbedder() {
  return {
    modelId: "test/multilingual-e5-small",
    modelRevision: "evidence-gate-v1",
    dimensions: 3,
    poolingMethod: "mean" as const,
    isNormalized: true as const,
    embedPassage: async (text: string): Promise<number[]> =>
      text.includes("高危") ? [0, 1, 0] : [1, 0, 0],
    embedQuery: async (): Promise<number[]> => [1, 0, 0],
  };
}

async function createApprovedChunk(
  database: PGlite,
  input: {
    sourceVersionId: number;
    reviewerUserId: number;
    pageNumber: number;
    text: string;
    sectionTitle: string;
    contentKind: "procedure" | "safety_warning";
    sourceSeverity: "information" | "danger";
    usagePolicy: "low_risk_guidance" | "engineer_only";
    embedder: ReturnType<typeof createTestEmbedder>;
  },
): Promise<number> {
  const page = await database.query<{ id: number }>(
    `insert into document_pages (source_version_id, pdf_page_number) values ($1, $2) returning id`,
    [input.sourceVersionId, input.pageNumber],
  );
  const extraction = await database.query<{ id: number }>(
    `
      insert into page_extractions (
        document_page_id, extraction_method, extractor_name,
        extractor_version, extraction_status, extracted_text, text_sha256
      )
      values ($1, 'embedded_text', 'evidence-test', '1.0.0', 'extracted', $2, $3)
      returning id
    `,
    [
      page.rows[0].id,
      input.text,
      createHash("sha256").update(input.text).digest("hex"),
    ],
  );
  const candidate = await createKnowledgeChunkCandidate(database, {
    sourceVersionId: input.sourceVersionId,
    contentKind: input.contentKind,
    sourceSeverity: input.sourceSeverity,
    usagePolicy: input.usagePolicy,
    faultCode: "OHF",
    sectionTitle: input.sectionTitle,
    chunkingMethod: "manual_selection",
    chunkerName: "evidence-test",
    chunkerVersion: "1.0.0",
    sources: [{ pageExtractionId: extraction.rows[0].id, excerpt: input.text }],
  });
  await reviewKnowledgeChunk(database, {
    knowledgeChunkId: candidate.knowledgeChunkId,
    authenticatedReviewerUserId: input.reviewerUserId,
    decision: "approve",
  });
  await indexApprovedKnowledgeChunk(database, {
    knowledgeChunkId: candidate.knowledgeChunkId,
    embedder: input.embedder,
  });
  return candidate.knowledgeChunkId;
}

async function createFixture(
  database: PGlite,
  options: {
    queryText?: string;
    candidates?: WorkOrderEvidenceControlledCandidate[];
  } = {},
) {
  const embedder = createTestEmbedder();
  const source = await database.query<{
    product_family_id: number;
    source_version_id: number;
  }>(`
    select source_document.product_family_id,
           source_version.id as source_version_id
    from source_versions as source_version
    join source_documents as source_document
      on source_document.id = source_version.source_document_id
    where lower(btrim(source_document.document_reference)) = 'nve41300'
      and lower(btrim(source_version.version_label)) = '05'
      and lower(btrim(source_version.language_code)) = 'zh-cn'
  `);
  await database.query(
    `update source_versions set version_status = 'current' where id = $1`,
    [source.rows[0].source_version_id],
  );
  const factory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ('F-EVIDENCE', '证据门测试厂') returning id`,
  );
  const user = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|evidence-user', '证据门测试用户') returning id`,
  );
  const membership = await database.query<{ id: number }>(
    `insert into factory_memberships (factory_id, user_id, role_code) values ($1, $2, 'operator') returning id`,
    [factory.rows[0].id, user.rows[0].id],
  );
  await database.query(
    `insert into product_family_knowledge_reviewers (product_family_id, user_id) values ($1, $2)`,
    [source.rows[0].product_family_id, user.rows[0].id],
  );
  const equipmentModel = await database.query<{ id: number }>(
    `insert into equipment_models (product_family_id, model_code, display_name) values ($1, 'ATV320-EVIDENCE', 'ATV320证据门测试型号') returning id`,
    [source.rows[0].product_family_id],
  );
  const equipment = await database.query<{ id: number }>(
    `insert into equipment (factory_id, asset_code, equipment_model_id) values ($1, 'INV-EVIDENCE-001', $2) returning id`,
    [factory.rows[0].id, equipmentModel.rows[0].id],
  );
  const workOrder = await createDraftWorkOrder(database, {
    workOrderNo: "WO-EVIDENCE-001",
    factoryId: factory.rows[0].id,
    equipmentId: equipment.rows[0].id,
    creatorMembershipId: membership.rows[0].id,
    reportedFaultCode: "OHF",
    initialObservation: "设备报告OHF，冷却风扇不转。",
    idempotencyKey: "create-evidence-work-order",
  });
  await transitionWorkOrder(database, {
    workOrderId: workOrder.workOrderId,
    toStatus: "investigating",
    actorKind: "user",
    actorMembershipId: membership.rows[0].id,
    content: "开始排查。",
    idempotencyKey: "start-evidence-investigation",
  });
  const candidates = options.candidates ?? [
    {
      candidate_key: "external_vent_check",
      page_number: 911,
      section_title: "外部通风检查",
      text: "低风险检查：保持设备完整，仅从外部观察通风口是否被遮挡。",
      content_kind: "procedure" as const,
      source_severity: "information" as const,
      usage_policy: "low_risk_guidance" as const,
    },
    {
      candidate_key: "energized_work_warning",
      page_number: 912,
      section_title: "带电作业警告",
      text: "高危警告：带电测量或拆开设备必须由具备资质的工程师执行。",
      content_kind: "safety_warning" as const,
      source_severity: "danger" as const,
      usage_policy: "engineer_only" as const,
    },
  ];
  let lowRiskChunkId: number | null = null;
  let lowRiskText: string | null = null;
  for (const candidate of candidates) {
    const chunkId = await createApprovedChunk(database, {
      sourceVersionId: source.rows[0].source_version_id,
      reviewerUserId: user.rows[0].id,
      pageNumber: candidate.page_number,
      text: candidate.text,
      sectionTitle: candidate.section_title,
      contentKind: candidate.content_kind,
      sourceSeverity: candidate.source_severity,
      usagePolicy: candidate.usage_policy,
      embedder,
    });
    if (candidate.usage_policy === "low_risk_guidance") {
      lowRiskChunkId = chunkId;
      lowRiskText = candidate.text;
    }
  }
  if (lowRiskChunkId === null || lowRiskText === null) {
    throw new Error("evidence fixture needs one low-risk candidate");
  }
  const search = await searchOfficialKnowledge(database, {
    workOrderId: workOrder.workOrderId,
    requesterMembershipId: membership.rows[0].id,
    queryText: options.queryText ?? "不拆机时怎样检查通风口？",
    idempotencyKey: "evidence-search",
    limit: 5,
    embedder,
  });
  return {
    embedder,
    workOrderId: workOrder.workOrderId,
    membershipId: membership.rows[0].id,
    lowRiskChunkId,
    lowRiskText,
    search,
  };
}

async function runFrozenEvidenceCases(
  dataset: WorkOrderEvidenceChainHoldout,
  realJudge: {
    modelId: string;
    promptVersion: string;
    judge: QwenAnswerabilityJudge["judge"];
  },
): Promise<WorkOrderEvidenceChainActualCase[]> {
  const actualCases: WorkOrderEvidenceChainActualCase[] = [];
  for (const item of dataset.cases) {
    const database = await openMigratedDatabase();
    const startedAt = performance.now();
    let judgeCalls = 0;
    let actualEvidenceVerdict:
      | "directly_answerable"
      | "partially_related"
      | "not_answerable"
      | "judge_error"
      | null = "judge_error";
    let actualRiskDecision:
      | "proposal_allowed"
      | "human_handoff_required" = "human_handoff_required";
    let judgeError: string | null = null;
    let workOrderId: number | null = null;
    try {
      const fixture = await createFixture(database, {
        queryText: item.query,
        candidates: dataset.controlled_candidates,
      });
      workOrderId = fixture.workOrderId;
      const judge = {
        modelId: realJudge.modelId,
        promptVersion: realJudge.promptVersion,
        async judge(input: Parameters<QwenAnswerabilityJudge["judge"]>[0]) {
          judgeCalls += 1;
          return realJudge.judge(input);
        },
      } as unknown as QwenAnswerabilityJudge;
      const result = await assessEvidenceAndRunRisk(database, {
        workOrderId: fixture.workOrderId,
        requesterMembershipId: fixture.membershipId,
        searchRunId: fixture.search.searchRunId,
        evidenceIdempotencyKey: `holdout-evidence-${item.case_id}`,
        riskIdempotencyKey: `holdout-risk-${item.case_id}`,
        judge,
      });
      actualEvidenceVerdict = result.evidenceAssessment?.verdict ?? null;
      actualRiskDecision = result.riskAssessment.decision;
      if (result.evidenceAssessment?.verdict === "judge_error") {
        judgeError = result.evidenceAssessment.reason;
      }
    } catch (error) {
      judgeError = error instanceof Error ? error.message : String(error);
    }

    const finalState = await database.query<{
      work_order_status: "investigating" | "awaiting_human";
      evidence_assessments: number;
      risk_assessments: number;
      human_handoffs: number;
      resolution_proposals: number;
    }>(`
      select
        work_order.status as work_order_status,
        (select count(*)::integer from evidence_assessments) as evidence_assessments,
        (select count(*)::integer from risk_assessments) as risk_assessments,
        (select count(*)::integer from human_handoffs) as human_handoffs,
        (select count(*)::integer from resolution_proposals) as resolution_proposals
      from work_orders as work_order
      where work_order.id = $1
    `, [workOrderId]);
    actualCases.push({
      case_id: item.case_id,
      actual_evidence_verdict: actualEvidenceVerdict,
      actual_risk_decision: actualRiskDecision,
      actual_judge_calls: judgeCalls,
      actual_final_state: finalState.rows[0] ?? {
        work_order_status: "investigating",
        evidence_assessments: 0,
        risk_assessments: 0,
        human_handoffs: 0,
        resolution_proposals: 0,
      },
      judge_error: judgeError,
      duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    await database.close();
  }
  return actualCases;
}

async function writeReportOnce(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

async function readBundle(paths: readonly string[]): Promise<string> {
  const values = await Promise.all(
    paths.map(async (path) => `${path}\n${await readFile(path, "utf8")}`),
  );
  return values.join("\n\0\n");
}

test("R222：前五候选只允许判断器选中的直接证据进入风险门", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  assert.equal(fixture.search.hits.length, 2);

  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v1",
    async judge(input) {
      assert.equal(input.candidates.length, 2);
      const selected = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(fixture.lowRiskText)),
      );
      assert.ok(selected);
      return {
        verdict: "directly_answerable",
        candidateId: selected.id,
        sourcePageNumber: 911,
        supportingQuote: fixture.lowRiskText,
        reason: "原文直接给出了不拆机的外部通风检查方法。",
      };
    },
  };

  const result = await assessEvidenceAndRunRisk(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: fixture.search.searchRunId,
    evidenceIdempotencyKey: "assess-evidence-direct",
    riskIdempotencyKey: "assess-risk-direct",
    judge,
  });

  assert.equal(result.evidenceAssessment.verdict, "directly_answerable");
  assert.equal(result.riskAssessment.decision, "proposal_allowed");
  assert.deepEqual(
    result.riskAssessment.matchedRules.map(({ ruleCode }) => ruleCode),
    ["LOW_RISK_GUIDANCE_AVAILABLE"],
  );
  const selected = await database.query<{
    knowledge_chunk_id: number;
    evidence_assessment_id: number | null;
  }>(`
    select search_hit.knowledge_chunk_id, risk.evidence_assessment_id
    from risk_assessments as risk
    join evidence_assessments as evidence on evidence.id = risk.evidence_assessment_id
    join knowledge_search_hits as search_hit
      on search_hit.id = evidence.selected_search_hit_id
     and search_hit.search_run_id = evidence.search_run_id
  `);
  assert.deepEqual(selected.rows, [
    {
      knowledge_chunk_id: fixture.lowRiskChunkId,
      evidence_assessment_id: result.evidenceAssessment.evidenceAssessmentId,
    },
  ]);
});

test("R223：只有部分相关的资料必须转人工且不能生成方案", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v1",
    async judge(input) {
      const actual = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(fixture.lowRiskText)),
      );
      assert.ok(actual);
      return {
        verdict: "partially_related",
        candidateId: actual.id,
        sourcePageNumber: 911,
        supportingQuote: fixture.lowRiskText,
        reason: "资料只说明外部观察方法，没有回答用户问题要求的完整处置。",
      };
    },
  };

  const result = await assessEvidenceAndRunRisk(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: fixture.search.searchRunId,
    evidenceIdempotencyKey: "assess-evidence-partial",
    riskIdempotencyKey: "assess-risk-partial",
    judge,
  });

  assert.equal(result.evidenceAssessment.verdict, "partially_related");
  assert.equal(result.riskAssessment.decision, "human_handoff_required");
  assert.equal(result.riskAssessment.evidenceSufficient, false);
  const finalState = await database.query<{
    status: string;
    handoffs: number;
    proposals: number;
  }>(`
    select
      work_order.status,
      (select count(*)::integer from human_handoffs) as handoffs,
      (select count(*)::integer from resolution_proposals) as proposals
    from work_orders as work_order
    where work_order.id = ${fixture.workOrderId}
  `);
  assert.deepEqual(finalState.rows, [
    { status: "awaiting_human", handoffs: 1, proposals: 0 },
  ]);
});

test("R224：判断模型失败必须留痕为错误并安全转人工", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v1",
    async judge() {
      throw new Error("provider timeout");
    },
  };

  const result = await assessEvidenceAndRunRisk(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: fixture.search.searchRunId,
    evidenceIdempotencyKey: "assess-evidence-error",
    riskIdempotencyKey: "assess-risk-error",
    judge,
  });

  assert.equal(result.evidenceAssessment.verdict, "judge_error");
  assert.equal(result.evidenceAssessment.decisionSource, "model_error");
  assert.match(result.evidenceAssessment.reason, /provider timeout/);
  assert.equal(result.riskAssessment.decision, "human_handoff_required");
  const finalState = await database.query<{
    evidence_events: number;
    risk_events: number;
    handoffs: number;
    proposals: number;
  }>(`
    select
      (select count(*)::integer from work_order_events where event_type = 'evidence_assessed') as evidence_events,
      (select count(*)::integer from work_order_events where event_type = 'risk_assessed') as risk_events,
      (select count(*)::integer from human_handoffs) as handoffs,
      (select count(*)::integer from resolution_proposals) as proposals
  `);
  assert.deepEqual(finalState.rows, [
    { evidence_events: 1, risk_events: 1, handoffs: 1, proposals: 0 },
  ]);
});

test(
  "R225：模型计算期间权限失效必须在落库前重新校验并全部拒绝",
  { timeout: 10_000 },
  async (context) => {
    const database = await openMigratedDatabase();
    context.after(async () => database.close());
    const fixture = await createFixture(database);
    const judge: QwenAnswerabilityJudge = {
      modelId: "qwen-evidence-test",
      promptVersion: "answerability-v1",
      async judge(input) {
        await database.query(
          `update factory_memberships set is_active = false where id = $1`,
          [fixture.membershipId],
        );
        const selected = input.candidates.find(({ sources }) =>
          sources.some(({ text }) => text.includes(fixture.lowRiskText)),
        );
        assert.ok(selected);
        return {
          verdict: "directly_answerable",
          candidateId: selected.id,
          sourcePageNumber: 911,
          supportingQuote: fixture.lowRiskText,
          reason: "原文足以回答。",
        };
      },
    };

    await assert.rejects(
      assessEvidenceAndRunRisk(database, {
        workOrderId: fixture.workOrderId,
        requesterMembershipId: fixture.membershipId,
        searchRunId: fixture.search.searchRunId,
        evidenceIdempotencyKey: "assess-evidence-revoked",
        riskIdempotencyKey: "assess-risk-revoked",
        judge,
      }),
      /authorization or evidence scope changed/,
    );
    const records = await database.query<{
      evidence_assessments: number;
      risk_assessments: number;
      handoffs: number;
    }>(`
      select
        (select count(*)::integer from evidence_assessments) as evidence_assessments,
        (select count(*)::integer from risk_assessments) as risk_assessments,
        (select count(*)::integer from human_handoffs) as handoffs
    `);
    assert.deepEqual(records.rows, [
      { evidence_assessments: 0, risk_assessments: 0, handoffs: 0 },
    ]);
  },
);

test("R226：协调助手运行风险判断时必须由程序强制经过证据门", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  let judgeCalls = 0;
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v1",
    async judge(input) {
      judgeCalls += 1;
      const selected = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(fixture.lowRiskText)),
      );
      assert.ok(selected);
      return {
        verdict: "directly_answerable",
        candidateId: selected.id,
        sourcePageNumber: 911,
        supportingQuote: fixture.lowRiskText,
        reason: "原文足以回答。",
      };
    },
  };
  const model = {
    modelId: "coordinator-test",
    promptVersion: "coordinator-test-v1",
    async decide(input: { allowedActions: string[] }) {
      assert.deepEqual(input.allowedActions, ["run_risk_assessment"]);
      return {
        action: "run_risk_assessment" as const,
        searchRunId: fixture.search.searchRunId,
      };
    },
  };

  const step = await coordinateWorkOrderTurn(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    userMessage: "继续判断风险",
    requestId: "coordinator-evidence-gate",
    model,
    embedder: fixture.embedder,
    answerabilityJudge: judge,
  });

  assert.equal(judgeCalls, 1);
  assert.equal(step.contextAfter.latestRiskAssessment?.decision, "proposal_allowed");
  const toolResult = step.toolResult as Awaited<
    ReturnType<typeof assessEvidenceAndRunRisk>
  >;
  assert.equal(
    toolResult.evidenceAssessment.verdict,
    "directly_answerable",
  );
  assert.equal(toolResult.riskAssessment.decision, "proposal_allowed");
});

test("R274：协调助手必须用数据库当前状态覆盖模型填写的内部编号", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v5-two-stage",
    async judge(input) {
      const selected = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(fixture.lowRiskText)),
      );
      assert.ok(selected);
      return {
        verdict: "directly_answerable",
        candidateId: selected.id,
        sourcePageNumber: 911,
        supportingQuote: fixture.lowRiskText,
        reason: "原文直接支持外部检查。",
      };
    },
  };
  const assessed = await assessEvidenceAndRunRisk(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: fixture.search.searchRunId,
    evidenceIdempotencyKey: "bind-state-evidence",
    riskIdempotencyKey: "bind-state-risk",
    judge,
  });
  assert.equal(assessed.riskAssessment.decision, "proposal_allowed");
  const model = {
    modelId: "coordinator-test",
    promptVersion: "coordinator-v2",
    async decide() {
      return {
        action: "draft_resolution_proposal" as const,
        riskAssessmentId: 999_991,
        evidenceSearchHitIds: [999_992],
        summary: "根据当前正式资料执行外部检查。",
        confirmedFacts: ["设备报告OHF"],
        assumptions: ["只进行外部观察"],
        steps: ["保持设备完整，从外部观察通风口"],
        stopConditions: ["需要拆机或带电测量时停止并转人工"],
        expectedObservations: ["记录通风情况以及OHF是否继续出现"],
        basisObservationEventId: null,
      };
    },
  };
  const step = await coordinateWorkOrderTurnV2(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    userMessage: "生成第一版方案",
    requestId: "bind-current-database-state",
    model,
    embedder: fixture.embedder,
    answerabilityJudge: judge,
  });
  assert.equal(step.action, "draft_resolution_proposal");
  assert.equal(step.decision.action, "draft_resolution_proposal");
  if (step.decision.action !== "draft_resolution_proposal") assert.fail();
  assert.equal(
    step.decision.riskAssessmentId,
    assessed.riskAssessment.riskAssessmentId,
  );
  assert.deepEqual(step.decision.evidenceSearchHitIds, [
    assessed.evidenceAssessment?.selectedSearchHitId,
  ]);
  assert.equal(Object.hasOwn(step.decision, "basisObservationEventId"), false);
  assert.equal(step.contextAfter.latestProposal?.proposalVersion, 1);
});

test("R284：来源感知证据门必须把资料编号、版本和语言传给判断器", async (context) => {
  const { createSourceAwareWorkOrderJudge } = await import(
    "../src/evaluation/source-aware-work-order-judge.ts"
  );
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database, {
    queryText: "NVE41300的OHF解决措施列出了哪些检查？",
  });
  let receivedCandidates:
    | Array<{
        id: string;
        documentReference: string;
        versionLabel: string;
        languageCode: string;
        sources: Array<{ pageNumber: number; text: string }>;
      }>
    | undefined;
  const judge = createSourceAwareWorkOrderJudge(database, {
    modelId: "source-aware-controlled-judge",
    promptVersion: "answerability-v6-source-aware",
    async judge(input) {
      receivedCandidates = input.candidates;
      const selected = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(fixture.lowRiskText)),
      );
      assert.ok(selected);
      return {
        verdict: "directly_answerable",
        candidateId: selected.id,
        sourcePageNumber: selected.sources[0].pageNumber,
        supportingQuote: fixture.lowRiskText,
        reason: "资料编号与原文共同支持问题。",
      };
    },
  });
  const result = await assessEvidenceAndRunRisk(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: fixture.search.searchRunId,
    evidenceIdempotencyKey: "source-aware-evidence",
    riskIdempotencyKey: "source-aware-risk",
    judge,
  });
  assert.equal(result.evidenceAssessment?.verdict, "directly_answerable");
  assert.ok(receivedCandidates);
  assert.equal(receivedCandidates.length > 0, true);
  for (const candidate of receivedCandidates) {
    assert.equal(candidate.documentReference, "NVE41300");
    assert.equal(candidate.versionLabel, "05");
    assert.equal(candidate.languageCode, "zh-CN");
  }
});

test(
  "R286：补齐资料身份后U301必须由真实千问判为可直接回答",
  {
    skip: process.env.RUN_QWEN_SOURCE_AWARE_U301_REGRESSION !== "1",
    timeout: 180_000,
  },
  async (context) => {
    const [
      { createSourceAwareWorkOrderJudge },
      { createQwenAnswerabilityJudgeV6FromEnvironment },
      preRunRaw,
    ] = await Promise.all([
      import("../src/evaluation/source-aware-work-order-judge.ts"),
      import("../src/evaluation/qwen-answerability-judge-v6.ts"),
      readFile("reports/source-aware-u301-regression-prerun.json", "utf8"),
    ]);
    const preRun = JSON.parse(preRunRaw) as {
      status: string;
      data_role: string;
      target_case_id: string;
      frozen_inputs: Array<{ path: string; sha256: string }>;
      database_bundle: { paths: string[]; sha256: string };
    };
    assert.equal(preRun.status, "frozen_before_exposed_regression_run");
    assert.equal(preRun.data_role, "exposed_regression_not_unseen");
    assert.equal(preRun.target_case_id, "U301");
    for (const item of preRun.frozen_inputs) {
      assert.equal(
        createHash("sha256")
          .update(await readFile(item.path, "utf8"))
          .digest("hex"),
        item.sha256,
        `${item.path} changed after regression freeze`,
      );
    }
    assert.equal(
      createHash("sha256")
        .update(await readBundle(preRun.database_bundle.paths))
        .digest("hex"),
      preRun.database_bundle.sha256,
    );

    const database = await openMigratedDatabase();
    context.after(async () => database.close());
    const officialText =
      "解决措施 检查电机负载、变频器通风情况和环境温度。";
    const fixture = await createFixture(database, {
      queryText: "NVE41300的OHF解决措施具体列出了哪三项检查？",
      candidates: [
        {
          candidate_key: "ohf-checks",
          page_number: 395,
          section_title: "变频器过热的核查项",
          text: officialText,
          content_kind: "procedure",
          source_severity: "information",
          usage_policy: "low_risk_guidance",
        },
        {
          candidate_key: "work-warning",
          page_number: 7,
          section_title: "产品安全作业警告",
          text: "只有专业人员才能对此启动器进行安装、调节、修理与维护。",
          content_kind: "safety_warning",
          source_severity: "danger",
          usage_policy: "engineer_only",
        },
      ],
    });
    const realJudge = createQwenAnswerabilityJudgeV6FromEnvironment(process.env);
    const judge = createSourceAwareWorkOrderJudge(database, realJudge);
    const startedAt = performance.now();
    const result = await assessEvidenceAndRunRisk(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: fixture.membershipId,
      searchRunId: fixture.search.searchRunId,
      evidenceIdempotencyKey: "u301-source-aware-evidence",
      riskIdempotencyKey: "u301-source-aware-risk",
      judge,
    });
    const audit = await database.query<{
      handoffs: number;
      proposals: number;
    }>(`
      select
        (select count(*)::integer from human_handoffs) as handoffs,
        (select count(*)::integer from resolution_proposals) as proposals
    `);
    const report = {
      regression_run_at: new Date().toISOString(),
      elapsed_milliseconds: performance.now() - startedAt,
      data_role: "exposed_regression_not_unseen",
      target_case_id: "U301",
      source_first_run_report_sha256:
        "09fe158d945df6660d16c4191eae41ca225dc547b452b026752528323442a7c1",
      pre_run_record_sha256: createHash("sha256").update(preRunRaw).digest("hex"),
      model_id: realJudge.modelId,
      prompt_version: realJudge.promptVersion,
      actual_evidence_verdict: result.evidenceAssessment?.verdict,
      actual_source_page_number: result.evidenceAssessment?.sourcePageNumber,
      actual_supporting_quote: result.evidenceAssessment?.supportingQuote,
      actual_risk_decision: result.riskAssessment.decision,
      actual_final_state: audit.rows[0],
    };
    await writeReportOnce(
      "reports/qwen-source-aware-u301-regression-first-run.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.equal(report.actual_evidence_verdict, "directly_answerable");
    assert.equal(report.actual_source_page_number, 395);
    assert.equal(report.actual_supporting_quote, officialText);
    assert.equal(report.actual_risk_decision, "proposal_allowed");
    assert.deepEqual(report.actual_final_state, { handoffs: 0, proposals: 0 });
  },
);

test("R227：明确要求屏蔽保护时固定规则必须先于证据模型直接阻断", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const highRiskSearch = await searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "别让设备再报OHF，直接屏蔽这个保护监控。",
    idempotencyKey: "high-risk-intent-search",
    limit: 5,
    embedder: fixture.embedder,
  });
  let judgeCalls = 0;
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v1",
    async judge() {
      judgeCalls += 1;
      throw new Error("high-risk input must not call the evidence judge");
    },
  };

  const result = await assessEvidenceAndRunRisk(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: highRiskSearch.searchRunId,
    evidenceIdempotencyKey: "high-risk-evidence-skip",
    riskIdempotencyKey: "high-risk-rule-first",
    judge,
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result.evidenceAssessment, null);
  assert.equal(result.riskAssessment.decision, "human_handoff_required");
  assert.equal(result.riskAssessment.overallRiskLevel, "high");
  const audit = await database.query<{
    evidence_assessments: number;
    input_intent_matches: number;
  }>(`
    select
      (select count(*)::integer from evidence_assessments) as evidence_assessments,
      (
        select count(*)::integer
        from risk_assessment_hits as assessment_hit
        join safety_rules as safety_rule
          on safety_rule.id = assessment_hit.safety_rule_id
        where safety_rule.rule_code = 'INPUT_HIGH_RISK_INTENT'
      ) as input_intent_matches
  `);
  assert.deepEqual(audit.rows, [
    { evidence_assessments: 0, input_intent_matches: 1 },
  ]);
});

test(
  "R228：真实千问证据判断必须在工单主链路形成可追溯的低风险终态",
  {
    skip: process.env.RUN_QWEN_WORK_ORDER_EVIDENCE_CHAIN !== "1",
    timeout: 120_000,
  },
  async (context) => {
    const database = await openMigratedDatabase();
    context.after(async () => database.close());
    const fixture = await createFixture(database);
    const judge = createQwenAnswerabilityJudgeFromEnvironment();

    const result = await assessEvidenceAndRunRisk(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: fixture.membershipId,
      searchRunId: fixture.search.searchRunId,
      evidenceIdempotencyKey: "real-qwen-evidence-chain",
      riskIdempotencyKey: "real-qwen-risk-chain",
      judge,
    });

    assert.equal(
      result.evidenceAssessment?.verdict,
      "directly_answerable",
    );
    assert.equal(
      result.evidenceAssessment?.selectedKnowledgeChunkId,
      fixture.lowRiskChunkId,
    );
    assert.equal(result.riskAssessment.decision, "proposal_allowed");
    const audit = await database.query<{
      evidence_assessments: number;
      evidence_events: number;
      risk_assessments: number;
      handoffs: number;
      proposals: number;
    }>(`
      select
        (select count(*)::integer from evidence_assessments) as evidence_assessments,
        (
          select count(*)::integer
          from work_order_events
          where event_type = 'evidence_assessed'
        ) as evidence_events,
        (select count(*)::integer from risk_assessments) as risk_assessments,
        (select count(*)::integer from human_handoffs) as handoffs,
        (select count(*)::integer from resolution_proposals) as proposals
    `);
    assert.deepEqual(audit.rows, [
      {
        evidence_assessments: 1,
        evidence_events: 1,
        risk_assessments: 1,
        handoffs: 0,
        proposals: 0,
      },
    ]);
  },
);

test("R229：证据不足转人工后的相同请求必须幂等重放且不再调用模型", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  let judgeCalls = 0;
  const judge: QwenAnswerabilityJudge = {
    modelId: "qwen-evidence-test",
    promptVersion: "answerability-v1",
    async judge(input) {
      judgeCalls += 1;
      const selected = input.candidates.find(({ sources }) =>
        sources.some(({ text }) => text.includes(fixture.lowRiskText)),
      );
      assert.ok(selected);
      return {
        verdict: "partially_related",
        candidateId: selected.id,
        sourcePageNumber: 911,
        supportingQuote: fixture.lowRiskText,
        reason: "资料相关但不足以回答完整问题。",
      };
    },
  };
  const request = {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: fixture.search.searchRunId,
    evidenceIdempotencyKey: "replay-insufficient-evidence",
    riskIdempotencyKey: "replay-insufficient-risk",
    judge,
  };

  const first = await assessEvidenceAndRunRisk(database, request);
  const second = await assessEvidenceAndRunRisk(database, request);

  assert.equal(judgeCalls, 1);
  assert.equal(
    second.evidenceAssessment?.evidenceAssessmentId,
    first.evidenceAssessment?.evidenceAssessmentId,
  );
  assert.equal(
    second.riskAssessment.riskAssessmentId,
    first.riskAssessment.riskAssessmentId,
  );
  const audit = await database.query<{
    evidence_assessments: number;
    risk_assessments: number;
    handoffs: number;
  }>(`
    select
      (select count(*)::integer from evidence_assessments) as evidence_assessments,
      (select count(*)::integer from risk_assessments) as risk_assessments,
      (select count(*)::integer from human_handoffs) as handoffs
  `);
  assert.deepEqual(audit.rows, [
    { evidence_assessments: 1, risk_assessments: 1, handoffs: 1 },
  ]);
});

test(
  "R233：封存的四分支首次真实模型运行必须全部形成预期数据库终态",
  {
    skip: process.env.RUN_QWEN_WORK_ORDER_EVIDENCE_HOLDOUT !== "1",
    timeout: 180_000,
  },
  async () => {
    const [dataset, datasetRaw, judgeRaw, evidenceGateRaw, riskGateRaw, preRunRaw] =
      await Promise.all([
        loadWorkOrderEvidenceChainHoldout(),
        readFile(
          "data/evaluation/work-order-evidence-chain-holdout-v1.json",
          "utf8",
        ),
        readFile("src/evaluation/qwen-answerability-judge.ts", "utf8"),
        readFile("src/agent-tools/assess-work-order-evidence.ts", "utf8"),
        readFile("src/agent-tools/assess-evidence-and-run-risk.ts", "utf8"),
        readFile(
          "reports/work-order-evidence-chain-holdout-v1-prerun.json",
          "utf8",
        ),
      ]);
    validateWorkOrderEvidenceChainFreeze({
      datasetRaw,
      judgeRaw,
      evidenceGateRaw,
      riskGateRaw,
      preRunRaw,
    });

    const realJudge = createQwenAnswerabilityJudgeFromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: dataset.strategy.requested_model_id,
    });
    assert.equal(realJudge.modelId, dataset.strategy.requested_model_id);
    assert.equal(realJudge.promptVersion, dataset.strategy.judge_prompt_version);
    const actualCases = await runFrozenEvidenceCases(dataset, realJudge);

    const report = scoreWorkOrderEvidenceChainHoldout(dataset, actualCases, {
      model_id: realJudge.modelId,
      prompt_version: realJudge.promptVersion,
    });
    await writeReportOnce(
      "reports/work-order-evidence-chain-holdout-v1-first-run.json",
      `${JSON.stringify(
        { first_model_run_at: new Date().toISOString(), ...report },
        null,
        2,
      )}\n`,
    );

    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);

test(
  "R236：第二版互斥分类策略必须修复已知失败且四分支数据库终态全部通过",
  {
    skip: process.env.RUN_QWEN_WORK_ORDER_EVIDENCE_V2_REGRESSION !== "1",
    timeout: 180_000,
  },
  async () => {
    const [dataset, datasetRaw, firstRunRaw, v2JudgeRaw, planRaw] =
      await Promise.all([
        loadWorkOrderEvidenceChainHoldout(),
        readFile(
          "data/evaluation/work-order-evidence-chain-holdout-v1.json",
          "utf8",
        ),
        readFile(
          "reports/work-order-evidence-chain-holdout-v1-first-run.json",
          "utf8",
        ),
        readFile("src/evaluation/qwen-answerability-judge-v2.ts", "utf8"),
        readFile(
          "reports/work-order-evidence-chain-v2-regression-plan.json",
          "utf8",
        ),
      ]);
    validateWorkOrderEvidenceV2RegressionPlan({
      datasetRaw,
      firstRunRaw,
      v2JudgeRaw,
      planRaw,
    });

    const realJudge = createQwenAnswerabilityJudgeV2FromEnvironment({
      ...process.env,
      QWEN_ANSWERABILITY_MODEL: dataset.strategy.requested_model_id,
    });
    assert.equal(realJudge.modelId, dataset.strategy.requested_model_id);
    assert.equal(realJudge.promptVersion, "answerability-v2");
    const actualCases = await runFrozenEvidenceCases(dataset, realJudge);
    const report = scoreWorkOrderEvidenceChainHoldout(dataset, actualCases, {
      model_id: realJudge.modelId,
      prompt_version: realJudge.promptVersion,
    });
    await writeReportOnce(
      "reports/work-order-evidence-chain-v2-regression.json",
      `${JSON.stringify(
        {
          regression_run_at: new Date().toISOString(),
          data_role: "exposed_regression_not_unseen_holdout",
          ...report,
        },
        null,
        2,
      )}\n`,
    );

    assert.equal(report.passed, true, JSON.stringify(report.cases, null, 2));
  },
);
