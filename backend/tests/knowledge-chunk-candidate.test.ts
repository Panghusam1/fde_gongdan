import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { createKnowledgeChunkCandidate } from "../src/knowledge/create-knowledge-chunk-candidate.ts";
import { importDocumentPages } from "../src/knowledge/import-document-pages.ts";

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

async function getSourceVersionId(database: PGlite): Promise<number> {
  const result = await database.query<{ id: number }>(`
    select source_version.id
    from source_versions as source_version
    join source_documents as source_document
      on source_document.id = source_version.source_document_id
    where lower(btrim(source_document.document_reference)) = 'nve41300'
      and lower(btrim(source_version.version_label)) = '05'
      and lower(btrim(source_version.language_code)) = 'zh-cn'
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0].id;
}

async function createPageExtraction(
  database: PGlite,
  sourceVersionId: number,
  pdfPageNumber: number,
  extractedText: string,
): Promise<number> {
  const page = await database.query<{ id: number }>(
    `
      insert into document_pages (source_version_id, pdf_page_number)
      values ($1, $2)
      returning id
    `,
    [sourceVersionId, pdfPageNumber],
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
  return extraction.rows[0].id;
}

test("R106：创建服务从真实页面摘录推导机器原文和精确范围", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);
  const pageText = "错误代码表\n• [设备过热] OHF: 设备过热\n下一条故障";
  const excerpt = "• [设备过热] OHF: 设备过热";
  const pageExtractionId = await createPageExtraction(
    database,
    sourceVersionId,
    72,
    pageText,
  );

  const created = await createKnowledgeChunkCandidate(database, {
    sourceVersionId,
    contentKind: "fault_definition",
    sourceSeverity: "information",
    usagePolicy: "reference_only",
    faultCode: "OHF",
    sectionTitle: "检测到的错误代码",
    chunkingMethod: "ai_proposed",
    chunkerName: "coordinator-agent",
    chunkerVersion: "1.0.0",
    sources: [{ pageExtractionId, excerpt }],
  });

  assert.equal(created.originalText, excerpt);
  assert.equal(created.reviewStatus, "unreviewed");
  const persisted = await database.query<{
    original_text: string;
    review_status: string;
    chunking_method: string;
    start_character: number;
    end_character: number;
    source_excerpt: string;
  }>(
    `
      select
        knowledge_chunk.original_text,
        knowledge_chunk.review_status,
        knowledge_chunk.chunking_method,
        chunk_source.start_character,
        chunk_source.end_character,
        chunk_source.source_excerpt
      from knowledge_chunks as knowledge_chunk
      join knowledge_chunk_sources as chunk_source
        on chunk_source.knowledge_chunk_id = knowledge_chunk.id
      where knowledge_chunk.id = $1
    `,
    [created.knowledgeChunkId],
  );
  const expectedStart = Array.from(pageText).indexOf("•") + 1;
  assert.deepEqual(persisted.rows[0], {
    original_text: excerpt,
    review_status: "unreviewed",
    chunking_method: "ai_proposed",
    start_character: expectedStart,
    end_character: expectedStart + Array.from(excerpt).length,
    source_excerpt: excerpt,
  });
});

test("R107：候选摘录不在指定页面时整笔创建必须回滚", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);
  const pageExtractionId = await createPageExtraction(
    database,
    sourceVersionId,
    72,
    "• [设备过热] OHF: 设备过热",
  );

  await assert.rejects(
    createKnowledgeChunkCandidate(database, {
      sourceVersionId,
      contentKind: "fault_definition",
      sourceSeverity: "information",
      usagePolicy: "reference_only",
      faultCode: "OHF",
      chunkingMethod: "ai_proposed",
      chunkerName: "coordinator-agent",
      chunkerVersion: "1.0.0",
      sources: [
        {
          pageExtractionId,
          excerpt: "OHF说明冷却风扇已经损坏",
        },
      ],
    }),
    /proposed excerpt was not found in page extraction/i,
  );
  const chunkCount = await database.query<{ count: number }>(
    `select count(*)::integer as count from knowledge_chunks`,
  );
  assert.equal(chunkCount.rows[0].count, 0);
});

test("R108：同一句在页面出现多次时必须补充上下文而不能猜位置", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);
  const pageExtractionId = await createPageExtraction(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热\n其他说明\nOHF：设备过热",
  );

  await assert.rejects(
    createKnowledgeChunkCandidate(database, {
      sourceVersionId,
      contentKind: "fault_definition",
      sourceSeverity: "information",
      usagePolicy: "reference_only",
      faultCode: "OHF",
      chunkingMethod: "ai_proposed",
      chunkerName: "coordinator-agent",
      chunkerVersion: "1.0.0",
      sources: [{ pageExtractionId, excerpt: "OHF：设备过热" }],
    }),
    /proposed excerpt occurs more than once/i,
  );
});

test("R109：跨页候选片段按提交顺序拼接全部来源并连续编号", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);
  const definition = "• [设备过热] OHF: 设备过热";
  const resetCondition = "如果导致错误的原因已经消失，可手动复位检测到的错误。";
  const page72ExtractionId = await createPageExtraction(
    database,
    sourceVersionId,
    72,
    `错误定义\n${definition}`,
  );
  const page310ExtractionId = await createPageExtraction(
    database,
    sourceVersionId,
    310,
    `复位说明\n${resetCondition}`,
  );

  const created = await createKnowledgeChunkCandidate(database, {
    sourceVersionId,
    contentKind: "diagnostic_context",
    sourceSeverity: "information",
    usagePolicy: "reference_only",
    faultCode: "OHF",
    chunkingMethod: "manual_selection",
    chunkerName: "review-console",
    chunkerVersion: "1.0.0",
    sources: [
      { pageExtractionId: page72ExtractionId, excerpt: definition },
      { pageExtractionId: page310ExtractionId, excerpt: resetCondition },
    ],
  });

  assert.equal(created.originalText, `${definition}\n${resetCondition}`);
  assert.equal(created.sourceCount, 2);
  const relations = await database.query<{
    source_order: number;
    source_excerpt: string;
  }>(
    `
      select source_order, source_excerpt
      from knowledge_chunk_sources
      where knowledge_chunk_id = $1
      order by source_order
    `,
    [created.knowledgeChunkId],
  );
  assert.deepEqual(relations.rows, [
    { source_order: 1, source_excerpt: definition },
    { source_order: 2, source_excerpt: resetCondition },
  ]);
});

test("R110：没有任何页面原文来源时不能创建候选片段", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);

  await assert.rejects(
    createKnowledgeChunkCandidate(database, {
      sourceVersionId,
      contentKind: "fault_definition",
      sourceSeverity: "information",
      usagePolicy: "reference_only",
      chunkingMethod: "ai_proposed",
      chunkerName: "coordinator-agent",
      chunkerVersion: "1.0.0",
      sources: [],
    }),
    /at least one page excerpt is required/i,
  );
});

test("R111：同一页中两段不相邻的原文可以共同组成一个候选片段", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);
  const condition =
    "如果检测到的错误的原因已消失，则当分配的输入或位更改为 1 时，可手动清除检测到的错误。";
  const supportedFaults = "可以手动清除检测到的以下错误：OBF、OHF、OLF。";
  const pageExtractionId = await createPageExtraction(
    database,
    sourceVersionId,
    310,
    `${condition}\n图形终端说明\n${supportedFaults}`,
  );

  const created = await createKnowledgeChunkCandidate(database, {
    sourceVersionId,
    contentKind: "reset_condition",
    sourceSeverity: "information",
    usagePolicy: "reference_only",
    faultCode: "OHF",
    chunkingMethod: "manual_selection",
    chunkerName: "review-console",
    chunkerVersion: "1.0.0",
    sources: [
      { pageExtractionId, excerpt: condition },
      { pageExtractionId, excerpt: supportedFaults },
    ],
  });

  assert.equal(created.sourceCount, 2);
  assert.equal(created.originalText, `${condition}\n${supportedFaults}`);
});

test("R112：六组OHF真实候选资料都能从官方手册原文创建且保持待审核", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await getSourceVersionId(database);
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await importDocumentPages(database, { sourceVersionId, artifact });

  const createdIds: number[] = [];
  for (const candidate of manifest.candidates) {
    const proposedSources: Array<{
      pageExtractionId: number;
      excerpt: string;
    }> = [];
    for (const proposedSource of candidate.sources) {
      const extraction = await database.query<{ id: number }>(
        `
          select page_extraction.id
          from page_extractions as page_extraction
          join document_pages as document_page
            on document_page.id = page_extraction.document_page_id
          where document_page.source_version_id = $1
            and document_page.pdf_page_number = $2
            and lower(btrim(page_extraction.extractor_name)) = lower(btrim($3))
            and lower(btrim(page_extraction.extractor_version)) = lower(btrim($4))
        `,
        [
          sourceVersionId,
          proposedSource.pdf_page_number,
          manifest.extractor_name,
          manifest.extractor_version,
        ],
      );
      assert.equal(extraction.rows.length, 1);
      proposedSources.push({
        pageExtractionId: extraction.rows[0].id,
        excerpt: proposedSource.excerpt,
      });
    }

    const created = await createKnowledgeChunkCandidate(database, {
      sourceVersionId,
      contentKind: candidate.content_kind,
      sourceSeverity: candidate.source_severity,
      usagePolicy: candidate.usage_policy,
      faultCode: candidate.fault_code,
      sectionTitle: candidate.section_title,
      chunkingMethod: manifest.chunking_method,
      chunkerName: manifest.chunker_name,
      chunkerVersion: manifest.chunker_version,
      sources: proposedSources,
    });
    createdIds.push(created.knowledgeChunkId);
  }

  assert.equal(createdIds.length, 6);
  const persisted = await database.query<{
    chunk_count: number;
    approved_count: number;
    source_count: number;
  }>(`
    select
      count(distinct knowledge_chunk.id)::integer as chunk_count,
      count(distinct knowledge_chunk.id)
        filter (where knowledge_chunk.review_status = 'approved')::integer
        as approved_count,
      count(chunk_source.id)::integer as source_count
    from knowledge_chunks as knowledge_chunk
    left join knowledge_chunk_sources as chunk_source
      on chunk_source.knowledge_chunk_id = knowledge_chunk.id
  `);
  assert.deepEqual(persisted.rows[0], {
    chunk_count: 6,
    approved_count: 0,
    source_count: 8,
  });
});
