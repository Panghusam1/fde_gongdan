import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { createKnowledgeChunkCandidate } from "../src/knowledge/create-knowledge-chunk-candidate.ts";
import { reviewKnowledgeChunk } from "../src/knowledge/review-knowledge-chunk.ts";

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

async function getAtv320Context(database: PGlite): Promise<{
  productFamilyId: number;
  sourceVersionId: number;
}> {
  const result = await database.query<{
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
  assert.equal(result.rows.length, 1);
  return {
    productFamilyId: result.rows[0].product_family_id,
    sourceVersionId: result.rows[0].source_version_id,
  };
}

async function createUser(database: PGlite, key: string): Promise<number> {
  const result = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ($1, $2)
      returning id
    `,
    [`idp|${key}`, `测试审核人-${key}`],
  );
  return result.rows[0].id;
}

async function createCandidate(
  database: PGlite,
  sourceVersionId: number,
  key: string,
): Promise<number> {
  const extractedText = `变频器热状态。100% = 额定热状态，1 18% =“OHF”阈值。${key}`;
  const page = await database.query<{ id: number }>(
    `
      insert into document_pages (source_version_id, pdf_page_number)
      values ($1, 50)
      returning id
    `,
    [sourceVersionId],
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
      values ($1, 'embedded_text', 'pypdf', '6.10.0', 'extracted', $2, $3)
      returning id
    `,
    [
      page.rows[0].id,
      extractedText,
      createHash("sha256").update(extractedText).digest("hex"),
    ],
  );
  const candidate = await createKnowledgeChunkCandidate(database, {
    sourceVersionId,
    contentKind: "threshold",
    sourceSeverity: "information",
    usagePolicy: "reference_only",
    faultCode: "OHF",
    sectionTitle: "变频器热状态",
    chunkingMethod: "ai_proposed",
    chunkerName: "coordinator-agent",
    chunkerVersion: "1.0.0",
    sources: [{ pageExtractionId: extraction.rows[0].id, excerpt: extractedText }],
  });
  return candidate.knowledgeChunkId;
}

test("R113：知识审核资格必须绑定真实用户和具体产品族且不能重复", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R113");

  await database.query(
    `
      insert into product_family_knowledge_reviewers (
        product_family_id,
        user_id
      )
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );

  await assert.rejects(
    database.query(
      `
        insert into product_family_knowledge_reviewers (
          product_family_id,
          user_id
        )
        values ($1, $2)
      `,
      [fixture.productFamilyId, reviewerUserId],
    ),
    /unique/i,
  );
});

test("R114：审核状态改变时数据库自动保存修改前后快照", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R114");
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R114",
  );

  await database.query(
    `
      update knowledge_chunks
      set
        review_status = 'approved',
        verified_text = '变频器热状态。100% = 额定热状态，118% =“OHF”阈值。R114',
        reviewed_by_user_id = $2,
        reviewed_at = now(),
        review_notes = '对照PDF视觉页面，将机器提取的1 18%核对为118%。'
      where id = $1
    `,
    [knowledgeChunkId, reviewerUserId],
  );

  const events = await database.query<{
    decision: string;
    reviewer_user_id: number;
    before_snapshot: {
      reviewStatus: string;
      originalText: string;
      verifiedText: string | null;
    };
    after_snapshot: {
      reviewStatus: string;
      originalText: string;
      verifiedText: string | null;
    };
  }>(
    `
      select
        decision,
        reviewer_user_id,
        before_snapshot,
        after_snapshot
      from knowledge_chunk_review_events
      where knowledge_chunk_id = $1
    `,
    [knowledgeChunkId],
  );

  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].decision, "approved");
  assert.equal(events.rows[0].reviewer_user_id, reviewerUserId);
  assert.equal(events.rows[0].before_snapshot.reviewStatus, "unreviewed");
  assert.match(events.rows[0].before_snapshot.originalText, /1 18%/);
  assert.equal(events.rows[0].before_snapshot.verifiedText, null);
  assert.equal(events.rows[0].after_snapshot.reviewStatus, "approved");
  assert.match(events.rows[0].after_snapshot.verifiedText ?? "", /118%/);
  assert.match(events.rows[0].after_snapshot.originalText, /1 18%/);
});

test("R115：审核事件只能追加不能更新或删除", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R115");
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R115",
  );
  await database.query(
    `
      update knowledge_chunks
      set
        review_status = 'rejected',
        reviewed_by_user_id = $2,
        reviewed_at = now(),
        review_notes = '无法从当前官方页面确认该候选。'
      where id = $1
    `,
    [knowledgeChunkId, reviewerUserId],
  );

  await assert.rejects(
    database.query(
      `
        update knowledge_chunk_review_events
        set review_notes = '篡改后的理由'
        where knowledge_chunk_id = $1
      `,
      [knowledgeChunkId],
    ),
    /immutable/i,
  );
  await assert.rejects(
    database.query(
      `delete from knowledge_chunk_review_events where knowledge_chunk_id = $1`,
      [knowledgeChunkId],
    ),
    /immutable/i,
  );
});

test("R116：有对应产品资格的审核人可以一键确认AI候选", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R116");
  await database.query(
    `
      insert into product_family_knowledge_reviewers (
        product_family_id,
        user_id
      )
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R116",
  );

  const reviewed = await reviewKnowledgeChunk(database, {
    knowledgeChunkId,
    authenticatedReviewerUserId: reviewerUserId,
    decision: "approve",
  });

  assert.equal(reviewed.reviewStatus, "approved");
  const persisted = await database.query<{
    original_text: string;
    verified_text: string;
    review_status: string;
    review_notes: string;
    event_count: number;
  }>(
    `
      select
        knowledge_chunk.original_text,
        knowledge_chunk.verified_text,
        knowledge_chunk.review_status,
        knowledge_chunk.review_notes,
        count(review_event.id)::integer as event_count
      from knowledge_chunks as knowledge_chunk
      left join knowledge_chunk_review_events as review_event
        on review_event.knowledge_chunk_id = knowledge_chunk.id
      where knowledge_chunk.id = $1
      group by knowledge_chunk.id
    `,
    [knowledgeChunkId],
  );
  assert.equal(persisted.rows[0].verified_text, persisted.rows[0].original_text);
  assert.equal(persisted.rows[0].review_status, "approved");
  assert.equal(persisted.rows[0].review_notes, "对照官方原文确认，无修改。");
  assert.equal(persisted.rows[0].event_count, 1);
});

test("R117：人工修改AI建议时必须保留修改前后值和修改理由", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R117");
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R117",
  );

  await reviewKnowledgeChunk(database, {
    knowledgeChunkId,
    authenticatedReviewerUserId: reviewerUserId,
    decision: "approve",
    corrections: {
      verifiedText:
        "变频器热状态。100% = 额定热状态，118% =“OHF”阈值。R117",
      usagePolicy: "engineer_only",
    },
    reviewNotes: "对照PDF核正118%，并按产品审核规则限制为工程师专用。",
  });

  const event = await database.query<{
    review_notes: string;
    before_snapshot: { verifiedText: string | null; usagePolicy: string };
    after_snapshot: { verifiedText: string; usagePolicy: string };
  }>(
    `
      select review_notes, before_snapshot, after_snapshot
      from knowledge_chunk_review_events
      where knowledge_chunk_id = $1
    `,
    [knowledgeChunkId],
  );
  assert.equal(event.rows[0].before_snapshot.verifiedText, null);
  assert.equal(event.rows[0].before_snapshot.usagePolicy, "reference_only");
  assert.match(event.rows[0].after_snapshot.verifiedText, /118%/);
  assert.equal(event.rows[0].after_snapshot.usagePolicy, "engineer_only");
  assert.match(event.rows[0].review_notes, /核正118%/);
});

test("R118：驳回候选必须填写理由且不能生成核对正文", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R118");
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R118",
  );

  await reviewKnowledgeChunk(database, {
    knowledgeChunkId,
    authenticatedReviewerUserId: reviewerUserId,
    decision: "reject",
    reviewNotes: "当前摘录不足以支持该知识结论。",
  });

  const result = await database.query<{
    review_status: string;
    verified_text: string | null;
    decision: string;
  }>(
    `
      select
        knowledge_chunk.review_status,
        knowledge_chunk.verified_text,
        review_event.decision
      from knowledge_chunks as knowledge_chunk
      join knowledge_chunk_review_events as review_event
        on review_event.knowledge_chunk_id = knowledge_chunk.id
      where knowledge_chunk.id = $1
    `,
    [knowledgeChunkId],
  );
  assert.deepEqual(result.rows[0], {
    review_status: "rejected",
    verified_text: null,
    decision: "rejected",
  });
});

test("R119：没有对应产品审核资格的用户不能审核候选", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const unauthorizedUserId = await createUser(database, "R119");
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R119",
  );

  await assert.rejects(
    reviewKnowledgeChunk(database, {
      knowledgeChunkId,
      authenticatedReviewerUserId: unauthorizedUserId,
      decision: "approve",
    }),
    /not an active reviewer for this product family/i,
  );
  const status = await database.query<{
    review_status: string;
    event_count: number;
  }>(
    `
      select
        knowledge_chunk.review_status,
        count(review_event.id)::integer as event_count
      from knowledge_chunks as knowledge_chunk
      left join knowledge_chunk_review_events as review_event
        on review_event.knowledge_chunk_id = knowledge_chunk.id
      where knowledge_chunk.id = $1
      group by knowledge_chunk.id
    `,
    [knowledgeChunkId],
  );
  assert.deepEqual(status.rows[0], {
    review_status: "unreviewed",
    event_count: 0,
  });
});

test("R120：另一个产品族的审核资格不能越权审核ATV320知识", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R120");
  const otherProduct = await database.query<{ id: number }>(`
    insert into product_families (
      manufacturer_name,
      family_code,
      display_name
    )
    values ('Schneider Electric', 'M340-R120', 'Modicon M340 R120')
    returning id
  `);
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [otherProduct.rows[0].id, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R120",
  );

  await assert.rejects(
    reviewKnowledgeChunk(database, {
      knowledgeChunkId,
      authenticatedReviewerUserId: reviewerUserId,
      decision: "approve",
    }),
    /not an active reviewer for this product family/i,
  );
});

test("R121：已完成审核的候选不能被第二次审核覆盖", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R121");
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R121",
  );
  await reviewKnowledgeChunk(database, {
    knowledgeChunkId,
    authenticatedReviewerUserId: reviewerUserId,
    decision: "approve",
  });

  await assert.rejects(
    reviewKnowledgeChunk(database, {
      knowledgeChunkId,
      authenticatedReviewerUserId: reviewerUserId,
      decision: "reject",
      reviewNotes: "试图覆盖第一次审核。",
    }),
    /already been reviewed/i,
  );
  const eventCount = await database.query<{ count: number }>(
    `
      select count(*)::integer as count
      from knowledge_chunk_review_events
      where knowledge_chunk_id = $1
    `,
    [knowledgeChunkId],
  );
  assert.equal(eventCount.rows[0].count, 1);
});

test("R122：修改AI建议却不填写理由时整笔审核必须拒绝", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R122");
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R122",
  );

  await assert.rejects(
    reviewKnowledgeChunk(database, {
      knowledgeChunkId,
      authenticatedReviewerUserId: reviewerUserId,
      decision: "approve",
      corrections: { usagePolicy: "engineer_only" },
    }),
    /review notes are required when correcting/i,
  );
});

test("R123：矛盾的审核结果被数据库拒绝时状态和审核事件一起回滚", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const reviewerUserId = await createUser(database, "R123");
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [fixture.productFamilyId, reviewerUserId],
  );
  const knowledgeChunkId = await createCandidate(
    database,
    fixture.sourceVersionId,
    "R123",
  );

  await assert.rejects(
    reviewKnowledgeChunk(database, {
      knowledgeChunkId,
      authenticatedReviewerUserId: reviewerUserId,
      decision: "approve",
      corrections: {
        sourceSeverity: "warning",
        usagePolicy: "low_risk_guidance",
      },
      reviewNotes: "故意提交矛盾组合以验证数据库底线。",
    }),
    /check constraint/i,
  );
  const persisted = await database.query<{
    review_status: string;
    event_count: number;
  }>(
    `
      select
        knowledge_chunk.review_status,
        count(review_event.id)::integer as event_count
      from knowledge_chunks as knowledge_chunk
      left join knowledge_chunk_review_events as review_event
        on review_event.knowledge_chunk_id = knowledge_chunk.id
      where knowledge_chunk.id = $1
      group by knowledge_chunk.id
    `,
    [knowledgeChunkId],
  );
  assert.deepEqual(persisted.rows[0], {
    review_status: "unreviewed",
    event_count: 0,
  });
});
