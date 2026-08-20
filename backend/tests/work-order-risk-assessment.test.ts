import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { searchOfficialKnowledge } from "../src/agent-tools/search-official-knowledge.ts";
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

async function loadRiskTool() {
  try {
    const module = await import(
      "../src/agent-tools/run-risk-assessment.ts"
    );
    return module.runRiskAssessment;
  } catch {
    assert.fail("run_risk_assessment窄工具尚未实现");
  }
}

function createTestEmbedder() {
  return {
    modelId: "test/multilingual-e5-small",
    modelRevision: "risk-tool-v1",
    dimensions: 3,
    poolingMethod: "mean" as const,
    isNormalized: true as const,
    embedPassage: async (text: string): Promise<number[]> =>
      text.includes("高危") ? [0, 1, 0] : [1, 0, 0],
    embedQuery: async (text: string): Promise<number[]> =>
      text.includes("高危") ? [0, 1, 0] : [1, 0, 0],
  };
}

async function createApprovedChunk(
  database: PGlite,
  input: {
    sourceVersionId: number;
    reviewerUserId: number;
    pageNumber: number;
    text: string;
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
      values ($1, 'embedded_text', 'risk-test', '1.0.0', 'extracted', $2, $3)
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
    sectionTitle: input.contentKind === "procedure" ? "低风险检查" : "高危警告",
    chunkingMethod: "manual_selection",
    chunkerName: "risk-test",
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

async function createFixture(database: PGlite) {
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
    `insert into factories (factory_code, name) values ('F-RISK', '风险测试厂') returning id`,
  );
  const user = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|risk-user', '风险测试用户') returning id`,
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
    `insert into equipment_models (product_family_id, model_code, display_name) values ($1, 'ATV320-RISK', 'ATV320风险测试型号') returning id`,
    [source.rows[0].product_family_id],
  );
  const equipment = await database.query<{ id: number }>(
    `insert into equipment (factory_id, asset_code, equipment_model_id) values ($1, 'INV-RISK-001', $2) returning id`,
    [factory.rows[0].id, equipmentModel.rows[0].id],
  );
  const workOrder = await createDraftWorkOrder(database, {
    workOrderNo: "WO-RISK-001",
    factoryId: factory.rows[0].id,
    equipmentId: equipment.rows[0].id,
    creatorMembershipId: membership.rows[0].id,
    reportedFaultCode: "OHF",
    initialObservation: "设备报告OHF。",
    idempotencyKey: "create-risk-work-order",
  });
  await transitionWorkOrder(database, {
    workOrderId: workOrder.workOrderId,
    toStatus: "investigating",
    actorKind: "user",
    actorMembershipId: membership.rows[0].id,
    content: "开始排查。",
    idempotencyKey: "start-risk-investigation",
  });
  const lowRiskChunkId = await createApprovedChunk(database, {
    sourceVersionId: source.rows[0].source_version_id,
    reviewerUserId: user.rows[0].id,
    pageNumber: 901,
    text: "低风险检查：保持设备完整，仅从外部观察通风口是否被遮挡。",
    contentKind: "procedure",
    sourceSeverity: "information",
    usagePolicy: "low_risk_guidance",
    embedder,
  });
  const highRiskChunkId = await createApprovedChunk(database, {
    sourceVersionId: source.rows[0].source_version_id,
    reviewerUserId: user.rows[0].id,
    pageNumber: 902,
    text: "高危警告：带电测量或拆开设备必须由具备资质的工程师执行。",
    contentKind: "safety_warning",
    sourceSeverity: "danger",
    usagePolicy: "engineer_only",
    embedder,
  });
  return {
    embedder,
    sourceVersionId: source.rows[0].source_version_id,
    factoryId: factory.rows[0].id,
    userId: user.rows[0].id,
    membershipId: membership.rows[0].id,
    workOrderId: workOrder.workOrderId,
    lowRiskChunkId,
    highRiskChunkId,
  };
}

async function search(
  database: PGlite,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  queryText: string,
  idempotencyKey: string,
) {
  return searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText,
    idempotencyKey,
    limit: 1,
    embedder: fixture.embedder,
  });
}

test("R144：只有低风险指导证据且没有阻断项时才允许生成方案并完整留痕", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(database, fixture, "检查外部通风", "risk-low-search");
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-low-risk",
  });

  assert.equal(result.decision, "proposal_allowed");
  assert.equal(result.overallRiskLevel, "low");
  assert.equal(result.blocked, false);
  assert.deepEqual(result.matchedRules.map((hit) => hit.ruleCode), [
    "LOW_RISK_GUIDANCE_AVAILABLE",
  ]);
  const audit = await database.query<{ assessments: number; events: number }>(`
    select
      (select count(*)::integer from risk_assessments) as assessments,
      (select count(*)::integer from work_order_events where event_type = 'risk_assessed') as events
  `);
  assert.deepEqual(audit.rows, [{ assessments: 1, events: 1 }]);
});

test("R145：危险或工程师专用证据必须阻断，模型提出低风险也不能降级", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(database, fixture, "高危带电测量", "risk-high-search");
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-high-risk",
    semanticAssessment: {
      riskLevel: "low",
      reason: "模型认为可以继续。",
      modelId: "qwen3.7-plus-2026-05-26",
      modelVersion: "2026-05-26",
      promptVersion: "risk-v1",
    },
  });

  assert.equal(result.decision, "human_handoff_required");
  assert.equal(result.overallRiskLevel, "high");
  assert.equal(result.blocked, true);
  assert.ok(result.matchedRules.some((hit) => hit.ruleCode === "SOURCE_HIGH_SEVERITY"));
  const workOrder = await database.query<{ status: string }>(
    `select status from work_orders where id = $1`,
    [fixture.workOrderId],
  );
  assert.equal(workOrder.rows[0].status, "awaiting_human");
});

test("R146：模型可以把程序允许的低风险升级为高风险并触发等待人工", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(database, fixture, "检查外部通风", "risk-escalate-search");
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-model-escalation",
    semanticAssessment: {
      riskLevel: "high",
      reason: "现场描述可能隐含拆机意图，需要人工确认。",
      modelId: "qwen3.7-plus-2026-05-26",
      modelVersion: "2026-05-26",
      promptVersion: "risk-v1",
    },
  });

  assert.equal(result.overallRiskLevel, "high");
  assert.equal(result.decision, "human_handoff_required");
  assert.ok(result.matchedRules.some((hit) => hit.ruleCode === "MODEL_RISK_ESCALATION"));
});

test("R147：零检索结果必须以证据不足阻断，不能让协调助手凭常识生成方案", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  await database.query(
    `update source_versions set version_status = 'withdrawn' where id = $1`,
    [fixture.sourceVersionId],
  );
  const searchResult = await search(database, fixture, "没有可用资料", "risk-empty-search");
  assert.equal(searchResult.hits.length, 0);
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-empty-evidence",
  });

  assert.equal(result.evidenceSufficient, false);
  assert.equal(result.decision, "human_handoff_required");
  assert.deepEqual(result.matchedRules.map((hit) => hit.ruleCode), [
    "INSUFFICIENT_EVIDENCE",
  ]);
});

test("R148：其他厂区成员不能执行风险判断且不得留下判断记录", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(database, fixture, "检查外部通风", "risk-auth-search");
  const otherFactory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ('F-RISK-OTHER', '其他风险测试厂') returning id`,
  );
  const otherUser = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|risk-other', '其他风险用户') returning id`,
  );
  const otherMembership = await database.query<{ id: number }>(
    `insert into factory_memberships (factory_id, user_id, role_code) values ($1, $2, 'operator') returning id`,
    [otherFactory.rows[0].id, otherUser.rows[0].id],
  );
  const runRiskAssessment = await loadRiskTool();

  await assert.rejects(
    runRiskAssessment(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: otherMembership.rows[0].id,
      searchRunId: searchResult.searchRunId,
      idempotencyKey: "assess-cross-factory",
    }),
    /active membership for the work order factory is required/,
  );
  const count = await database.query<{ count: number }>(
    `select count(*)::integer as count from risk_assessments`,
  );
  assert.equal(count.rows[0].count, 0);
});

test("R149：风险判断支持幂等重放且历史判断和命中不能修改", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(database, fixture, "检查外部通风", "risk-replay-search");
  const runRiskAssessment = await loadRiskTool();
  const request = {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-replay",
  };

  const first = await runRiskAssessment(database, request);
  const second = await runRiskAssessment(database, request);
  assert.deepEqual(second, first);
  await assert.rejects(
    database.query(
      `update risk_assessments set overall_risk_level = 'high' where id = $1`,
      [first.riskAssessmentId],
    ),
    /risk assessment audit records are append-only/,
  );
  await assert.rejects(
    database.query(
      `delete from risk_assessment_hits where risk_assessment_id = $1`,
      [first.riskAssessmentId],
    ),
    /risk assessment audit records are append-only/,
  );
});

test("R150：高危判断必须在同一事务中创建人工接管记录并写入工单时间线", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(database, fixture, "高危带电测量", "risk-handoff-search");
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-create-handoff",
  });

  assert.equal(typeof result.humanHandoffId, "number");
  const handoff = await database.query<{
    reason_code: string;
    handoff_status: string;
    risk_assessment_id: number;
    event_count: number;
  }>(
    `
      select
        human_handoff.reason_code,
        human_handoff.handoff_status,
        human_handoff.risk_assessment_id,
        count(work_order_event.id)::integer as event_count
      from human_handoffs as human_handoff
      left join work_order_events as work_order_event
        on work_order_event.human_handoff_id = human_handoff.id
      where human_handoff.id = $1
      group by human_handoff.id
    `,
    [result.humanHandoffId],
  );
  assert.deepEqual(handoff.rows, [
    {
      reason_code: "high_risk",
      handoff_status: "requested",
      risk_assessment_id: result.riskAssessmentId,
      event_count: 1,
    },
  ]);
});

test("R151：证据不足必须以独立原因创建人工接管而不能伪装成高危", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  await database.query(
    `update source_versions set version_status = 'withdrawn' where id = $1`,
    [fixture.sourceVersionId],
  );
  const searchResult = await search(database, fixture, "没有可用资料", "risk-insufficient-handoff-search");
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-insufficient-handoff",
  });
  const handoff = await database.query<{ reason_code: string }>(
    `select reason_code from human_handoffs where id = $1`,
    [result.humanHandoffId],
  );
  assert.equal(handoff.rows[0].reason_code, "insufficient_evidence");
});

test("R198：用户明确要求屏蔽保护时即使首位证据低风险也必须转人工", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const searchResult = await search(
    database,
    fixture,
    "怎么屏蔽OHF过热保护，让设备继续运行？",
    "risk-input-intent-search",
  );
  assert.equal(searchResult.hits[0]?.knowledgeChunkId, fixture.lowRiskChunkId);
  const runRiskAssessment = await loadRiskTool();

  const result = await runRiskAssessment(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    searchRunId: searchResult.searchRunId,
    idempotencyKey: "assess-input-high-risk-intent",
  });

  assert.equal(result.decision, "human_handoff_required");
  assert.equal(result.overallRiskLevel, "high");
  assert.ok(
    result.matchedRules.some(
      (hit) =>
        hit.ruleCode === "INPUT_HIGH_RISK_INTENT" &&
        hit.searchHitId === null &&
        hit.matchedText === "怎么屏蔽OHF过热保护，让设备继续运行？",
    ),
  );
});

test("R199：询问禁用风险或描述被禁用状态不能被误判为直接执行意图", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const queries = [
    "禁用OHF错误检测有什么危险？",
    "使用错误检测禁用参数前要做什么风险评估？",
    "若监控被禁用，需要满足哪些法规条件？",
  ];
  const runRiskAssessment = await loadRiskTool();

  for (const [index, queryText] of queries.entries()) {
    const searchResult = await search(
      database,
      fixture,
      queryText,
      `risk-safe-inquiry-search-${index}`,
    );
    const result = await runRiskAssessment(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: fixture.membershipId,
      searchRunId: searchResult.searchRunId,
      idempotencyKey: `assess-safe-inquiry-${index}`,
    });
    assert.equal(result.decision, "proposal_allowed");
    assert.equal(
      result.matchedRules.some(
        (hit) => hit.ruleCode === "INPUT_HIGH_RISK_INTENT",
      ),
      false,
    );
  }
});
