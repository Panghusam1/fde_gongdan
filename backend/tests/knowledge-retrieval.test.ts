import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { createKnowledgeChunkCandidate } from "../src/knowledge/create-knowledge-chunk-candidate.ts";
import { reviewKnowledgeChunk } from "../src/knowledge/review-knowledge-chunk.ts";
import { indexApprovedKnowledgeChunk } from "../src/retrieval/index-approved-knowledge-chunk.ts";

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

async function createCandidate(
  database: PGlite,
  input: {
    sourceVersionId: number;
    key: string;
    text: string;
    faultCode?: string;
    sectionTitle: string;
  },
): Promise<number> {
  const page = await database.query<{ id: number }>(
    `
      insert into document_pages (source_version_id, pdf_page_number)
      values ($1, $2)
      returning id
    `,
    [input.sourceVersionId, 100 + Number(input.key.replace(/\D/g, ""))],
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
      values ($1, 'embedded_text', 'test-extractor', '1.0.0', 'extracted', $2, $3)
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
    contentKind: "fault_definition",
    sourceSeverity: "information",
    usagePolicy: "reference_only",
    faultCode: input.faultCode,
    sectionTitle: input.sectionTitle,
    chunkingMethod: "manual_selection",
    chunkerName: "retrieval-test",
    chunkerVersion: "1.0.0",
    sources: [{ pageExtractionId: extraction.rows[0].id, excerpt: input.text }],
  });
  return candidate.knowledgeChunkId;
}

async function approveCandidate(
  database: PGlite,
  productFamilyId: number,
  knowledgeChunkId: number,
  key: string,
): Promise<void> {
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ($1, $2)
      returning id
    `,
    [`idp|retrieval-${key}`, `检索测试审核人-${key}`],
  );
  await database.query(
    `
      insert into product_family_knowledge_reviewers (product_family_id, user_id)
      values ($1, $2)
    `,
    [productFamilyId, reviewer.rows[0].id],
  );
  await reviewKnowledgeChunk(database, {
    knowledgeChunkId,
    authenticatedReviewerUserId: reviewer.rows[0].id,
    decision: "approve",
  });
}

function vectorLiteral(dimensions: number, activeIndex = 0): string {
  return `[${Array.from(
    { length: dimensions },
    (_, index) => (index === activeIndex ? 1 : 0),
  ).join(",")}]`;
}

function createTestEmbedder(queryVector: number[]) {
  return {
    modelId: "test/multilingual-e5-small",
    modelRevision: "retrieval-test-revision",
    dimensions: 3,
    poolingMethod: "mean" as const,
    isNormalized: true as const,
    embedPassage: async (text: string): Promise<number[]> => {
      if (text.includes("设备过热")) return [1, 0, 0];
      if (text.includes("手动清除")) return [0, 1, 0];
      return [0, 0, 1];
    },
    embedQuery: async (): Promise<number[]> => queryVector,
  };
}

async function createIndexedCorpus(database: PGlite, key: string): Promise<{
  productFamilyId: number;
  definitionId: number;
  resetId: number;
  warningId: number;
}> {
  const fixture = await getAtv320Context(database);
  await database.query(
    `update source_versions set version_status = 'current' where id = $1`,
    [fixture.sourceVersionId],
  );
  const embedder = createTestEmbedder([1, 0, 0]);
  const definitionId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: `${key}1`,
    text: "OHF表示设备过热。",
    faultCode: "OHF",
    sectionTitle: "故障定义",
  });
  const resetId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: `${key}2`,
    text: "检测到的错误原因消失后，可以手动清除OHF。",
    faultCode: "OHF",
    sectionTitle: "故障复位",
  });
  const warningId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: `${key}3`,
    text: "危险：禁用OHF错误检测功能后将无法检测错误。",
    faultCode: "OHF",
    sectionTitle: "错误检测禁用",
  });
  for (const [index, knowledgeChunkId] of [
    definitionId,
    resetId,
    warningId,
  ].entries()) {
    await approveCandidate(
      database,
      fixture.productFamilyId,
      knowledgeChunkId,
      `${key}-${index}`,
    );
    await indexApprovedKnowledgeChunk(database, {
      knowledgeChunkId,
      embedder,
    });
  }
  return {
    productFamilyId: fixture.productFamilyId,
    definitionId,
    resetId,
    warningId,
  };
}

test("R124：旧的内联向量字段迁移为可容纳多模型的独立向量表", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const table = await database.query<{ exists: boolean }>(`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'knowledge_chunk_embeddings'
    ) as exists
  `);
  const oldColumns = await database.query<{ count: number }>(`
    select count(*)::integer as count
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'knowledge_chunks'
      and column_name in ('embedding', 'embedding_model', 'embedding_dimensions')
  `);

  assert.equal(table.rows[0].exists, true);
  assert.equal(oldColumns.rows[0].count, 0);
});

test("R125：待审核知识不能生成正式向量记录", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const knowledgeChunkId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: "125",
    text: "OHF表示设备过热。",
    faultCode: "OHF",
    sectionTitle: "故障定义",
  });

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_embeddings (
          knowledge_chunk_id,
          model_id,
          model_revision,
          pooling_method,
          is_normalized,
          input_prefix,
          input_text,
          input_text_sha256,
          embedding_dimensions,
          embedding
        )
        values ($1, $2, $3, 'mean', true, 'passage: ', $4, $5, 384, $6::vector)
      `,
      [
        knowledgeChunkId,
        "Xenova/multilingual-e5-small",
        "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
        "OHF表示设备过热。",
        createHash("sha256").update("OHF表示设备过热。").digest("hex"),
        vectorLiteral(384),
      ],
    ),
    /approved knowledge chunk/i,
  );
});

test("R126：正式向量必须对应核对正文并记录真实向量维度", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const text = "OHF表示设备过热。";
  const knowledgeChunkId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: "126",
    text,
    faultCode: "OHF",
    sectionTitle: "故障定义",
  });
  await approveCandidate(
    database,
    fixture.productFamilyId,
    knowledgeChunkId,
    "126",
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_embeddings (
          knowledge_chunk_id,
          model_id,
          model_revision,
          pooling_method,
          is_normalized,
          input_prefix,
          input_text,
          input_text_sha256,
          embedding_dimensions,
          embedding
        )
        values ($1, 'test/model', 'revision-1', 'mean', true, 'passage: ', $2, $3, 384, $4::vector)
      `,
      [
        knowledgeChunkId,
        "被模型改写过的文字",
        createHash("sha256").update("被模型改写过的文字").digest("hex"),
        vectorLiteral(384),
      ],
    ),
    /verified text/i,
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_embeddings (
          knowledge_chunk_id,
          model_id,
          model_revision,
          pooling_method,
          is_normalized,
          input_prefix,
          input_text,
          input_text_sha256,
          embedding_dimensions,
          embedding
        )
        values ($1, 'test/model', 'revision-1', 'mean', true, 'passage: ', $2, $3, 384, $4::vector)
      `,
      [
        knowledgeChunkId,
        text,
        createHash("sha256").update(text).digest("hex"),
        vectorLiteral(3),
      ],
    ),
    /check constraint/i,
  );
});

test("R127：关键词词项必须记录分析器版本且只能来自已审核知识", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const knowledgeChunkId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: "127",
    text: "OHF表示设备过热。",
    faultCode: "OHF",
    sectionTitle: "故障定义",
  });

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_search_terms (
          knowledge_chunk_id,
          analyzer_name,
          analyzer_version,
          term_kind,
          term
        )
        values ($1, 'fde-cjk-bigram', '1.0.0', 'fault_code', 'ohf')
      `,
      [knowledgeChunkId],
    ),
    /approved knowledge chunk/i,
  );

  await approveCandidate(
    database,
    fixture.productFamilyId,
    knowledgeChunkId,
    "127",
  );
  await database.query(
    `
      insert into knowledge_chunk_search_terms (
        knowledge_chunk_id,
        analyzer_name,
        analyzer_version,
        term_kind,
        term
      )
      values ($1, 'fde-cjk-bigram', '1.0.0', 'fault_code', 'ohf')
    `,
    [knowledgeChunkId],
  );
  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_search_terms (
          knowledge_chunk_id,
          analyzer_name,
          analyzer_version,
          term_kind,
          term
        )
        values ($1, 'fde-cjk-bigram', '1.0.0', 'fault_code', 'ohf')
      `,
      [knowledgeChunkId],
    ),
    /unique/i,
  );
});

test("R128：统一建库服务为已审核正文生成版本化词项和向量", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await getAtv320Context(database);
  const text = "OHF表示设备过热。";
  const knowledgeChunkId = await createCandidate(database, {
    sourceVersionId: fixture.sourceVersionId,
    key: "128",
    text,
    faultCode: "OHF",
    sectionTitle: "故障定义",
  });
  await approveCandidate(
    database,
    fixture.productFamilyId,
    knowledgeChunkId,
    "128",
  );

  const indexed = await indexApprovedKnowledgeChunk(database, {
    knowledgeChunkId,
    embedder: {
      modelId: "test/e5-small",
      modelRevision: "revision-128",
      dimensions: 384,
      poolingMethod: "mean",
      isNormalized: true,
      embedPassage: async () =>
        Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)),
    },
  });

  assert.ok(indexed.termCount >= 4);
  const terms = await database.query<{ term_kind: string; term: string }>(
    `
      select term_kind, term
      from knowledge_chunk_search_terms
      where knowledge_chunk_id = $1
      order by term_kind, term
    `,
    [knowledgeChunkId],
  );
  assert.ok(
    terms.rows.some(
      (term) => term.term_kind === "fault_code" && term.term === "ohf",
    ),
  );
  assert.ok(terms.rows.some((term) => term.term === "设备"));
  assert.ok(terms.rows.some((term) => term.term === "过热"));

  const embedding = await database.query<{
    model_id: string;
    model_revision: string;
    pooling_method: string;
    is_normalized: boolean;
    input_prefix: string;
    input_text: string;
    input_text_sha256: string;
    embedding_dimensions: number;
  }>(
    `
      select
        model_id,
        model_revision,
        pooling_method,
        is_normalized,
        input_prefix,
        input_text,
        input_text_sha256,
        embedding_dimensions
      from knowledge_chunk_embeddings
      where knowledge_chunk_id = $1
    `,
    [knowledgeChunkId],
  );
  assert.deepEqual(embedding.rows[0], {
    model_id: "test/e5-small",
    model_revision: "revision-128",
    pooling_method: "mean",
    is_normalized: true,
    input_prefix: "passage: ",
    input_text: text,
    input_text_sha256: createHash("sha256").update(text).digest("hex"),
    embedding_dimensions: 384,
  });
});

test("R129：关键词检索优先命中故障码和中文词项都吻合的片段", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const corpus = await createIndexedCorpus(database, "129");

  let searchApprovedKnowledge: Function;
  try {
    ({ searchApprovedKnowledge } = await import(
      "../src/retrieval/search-approved-knowledge.ts"
    ));
  } catch {
    assert.fail("知识检索服务尚未实现");
  }
  const result = await searchApprovedKnowledge(database, {
    productFamilyId: corpus.productFamilyId,
    queryText: "OHF设备过热是什么意思",
    embedder: createTestEmbedder([1, 0, 0]),
    limit: 3,
  });

  assert.equal(result.keyword[0].knowledgeChunkId, corpus.definitionId);
  assert.ok(result.keyword[0].keywordScore > 0);
});

test("R130：向量检索能用口语描述命中语义相近的正式知识", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const corpus = await createIndexedCorpus(database, "130");
  const { searchApprovedKnowledge } = await import(
    "../src/retrieval/search-approved-knowledge.ts"
  );

  const result = await searchApprovedKnowledge(database, {
    productFamilyId: corpus.productFamilyId,
    queryText: "机器外壳摸起来很烫",
    embedder: createTestEmbedder([1, 0, 0]),
    limit: 3,
  });

  assert.equal(result.vector[0].knowledgeChunkId, corpus.definitionId);
  assert.equal(result.vector[0].vectorSimilarity, 1);
});

test("R131：混合检索用倒数排名融合并说明每条结果来自哪些路线", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const corpus = await createIndexedCorpus(database, "131");
  const { searchApprovedKnowledge } = await import(
    "../src/retrieval/search-approved-knowledge.ts"
  );

  const result = await searchApprovedKnowledge(database, {
    productFamilyId: corpus.productFamilyId,
    queryText: "OHF故障原因消失后怎么手动处理",
    embedder: createTestEmbedder([0, 1, 0]),
    limit: 3,
  });

  assert.equal(result.hybrid[0].knowledgeChunkId, corpus.resetId);
  assert.deepEqual(result.hybrid[0].matchedBy, ["keyword", "vector"]);
  assert.ok(result.hybrid[0].fusionScore > 0);
});

test("R132：检索必须先按产品族过滤且不能泄漏其他产品知识", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  await createIndexedCorpus(database, "132");
  const { searchApprovedKnowledge } = await import(
    "../src/retrieval/search-approved-knowledge.ts"
  );

  const result = await searchApprovedKnowledge(database, {
    productFamilyId: 999999,
    queryText: "OHF设备过热是什么意思",
    embedder: createTestEmbedder([1, 0, 0]),
    limit: 3,
  });

  assert.deepEqual(result.keyword, []);
  assert.deepEqual(result.vector, []);
  assert.deepEqual(result.hybrid, []);
});
