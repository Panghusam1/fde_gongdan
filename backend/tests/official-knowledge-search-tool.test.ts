import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { createKnowledgeChunkCandidate } from "../src/knowledge/create-knowledge-chunk-candidate.ts";
import { reviewKnowledgeChunk } from "../src/knowledge/review-knowledge-chunk.ts";
import { indexApprovedKnowledgeChunk } from "../src/retrieval/index-approved-knowledge-chunk.ts";
import { createDraftWorkOrder } from "../src/work-orders/create-draft-work-order.ts";

async function openMigratedDatabase(): Promise<PGlite> {
  const database = await PGlite.create({
    dataDir: "memory://",
    extensions: { vector },
  });
  const migrationsDirectory = new URL("../database/migrations/", import.meta.url);
  const migrations = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    await database.exec(
      await readFile(new URL(migration, migrationsDirectory), "utf8"),
    );
  }
  await database.exec(
    await readFile(
      new URL("../database/seeds/001_atv320_nve41300.sql", import.meta.url),
      "utf8",
    ),
  );
  return database;
}

async function loadSearchTool() {
  try {
    const module = await import(
      "../src/agent-tools/search-official-knowledge.ts"
    );
    return module.searchOfficialKnowledge;
  } catch {
    assert.fail("search_official_knowledge窄工具尚未实现");
  }
}

function createTestEmbedder(options?: { onQuery?: () => Promise<void> }) {
  let queryCalls = 0;
  return {
    embedder: {
      modelId: "test/multilingual-e5-small",
      modelRevision: "official-search-tool-v1",
      dimensions: 3,
      poolingMethod: "mean" as const,
      isNormalized: true as const,
      embedPassage: async (text: string): Promise<number[]> =>
        text.includes("手动清除") ? [0, 1, 0] : [1, 0, 0],
      embedQuery: async (): Promise<number[]> => {
        queryCalls += 1;
        await options?.onQuery?.();
        return [1, 0, 0];
      },
    },
    getQueryCalls: () => queryCalls,
  };
}

async function createApprovedChunk(
  database: PGlite,
  input: {
    sourceVersionId: number;
    reviewerUserId: number;
    productFamilyId: number;
    pageNumber: number;
    text: string;
    sectionTitle: string;
    contentKind: "fault_definition" | "reset_condition";
    embedder: ReturnType<typeof createTestEmbedder>["embedder"];
  },
): Promise<number> {
  const page = await database.query<{ id: number }>(
    `
      insert into document_pages (source_version_id, pdf_page_number)
      values ($1, $2)
      returning id
    `,
    [input.sourceVersionId, input.pageNumber],
  );
  const extraction = await database.query<{ id: number }>(
    `
      insert into page_extractions (
        document_page_id,
        extraction_method,
        extractor_name,
        extractor_version,
        extraction_status,
        extracted_text,
        text_sha256
      )
      values ($1, 'embedded_text', 'tool-test', '1.0.0', 'extracted', $2, $3)
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
    sourceSeverity: "information",
    usagePolicy: "reference_only",
    faultCode: "OHF",
    sectionTitle: input.sectionTitle,
    chunkingMethod: "manual_selection",
    chunkerName: "official-search-tool-test",
    chunkerVersion: "1.0.0",
    sources: [
      {
        pageExtractionId: extraction.rows[0].id,
        excerpt: input.text,
      },
    ],
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
  embedder: ReturnType<typeof createTestEmbedder>["embedder"],
) {
  const source = await database.query<{
    product_family_id: number;
    source_version_id: number;
  }>(`
    select
      source_document.product_family_id,
      source_version.id as source_version_id
    from source_versions as source_version
    join source_documents as source_document
      on source_document.id = source_version.source_document_id
    where lower(btrim(source_document.document_reference)) = 'nve41300'
      and lower(btrim(source_version.version_label)) = '05'
      and lower(btrim(source_version.language_code)) = 'zh-cn'
  `);
  assert.equal(source.rows.length, 1);
  await database.query(
    `update source_versions set version_status = 'current' where id = $1`,
    [source.rows[0].source_version_id],
  );

  const factory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ('F-TOOL', '工具测试厂') returning id`,
  );
  const user = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|tool-user', '工具测试用户') returning id`,
  );
  const membership = await database.query<{ id: number }>(
    `
      insert into factory_memberships (factory_id, user_id, role_code)
      values ($1, $2, 'operator')
      returning id
    `,
    [factory.rows[0].id, user.rows[0].id],
  );
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [source.rows[0].product_family_id, user.rows[0].id],
  );
  const equipmentModel = await database.query<{ id: number }>(
    `
      insert into equipment_models (product_family_id, model_code, display_name)
      values ($1, 'ATV320U07N4C-TOOL', 'ATV320工具测试型号')
      returning id
    `,
    [source.rows[0].product_family_id],
  );
  const equipment = await database.query<{ id: number }>(
    `
      insert into equipment (factory_id, asset_code, equipment_model_id)
      values ($1, 'INV-TOOL-001', $2)
      returning id
    `,
    [factory.rows[0].id, equipmentModel.rows[0].id],
  );
  const workOrder = await createDraftWorkOrder(database, {
    workOrderNo: "WO-TOOL-001",
    factoryId: factory.rows[0].id,
    equipmentId: equipment.rows[0].id,
    creatorMembershipId: membership.rows[0].id,
    reportedFaultCode: "OHF",
    initialObservation: "设备报告OHF。",
    idempotencyKey: "create-tool-work-order",
  });
  const definitionId = await createApprovedChunk(database, {
    sourceVersionId: source.rows[0].source_version_id,
    reviewerUserId: user.rows[0].id,
    productFamilyId: source.rows[0].product_family_id,
    pageNumber: 801,
    text: "OHF表示设备过热。",
    sectionTitle: "故障定义",
    contentKind: "fault_definition",
    embedder,
  });
  await createApprovedChunk(database, {
    sourceVersionId: source.rows[0].source_version_id,
    reviewerUserId: user.rows[0].id,
    productFamilyId: source.rows[0].product_family_id,
    pageNumber: 802,
    text: "原因消失后可以手动清除OHF。",
    sectionTitle: "故障复位",
    contentKind: "reset_condition",
    embedder,
  });

  return {
    factoryId: factory.rows[0].id,
    membershipId: membership.rows[0].id,
    productFamilyId: source.rows[0].product_family_id,
    equipmentModelId: equipmentModel.rows[0].id,
    workOrderId: workOrder.workOrderId,
    definitionId,
  };
}

test("R136：窄工具从工单推导产品范围并把查询、证据排名和工单事件一起留痕", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  const searchOfficialKnowledge = await loadSearchTool();

  const result = await searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "OHF设备过热是什么意思",
    limit: 2,
    idempotencyKey: "search-definition-1",
    embedder: model.embedder,
  });

  assert.equal(result.productFamilyId, fixture.productFamilyId);
  assert.equal(result.equipmentModelId, fixture.equipmentModelId);
  assert.equal(result.hits[0].knowledgeChunkId, fixture.definitionId);
  assert.equal(result.hits[0].resultRank, 1);
  assert.equal(result.hits[0].vectorRank, 1);

  const audit = await database.query<{
    product_family_id: number;
    query_text: string;
    model_revision: string;
    hit_count: number;
    event_count: number;
  }>(
    `
      select
        search_run.product_family_id,
        search_run.query_text,
        search_run.model_revision,
        count(distinct search_hit.id)::integer as hit_count,
        count(distinct work_order_event.id)::integer as event_count
      from knowledge_search_runs as search_run
      left join knowledge_search_hits as search_hit
        on search_hit.search_run_id = search_run.id
      left join work_order_events as work_order_event
        on work_order_event.knowledge_search_run_id = search_run.id
      where search_run.id = $1
      group by search_run.id
    `,
    [result.searchRunId],
  );
  assert.deepEqual(audit.rows, [
    {
      product_family_id: fixture.productFamilyId,
      query_text: "OHF设备过热是什么意思",
      model_revision: "official-search-tool-v1",
      hit_count: 2,
      event_count: 1,
    },
  ]);
});

test("R137：其他厂区成员不能借协调助手检索本工单且失败前不调用模型", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  const otherFactory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ('F-OTHER', '其他厂') returning id`,
  );
  const otherUser = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|other', '其他用户') returning id`,
  );
  const otherMembership = await database.query<{ id: number }>(
    `
      insert into factory_memberships (factory_id, user_id, role_code)
      values ($1, $2, 'operator')
      returning id
    `,
    [otherFactory.rows[0].id, otherUser.rows[0].id],
  );
  const searchOfficialKnowledge = await loadSearchTool();

  await assert.rejects(
    searchOfficialKnowledge(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: otherMembership.rows[0].id,
      queryText: "OHF是什么",
      idempotencyKey: "cross-factory-search",
      embedder: model.embedder,
    }),
    /active membership for the work order factory is required/,
  );
  assert.equal(model.getQueryCalls(), 0);
  const runCount = await database.query<{ count: number }>(
    `select count(*)::integer as count from knowledge_search_runs`,
  );
  assert.equal(runCount.rows[0].count, 0);
});

test("R138：已经保存的检索运行和命中证据只能追加不能修改或删除", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  const searchOfficialKnowledge = await loadSearchTool();
  const result = await searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "OHF是什么意思",
    idempotencyKey: "immutable-search",
    embedder: model.embedder,
  });

  await assert.rejects(
    database.query(
      `update knowledge_search_runs set query_text = '被篡改' where id = $1`,
      [result.searchRunId],
    ),
    /knowledge search audit records are append-only/,
  );
  await assert.rejects(
    database.query(
      `delete from knowledge_search_hits where search_run_id = $1`,
      [result.searchRunId],
    ),
    /knowledge search audit records are append-only/,
  );
});

test("R139：模型计算期间权限失效时必须重新校验并且不能留下半次检索", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  let membershipId = 0;
  const model = createTestEmbedder({
    onQuery: async () => {
      await database.query(
        `update factory_memberships set is_active = false where id = $1`,
        [membershipId],
      );
    },
  });
  const fixture = await createFixture(database, model.embedder);
  membershipId = fixture.membershipId;
  const searchOfficialKnowledge = await loadSearchTool();

  await assert.rejects(
    searchOfficialKnowledge(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: fixture.membershipId,
      queryText: "设备过热是什么意思",
      idempotencyKey: "permission-changed",
      embedder: model.embedder,
    }),
    /authorization or equipment scope changed while search was running/,
  );
  const counts = await database.query<{ runs: number; events: number }>(`
    select
      (select count(*)::integer from knowledge_search_runs) as runs,
      (
        select count(*)::integer
        from work_order_events
        where event_type = 'knowledge_searched'
      ) as events
  `);
  assert.deepEqual(counts.rows, [{ runs: 0, events: 0 }]);
});

test("R140：相同幂等请求直接返回已保存证据而不重复调用模型，冲突请求被拒绝", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  const searchOfficialKnowledge = await loadSearchTool();
  const request = {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "OHF是什么意思",
    limit: 2,
    idempotencyKey: "retry-same-search",
    embedder: model.embedder,
  };

  const first = await searchOfficialKnowledge(database, request);
  const second = await searchOfficialKnowledge(database, request);
  assert.equal(second.searchRunId, first.searchRunId);
  assert.deepEqual(second.hits, first.hits);
  assert.equal(model.getQueryCalls(), 1);

  await assert.rejects(
    searchOfficialKnowledge(database, {
      ...request,
      queryText: "换了一个问题",
    }),
    /idempotency key was already used for a different search/,
  );
  assert.equal(model.getQueryCalls(), 1);
});

test("R141：每条检索结果必须返回可核验的资料编号、版本、页码和逐字摘录", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  const searchOfficialKnowledge = await loadSearchTool();

  const result = await searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "OHF设备过热是什么意思",
    limit: 1,
    idempotencyKey: "search-with-citation",
    embedder: model.embedder,
  });

  assert.deepEqual(result.hits[0].citations, [
    {
      sourceOrder: 1,
      publisher: "Schneider Electric",
      title: "ATV320 编程手册",
      documentReference: "NVE41300",
      officialUrl:
        "https://www.schneider-electric.cn/zh/download/document/NVE41300/",
      versionLabel: "05",
      documentIssueLabel: "07/2024",
      languageCode: "zh-CN",
      sourceVersionSha256:
        "a6a033d439ab3340bde3d062979aba8bd6014762d12e2fb39aafe34aef000e57",
      pdfPageNumber: 801,
      startCharacter: 1,
      endCharacter: 11,
      sourceExcerpt: "OHF表示设备过热。",
    },
  ]);
});

test("R142：资料版本撤回后不得返回旧知识，但零结果检索仍必须留痕", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  await database.query(
    `
      update source_versions
      set version_status = 'withdrawn'
      where id = (
        select knowledge_chunk.source_version_id
        from knowledge_chunks as knowledge_chunk
        where knowledge_chunk.id = $1
      )
    `,
    [fixture.definitionId],
  );
  const searchOfficialKnowledge = await loadSearchTool();

  const result = await searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "OHF是什么意思",
    idempotencyKey: "withdrawn-source-search",
    embedder: model.embedder,
  });

  assert.deepEqual(result.hits, []);
  const audit = await database.query<{ runs: number; hits: number }>(`
    select
      (select count(*)::integer from knowledge_search_runs) as runs,
      (select count(*)::integer from knowledge_search_hits) as hits
  `);
  assert.deepEqual(audit.rows, [{ runs: 1, hits: 0 }]);
});

test("R143：用户账号停用后即使厂区成员关系仍启用也必须在模型调用前拒绝", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  await database.query(
    `
      update users
      set is_active = false
      where id = (
        select user_id
        from factory_memberships
        where id = $1
      )
    `,
    [fixture.membershipId],
  );
  const searchOfficialKnowledge = await loadSearchTool();

  await assert.rejects(
    searchOfficialKnowledge(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: fixture.membershipId,
      queryText: "OHF是什么意思",
      idempotencyKey: "inactive-user-search",
      embedder: model.embedder,
    }),
    /active membership for the work order factory is required/,
  );
  assert.equal(model.getQueryCalls(), 0);
});

test("R197：问题明确写入其他ATV产品族时必须零命中留痕且不调用向量模型", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const model = createTestEmbedder();
  const fixture = await createFixture(database, model.embedder);
  const searchOfficialKnowledge = await loadSearchTool();

  const result = await searchOfficialKnowledge(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    queryText: "当前设备是ATV930，请查询它的OHF说明",
    idempotencyKey: "conflicting-product-family-search",
    embedder: model.embedder,
  });

  assert.deepEqual(result.hits, []);
  assert.equal(model.getQueryCalls(), 0);
  const audit = await database.query<{
    runs: number;
    hits: number;
    events: number;
  }>(`
    select
      (select count(*)::integer from knowledge_search_runs) as runs,
      (select count(*)::integer from knowledge_search_hits) as hits,
      (
        select count(*)::integer
        from work_order_events
        where knowledge_search_run_id is not null
      ) as events
  `);
  assert.deepEqual(audit.rows, [{ runs: 1, hits: 0, events: 1 }]);
});
