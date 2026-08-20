import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

async function openDatabaseThroughMigration(
  lastMigrationFile?: string,
): Promise<PGlite> {
  const database = await PGlite.create({
    dataDir: "memory://",
    extensions: { vector },
  });

  const migrationsDirectory = new URL("../database/migrations/", import.meta.url);

  let migrationFiles: string[] = [];
  try {
    migrationFiles = (await readdir(migrationsDirectory))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();
  } catch {
    assert.fail("数据库迁移尚未实现：database/migrations 目录不存在");
  }

  assert.ok(migrationFiles.length > 0, "数据库迁移尚未实现：没有 SQL 迁移文件");

  for (const migrationFile of migrationFiles) {
    if (lastMigrationFile && migrationFile > lastMigrationFile) {
      break;
    }

    const sql = await readFile(new URL(migrationFile, migrationsDirectory), "utf8");
    await database.exec(sql);
  }

  return database;
}

async function openMigratedDatabase(): Promise<PGlite> {
  return openDatabaseThroughMigration();
}

async function assertTableExists(database: PGlite, tableName: string): Promise<void> {
  const result = await database.query<{ table_exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
      ) as table_exists
    `,
    [tableName],
  );

  assert.equal(
    result.rows[0]?.table_exists,
    true,
    `数据库迁移尚未创建 ${tableName} 表`,
  );
}

async function assertColumnExists(
  database: PGlite,
  tableName: string,
  columnName: string,
): Promise<void> {
  const result = await database.query<{ column_exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = $2
      ) as column_exists
    `,
    [tableName, columnName],
  );

  assert.equal(
    result.rows[0]?.column_exists,
    true,
    `数据库迁移尚未创建 ${tableName}.${columnName} 字段`,
  );
}

async function createFactoryAndMembership(
  database: PGlite,
  key: string,
  roleCode = "operator",
): Promise<{ factoryId: number; userId: number; membershipId: number }> {
  const factory = await database.query<{ id: number }>(
    `
      insert into factories (factory_code, name, is_demo)
      values ($1, $2, true)
      returning id
    `,
    [`FAC-${key}`, `测试厂区-${key}`],
  );
  const user = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ($1, $2)
      returning id
    `,
    [`idp|${key}`, `测试用户-${key}`],
  );
  const membership = await database.query<{ id: number }>(
    `
      insert into factory_memberships (factory_id, user_id, role_code)
      values ($1, $2, $3)
      returning id
    `,
    [factory.rows[0].id, user.rows[0].id, roleCode],
  );

  return {
    factoryId: factory.rows[0].id,
    userId: user.rows[0].id,
    membershipId: membership.rows[0].id,
  };
}

async function createEquipmentForFactory(
  database: PGlite,
  factoryId: number,
  key: string,
): Promise<number> {
  const productFamily = await database.query<{ id: number }>(
    `
      insert into product_families (
        manufacturer_name,
        family_code,
        display_name
      )
      values ('Schneider Electric', $1, $2)
      returning id
    `,
    [`ATV320-${key}`, `Altivar Machine ATV320 ${key}`],
  );
  const equipmentModel = await database.query<{ id: number }>(
    `
      insert into equipment_models (
        product_family_id,
        model_code,
        display_name
      )
      values ($1, $2, $3)
      returning id
    `,
    [
      productFamily.rows[0].id,
      `ATV320U15N4C-${key}`,
      `ATV320 测试型号 ${key}`,
    ],
  );
  const equipment = await database.query<{ id: number }>(
    `
      insert into equipment (
        factory_id,
        asset_code,
        equipment_model_id,
        is_demo
      )
      values ($1, $2, $3, true)
      returning id
    `,
    [factoryId, `VFD-${key}`, equipmentModel.rows[0].id],
  );

  return equipment.rows[0].id;
}

async function createWorkOrderPrerequisites(
  database: PGlite,
  key: string,
): Promise<{
  factoryId: number;
  userId: number;
  membershipId: number;
  equipmentId: number;
}> {
  const actor = await createFactoryAndMembership(database, key);
  const equipmentId = await createEquipmentForFactory(
    database,
    actor.factoryId,
    key,
  );

  return { ...actor, equipmentId };
}

async function insertDraftWorkOrder(
  database: PGlite,
  fixture: { factoryId: number; membershipId: number; equipmentId: number },
  workOrderNo: string,
): Promise<number> {
  const workOrder = await database.query<{ id: number }>(
    `
      insert into work_orders (
        work_order_no,
        factory_id,
        equipment_id,
        created_by_membership_id,
        fault_code,
        status,
        is_demo
      )
      values ($1, $2, $3, $4, 'OHF', 'draft', true)
      returning id
    `,
    [
      workOrderNo,
      fixture.factoryId,
      fixture.equipmentId,
      fixture.membershipId,
    ],
  );

  return workOrder.rows[0].id;
}

async function createCanonicalSourceDocument(
  database: PGlite,
  key: string,
): Promise<{ productFamilyId: number; sourceDocumentId: number }> {
  const productFamily = await database.query<{ id: number }>(
    `
      insert into product_families (
        manufacturer_name,
        family_code,
        display_name
      )
      values ('Schneider Electric', $1, $2)
      returning id
    `,
    [`ATV320-${key}`, `Altivar Machine ATV320 ${key}`],
  );
  const sourceDocument = await database.query<{ id: number }>(
    `
      insert into source_documents (
        publisher,
        title,
        document_reference,
        product_family_id,
        source_type,
        official_url
      )
      values (
        'Schneider Electric',
        $1,
        $2,
        $3,
        'official_manual',
        $4
      )
      returning id
    `,
    [
      `ATV320 编程手册 ${key}`,
      `NVE41300-${key}`,
      productFamily.rows[0].id,
      `https://www.se.com/download/document/NVE41300-${key}/`,
    ],
  );

  return {
    productFamilyId: productFamily.rows[0].id,
    sourceDocumentId: sourceDocument.rows[0].id,
  };
}

async function seedOfficialSourceVersion(database: PGlite): Promise<number> {
  const seedSql = await readFile(
    new URL("../database/seeds/001_atv320_nve41300.sql", import.meta.url),
    "utf8",
  );
  await database.exec(seedSql);

  const sourceVersion = await database.query<{ id: number }>(`
    select source_version.id
    from source_versions as source_version
    join source_documents as source_document
      on source_document.id = source_version.source_document_id
    where lower(btrim(source_document.publisher)) = 'schneider electric'
      and lower(btrim(source_document.document_reference)) = 'nve41300'
      and lower(btrim(source_version.version_label)) = '05'
      and lower(btrim(source_version.language_code)) = 'zh-cn'
  `);
  assert.equal(sourceVersion.rows.length, 1);

  return sourceVersion.rows[0].id;
}

async function createAlternateSourceVersion(
  database: PGlite,
  existingSourceVersionId: number,
  versionLabel: string,
): Promise<number> {
  const sourceDocument = await database.query<{ source_document_id: number }>(
    `
      select source_document_id
      from source_versions
      where id = $1
    `,
    [existingSourceVersionId],
  );
  const sourceVersion = await database.query<{ id: number }>(
    `
      insert into source_versions (
        source_document_id,
        version_label,
        language_code,
        sha256,
        local_path
      )
      values ($1, $2, 'zh-CN', $3, $4)
      returning id
    `,
    [
      sourceDocument.rows[0].source_document_id,
      versionLabel,
      createHash("sha256").update(versionLabel).digest("hex"),
      `data/raw/official/schneider/atv320/NVE41300-${versionLabel}-zh-CN.pdf`,
    ],
  );

  return sourceVersion.rows[0].id;
}

async function createDocumentPage(
  database: PGlite,
  sourceVersionId: number,
  pdfPageNumber: number,
): Promise<number> {
  const documentPage = await database.query<{ id: number }>(
    `
      insert into document_pages (source_version_id, pdf_page_number)
      values ($1, $2)
      returning id
    `,
    [sourceVersionId, pdfPageNumber],
  );

  return documentPage.rows[0].id;
}

async function createExtractedPage(
  database: PGlite,
  sourceVersionId: number,
  pdfPageNumber: number,
  extractedText: string,
): Promise<{ documentPageId: number; pageExtractionId: number }> {
  const documentPageId = await createDocumentPage(
    database,
    sourceVersionId,
    pdfPageNumber,
  );
  const pageExtraction = await database.query<{ id: number }>(
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
      values (
        $1,
        'embedded_text',
        'pypdf',
        '6.10.0',
        'extracted',
        $2,
        $3
      )
      returning id
    `,
    [
      documentPageId,
      extractedText,
      createHash("sha256").update(extractedText).digest("hex"),
    ],
  );

  return {
    documentPageId,
    pageExtractionId: pageExtraction.rows[0].id,
  };
}

async function insertKnowledgeChunkSource(
  database: PGlite,
  input: {
    knowledgeChunkId: number;
    sourceVersionId: number;
    documentPageId: number;
    pageExtractionId: number;
    sourceOrder?: number;
    excerpt?: string;
  },
): Promise<number> {
  const extraction = await database.query<{ extracted_text: string | null }>(
    `select extracted_text from page_extractions where id = $1`,
    [input.pageExtractionId],
  );
  assert.equal(extraction.rows.length, 1, "测试来源必须引用已存在的提取结果");
  assert.notEqual(extraction.rows[0].extracted_text, null);
  const extractedText = extraction.rows[0].extracted_text as string;
  const excerpt = input.excerpt ?? extractedText;
  const extractedCharacters = Array.from(extractedText);
  const excerptCharacters = Array.from(excerpt);
  const startIndex = extractedCharacters.findIndex((_, index) =>
    excerptCharacters.every(
      (character, offset) => extractedCharacters[index + offset] === character,
    ),
  );
  assert.notEqual(startIndex, -1, "测试摘录必须存在于指定页面提取结果中");

  const relation = await database.query<{ id: number }>(
    `
      insert into knowledge_chunk_sources (
        knowledge_chunk_id,
        source_version_id,
        document_page_id,
        page_extraction_id,
        source_order,
        start_character,
        end_character,
        source_excerpt
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      returning id
    `,
    [
      input.knowledgeChunkId,
      input.sourceVersionId,
      input.documentPageId,
      input.pageExtractionId,
      input.sourceOrder ?? 1,
      startIndex + 1,
      startIndex + excerptCharacters.length + 1,
      excerpt,
    ],
  );

  return relation.rows[0].id;
}

async function createApprovedKnowledgeChunk(
  database: PGlite,
  sourceVersionId: number,
  key: string,
): Promise<{
  knowledgeChunkId: number;
  chunkSourceId: number;
  pageExtractionId: number;
}> {
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    `设备过热 OHF：设备过热 ${key}`,
  );
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ($1, $2)
      returning id
    `,
    [`idp|${key}-reviewer`, `资料审核员-${key}`],
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        $2,
        'fault_definition',
        'information',
        'reference_only',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId, `设备过热 OHF：设备过热 ${key}`],
  );
  const chunkSourceId = await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: source.documentPageId,
    pageExtractionId: source.pageExtractionId,
  });
  await database.query(
    `
      update knowledge_chunks
      set
        review_status = 'approved',
        verified_text = $2,
        reviewed_by_user_id = $3,
        reviewed_at = now(),
        review_notes = '对照官方PDF确认。'
      where id = $1
    `,
    [
      chunk.rows[0].id,
      `设备过热 OHF：设备过热 ${key}`,
      reviewer.rows[0].id,
    ],
  );

  return {
    knowledgeChunkId: chunk.rows[0].id,
    chunkSourceId,
    pageExtractionId: source.pageExtractionId,
  };
}

test("R02：数据库拒绝引用不存在设备的工单", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const actor = await createFactoryAndMembership(database, "R02");

  await assert.rejects(
    database.query(
      `
        insert into work_orders (
          work_order_no,
          factory_id,
          equipment_id,
          created_by_membership_id,
          fault_code,
          status,
          is_demo
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        "WO-TEST-001",
        actor.factoryId,
        999999,
        actor.membershipId,
        "OHF",
        "draft",
        true,
      ],
    ),
    /foreign key/i,
  );
});

test("R03：数据库拒绝把设备挂到错误厂区的工单", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const firstFactory = await createWorkOrderPrerequisites(database, "R03-A");
  const secondFactory = await createFactoryAndMembership(database, "R03-B");

  await assert.rejects(
    database.query(
      `
        insert into work_orders (
          work_order_no,
          factory_id,
          equipment_id,
          created_by_membership_id,
          fault_code,
          status,
          is_demo
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        "WO-TEST-002",
        secondFactory.factoryId,
        firstFactory.equipmentId,
        secondFactory.membershipId,
        "OHF",
        "draft",
        true,
      ],
    ),
    /foreign key/i,
  );
});

test("R04：数据库拒绝没有资料版本来源的知识片段", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          page_number
        )
        values ($1, $2, $3, $4)
      `,
      [999999, 1, "OHF 表示变频器过热。", 1],
    ),
    /foreign key/i,
  );
});

test("R05：数据库拒绝原文为空白的知识片段", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDocument = await createCanonicalSourceDocument(database, "R05");
  const sourceVersion = await database.query<{ id: number }>(
    `
      insert into source_versions (
        source_document_id,
        version_label,
        language_code,
        publisher_page_date,
        sha256,
        local_path
      )
      values ($1, '05', 'zh-CN', date '2025-07-04', $2, $3)
      returning id
    `,
    [
      sourceDocument.sourceDocumentId,
      "a".repeat(64),
      "data/raw/official/schneider/atv320/NVE41300-v05-zh-CN.pdf",
    ],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          page_number
        )
        values ($1, 1, '   ', 1)
      `,
      [sourceVersion.rows[0].id],
    ),
    /check constraint/i,
  );
});

test("R15：同一个外部身份不能创建两个系统用户", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "users");

  await database.query(
    `
      insert into users (external_subject, display_name)
      values ($1, $2)
    `,
    ["idp|operator-001", "现场操作员甲"],
  );

  await assert.rejects(
    database.query(
      `
        insert into users (external_subject, display_name)
        values ($1, $2)
      `,
      ["idp|operator-001", "重复账号"],
    ),
    /unique/i,
  );
});

test("R16：厂区成员关系不能引用不存在的用户或厂区", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "users");
  await assertTableExists(database, "factory_memberships");

  const factory = await database.query<{ id: number }>(`
    insert into factories (factory_code, name, is_demo)
    values ('SZ-01', '苏州一厂', true)
    returning id
  `);
  const user = await database.query<{ id: number }>(`
    insert into users (external_subject, display_name)
    values ('idp|operator-001', '现场操作员甲')
    returning id
  `);

  await assert.rejects(
    database.query(
      `
        insert into factory_memberships (factory_id, user_id, role_code)
        values ($1, $2, 'operator')
      `,
      [999999, user.rows[0].id],
    ),
    /foreign key/i,
  );

  await assert.rejects(
    database.query(
      `
        insert into factory_memberships (factory_id, user_id, role_code)
        values ($1, $2, 'operator')
      `,
      [factory.rows[0].id, 999999],
    ),
    /foreign key/i,
  );
});

test("R17：厂区成员角色只能使用允许值", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "users");
  await assertTableExists(database, "factory_memberships");

  const factory = await database.query<{ id: number }>(`
    insert into factories (factory_code, name, is_demo)
    values ('SZ-01', '苏州一厂', true)
    returning id
  `);
  const user = await database.query<{ id: number }>(`
    insert into users (external_subject, display_name)
    values ('idp|operator-001', '现场操作员甲')
    returning id
  `);

  await assert.rejects(
    database.query(
      `
        insert into factory_memberships (factory_id, user_id, role_code)
        values ($1, $2, 'visitor')
      `,
      [factory.rows[0].id, user.rows[0].id],
    ),
    /check constraint/i,
  );
});

test("R18：同一用户在同一厂区的同一角色不能重复授权", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "users");
  await assertTableExists(database, "factory_memberships");

  const factory = await database.query<{ id: number }>(`
    insert into factories (factory_code, name, is_demo)
    values ('SZ-01', '苏州一厂', true)
    returning id
  `);
  const user = await database.query<{ id: number }>(`
    insert into users (external_subject, display_name)
    values ('idp|operator-001', '现场操作员甲')
    returning id
  `);

  await database.query(
    `
      insert into factory_memberships (factory_id, user_id, role_code)
      values ($1, $2, 'operator')
    `,
    [factory.rows[0].id, user.rows[0].id],
  );

  await assert.rejects(
    database.query(
      `
        insert into factory_memberships (factory_id, user_id, role_code)
        values ($1, $2, 'operator')
      `,
      [factory.rows[0].id, user.rows[0].id],
    ),
    /unique/i,
  );
});

test("R19：同一厂商下的同一标准产品系列不能重复登记", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "product_families");

  await database.query(`
    insert into product_families (
      manufacturer_name,
      family_code,
      display_name
    )
    values ('Schneider Electric', 'ATV320', 'Altivar Machine ATV320')
  `);

  await assert.rejects(
    database.query(`
      insert into product_families (
        manufacturer_name,
        family_code,
        display_name
      )
      values ('schneider electric', 'atv320', '重复系列')
    `),
    /unique/i,
  );
});

test("R20：同一产品系列下的同一具体型号不能重复登记", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "product_families");
  await assertTableExists(database, "equipment_models");

  const productFamily = await database.query<{ id: number }>(`
    insert into product_families (
      manufacturer_name,
      family_code,
      display_name
    )
    values ('Schneider Electric', 'ATV320', 'Altivar Machine ATV320')
    returning id
  `);

  await database.query(
    `
      insert into equipment_models (
        product_family_id,
        model_code,
        display_name
      )
      values ($1, 'ATV320U15N4C', 'ATV320 1.5kW 380V')
    `,
    [productFamily.rows[0].id],
  );

  await assert.rejects(
    database.query(
      `
        insert into equipment_models (
          product_family_id,
          model_code,
          display_name
        )
        values ($1, 'atv320u15n4c', '重复型号')
      `,
      [productFamily.rows[0].id],
    ),
    /unique/i,
  );
});

test("R21：现场设备不能引用不存在的规范型号", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "equipment", "equipment_model_id");

  const factory = await database.query<{ id: number }>(`
    insert into factories (factory_code, name, is_demo)
    values ('SZ-01', '苏州一厂', true)
    returning id
  `);

  await assert.rejects(
    database.query(
      `
        insert into equipment (
          factory_id,
          asset_code,
          equipment_model_id,
          is_demo
        )
        values ($1, 'VFD-001', $2, true)
      `,
      [factory.rows[0].id, 999999],
    ),
    /foreign key/i,
  );
});

test("R22：新设备只填写规范型号也能建立完整型号关系", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "equipment", "equipment_model_id");

  const factory = await database.query<{ id: number }>(`
    insert into factories (factory_code, name, is_demo)
    values ('SZ-01', '苏州一厂', true)
    returning id
  `);
  const productFamily = await database.query<{ id: number }>(`
    insert into product_families (
      manufacturer_name,
      family_code,
      display_name
    )
    values ('Schneider Electric', 'ATV320', 'Altivar Machine ATV320')
    returning id
  `);
  const equipmentModel = await database.query<{ id: number }>(
    `
      insert into equipment_models (
        product_family_id,
        model_code,
        display_name
      )
      values ($1, 'ATV320U15N4C', 'ATV320 1.5kW 380V')
      returning id
    `,
    [productFamily.rows[0].id],
  );

  const equipment = await database.query<{ id: number }>(
    `
      insert into equipment (
        factory_id,
        asset_code,
        equipment_model_id,
        is_demo
      )
      values ($1, 'VFD-001', $2, true)
      returning id
    `,
    [factory.rows[0].id, equipmentModel.rows[0].id],
  );

  const canonicalModel = await database.query<{
    manufacturer_name: string;
    family_code: string;
    model_code: string;
  }>(
    `
      select
        pf.manufacturer_name,
        pf.family_code,
        em.model_code
      from equipment e
      join equipment_models em on em.id = e.equipment_model_id
      join product_families pf on pf.id = em.product_family_id
      where e.id = $1
    `,
    [equipment.rows[0].id],
  );

  assert.deepEqual(canonicalModel.rows[0], {
    manufacturer_name: "Schneider Electric",
    family_code: "ATV320",
    model_code: "ATV320U15N4C",
  });
});

test("R23：规范型号迁移会保留旧设备并自动回填关联", async (context) => {
  const database = await openDatabaseThroughMigration(
    "006_product_families_and_equipment_models.sql",
  );
  context.after(async () => database.close());

  const factory = await database.query<{ id: number }>(`
    insert into factories (factory_code, name, is_demo)
    values ('SZ-01', '苏州一厂', true)
    returning id
  `);

  const legacyEquipment = await database.query<{ id: number }>(
    `
      insert into equipment (
        factory_id,
        asset_code,
        manufacturer,
        product_family,
        model_code,
        is_demo
      )
      values ($1, 'VFD-LEGACY-001', 'Schneider Electric', 'ATV320', 'ATV320U15N4C', true)
      returning id
    `,
    [factory.rows[0].id],
  );

  const migrationsDirectory = new URL("../database/migrations/", import.meta.url);
  const migrationFiles = await readdir(migrationsDirectory);
  const migrationFile = "007_link_equipment_to_canonical_models.sql";

  assert.ok(
    migrationFiles.includes(migrationFile),
    `${migrationFile} 尚未实现`,
  );

  const migrationSql = await readFile(
    new URL(migrationFile, migrationsDirectory),
    "utf8",
  );
  await database.exec(migrationSql);

  const migratedEquipment = await database.query<{
    asset_code: string;
    raw_manufacturer: string;
    raw_product_family: string;
    raw_model_code: string;
    manufacturer_name: string;
    family_code: string;
    model_code: string;
  }>(
    `
      select
        e.asset_code,
        e.raw_manufacturer,
        e.raw_product_family,
        e.raw_model_code,
        pf.manufacturer_name,
        pf.family_code,
        em.model_code
      from equipment e
      join equipment_models em on em.id = e.equipment_model_id
      join product_families pf on pf.id = em.product_family_id
      where e.id = $1
    `,
    [legacyEquipment.rows[0].id],
  );

  assert.deepEqual(migratedEquipment.rows[0], {
    asset_code: "VFD-LEGACY-001",
    raw_manufacturer: "Schneider Electric",
    raw_product_family: "ATV320",
    raw_model_code: "ATV320U15N4C",
    manufacturer_name: "Schneider Electric",
    family_code: "ATV320",
    model_code: "ATV320U15N4C",
  });
});

test("R07：数据库拒绝未定义的工单状态", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "work_orders", "created_by_membership_id");
  const fixture = await createWorkOrderPrerequisites(database, "R07");

  await assert.rejects(
    database.query(
      `
        insert into work_orders (
          work_order_no,
          factory_id,
          equipment_id,
          created_by_membership_id,
          status,
          is_demo
        )
        values ('WO-R07', $1, $2, $3, 'teleported', true)
      `,
      [fixture.factoryId, fixture.equipmentId, fixture.membershipId],
    ),
    /check constraint/i,
  );
});

test("R24：其他厂区的成员不能成为工单创建人", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "work_orders", "created_by_membership_id");
  const workOrderFactory = await createWorkOrderPrerequisites(database, "R24-A");
  const otherFactory = await createFactoryAndMembership(database, "R24-B");

  await assert.rejects(
    database.query(
      `
        insert into work_orders (
          work_order_no,
          factory_id,
          equipment_id,
          created_by_membership_id,
          status,
          is_demo
        )
        values ('WO-R24', $1, $2, $3, 'draft', true)
      `,
      [
        workOrderFactory.factoryId,
        workOrderFactory.equipmentId,
        otherFactory.membershipId,
      ],
    ),
    /foreign key/i,
  );
});

test("R25：工单事件不能伪造为其他厂区的事件", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "work_order_events");
  const fixture = await createWorkOrderPrerequisites(database, "R25-A");
  const otherFactory = await createFactoryAndMembership(database, "R25-B");
  const workOrderId = await insertDraftWorkOrder(database, fixture, "WO-R25");

  await assert.rejects(
    database.query(
      `
        insert into work_order_events (
          work_order_id,
          factory_id,
          event_type,
          actor_kind,
          content,
          idempotency_key
        )
        values ($1, $2, 'observation_added', 'system', '伪造事件', 'R25-1')
      `,
      [workOrderId, otherFactory.factoryId],
    ),
    /foreign key/i,
  );
});

test("R26：用户事件缺少厂区成员身份时必须失败", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "work_order_events");
  const fixture = await createWorkOrderPrerequisites(database, "R26");
  const workOrderId = await insertDraftWorkOrder(database, fixture, "WO-R26");

  await assert.rejects(
    database.query(
      `
        insert into work_order_events (
          work_order_id,
          factory_id,
          event_type,
          actor_kind,
          content,
          idempotency_key
        )
        values ($1, $2, 'observation_added', 'user', '缺少人员身份', 'R26-1')
      `,
      [workOrderId, fixture.factoryId],
    ),
    /check constraint/i,
  );
});

test("R27：同一工单重复提交相同幂等键时只允许一条事件", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "work_order_events");
  const fixture = await createWorkOrderPrerequisites(database, "R27");
  const workOrderId = await insertDraftWorkOrder(database, fixture, "WO-R27");

  const insertEvent = () =>
    database.query(
      `
        insert into work_order_events (
          work_order_id,
          factory_id,
          event_type,
          actor_kind,
          actor_membership_id,
          content,
          idempotency_key
        )
        values ($1, $2, 'observation_added', 'user', $3, '现场观察', 'R27-1')
      `,
      [workOrderId, fixture.factoryId, fixture.membershipId],
    );

  await insertEvent();
  await assert.rejects(insertEvent(), /unique/i);
});

test("R28：已写入的工单事件不能更新或删除", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "work_order_events");
  const fixture = await createWorkOrderPrerequisites(database, "R28");
  const workOrderId = await insertDraftWorkOrder(database, fixture, "WO-R28");
  const event = await database.query<{ id: number }>(
    `
      insert into work_order_events (
        work_order_id,
        factory_id,
        event_type,
        actor_kind,
        actor_membership_id,
        content,
        idempotency_key
      )
      values ($1, $2, 'observation_added', 'user', $3, '原始观察', 'R28-1')
      returning id
    `,
    [workOrderId, fixture.factoryId, fixture.membershipId],
  );

  await assert.rejects(
    database.query(
      `update work_order_events set content = '被修改' where id = $1`,
      [event.rows[0].id],
    ),
    /append-only/i,
  );

  await assert.rejects(
    database.query(`delete from work_order_events where id = $1`, [event.rows[0].id]),
    /append-only/i,
  );
});

test("R29：创建草稿工单会同时写入第一条创建事件", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  let sourceFiles: string[] = [];
  try {
    sourceFiles = await readdir(sourceDirectory);
  } catch {
    assert.fail("工单创建服务目录尚未实现");
  }
  assert.ok(
    sourceFiles.includes("create-draft-work-order.ts"),
    "工单创建服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R29");

  const result = await createDraftWorkOrder(database, {
    workOrderNo: "WO-R29",
    factoryId: fixture.factoryId,
    equipmentId: fixture.equipmentId,
    creatorMembershipId: fixture.membershipId,
    reportedFaultCode: "OHF",
    initialObservation: "外壳温度较高，冷却风扇不转，尚未拆检。",
    idempotencyKey: "R29-create-1",
    isDemo: true,
  });

  const saved = await database.query<{
    work_order_id: number;
    status: string;
    event_id: number;
    event_type: string;
    to_status: string;
  }>(
    `
      select
        wo.id as work_order_id,
        wo.status,
        event.id as event_id,
        event.event_type,
        event.to_status
      from work_orders wo
      join work_order_events event on event.work_order_id = wo.id
      where wo.id = $1
    `,
    [result.workOrderId],
  );

  assert.equal(saved.rows.length, 1);
  assert.deepEqual(saved.rows[0], {
    work_order_id: result.workOrderId,
    status: "draft",
    event_id: result.eventId,
    event_type: "work_order_created",
    to_status: "draft",
  });
});

test("R10：第一条事件写入失败时草稿工单也必须回滚", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  let sourceFiles: string[] = [];
  try {
    sourceFiles = await readdir(sourceDirectory);
  } catch {
    assert.fail("工单创建服务目录尚未实现");
  }
  assert.ok(
    sourceFiles.includes("create-draft-work-order.ts"),
    "工单创建服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R10");

  await assert.rejects(
    createDraftWorkOrder(database, {
      workOrderNo: "WO-R10-ROLLBACK",
      factoryId: fixture.factoryId,
      equipmentId: fixture.equipmentId,
      creatorMembershipId: fixture.membershipId,
      reportedFaultCode: "OHF",
      initialObservation: "   ",
      idempotencyKey: "R10-create-1",
      isDemo: true,
    }),
    /check constraint/i,
  );

  const remainingWorkOrders = await database.query<{ count: number }>(`
    select count(*)::integer as count
    from work_orders
    where work_order_no = 'WO-R10-ROLLBACK'
  `);

  assert.equal(remainingWorkOrders.rows[0].count, 0);
});

test("R30：已停用的厂区成员不能创建新工单", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R30");

  await database.query(
    `update factory_memberships set is_active = false where id = $1`,
    [fixture.membershipId],
  );

  await assert.rejects(
    createDraftWorkOrder(database, {
      workOrderNo: "WO-R30",
      factoryId: fixture.factoryId,
      equipmentId: fixture.equipmentId,
      creatorMembershipId: fixture.membershipId,
      initialObservation: "停用成员不应创建此工单。",
      idempotencyKey: "R30-create-1",
      isDemo: true,
    }),
    /active factory membership required/i,
  );

  const remainingWorkOrders = await database.query<{ count: number }>(`
    select count(*)::integer as count
    from work_orders
    where work_order_no = 'WO-R30'
  `);
  assert.equal(remainingWorkOrders.rows[0].count, 0);
});

test("R31：已停用的系统用户不能通过旧成员关系创建新工单", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R31");

  await database.query(`update users set is_active = false where id = $1`, [
    fixture.userId,
  ]);

  await assert.rejects(
    createDraftWorkOrder(database, {
      workOrderNo: "WO-R31",
      factoryId: fixture.factoryId,
      equipmentId: fixture.equipmentId,
      creatorMembershipId: fixture.membershipId,
      initialObservation: "停用用户不应创建此工单。",
      idempotencyKey: "R31-create-1",
      isDemo: true,
    }),
    /active factory membership required/i,
  );

  const remainingWorkOrders = await database.query<{ count: number }>(`
    select count(*)::integer as count
    from work_orders
    where work_order_no = 'WO-R31'
  `);
  assert.equal(remainingWorkOrders.rows[0].count, 0);
});

test("R32：草稿工单不能跳过流程直接进入已解决", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  const sourceFiles = await readdir(sourceDirectory);
  assert.ok(
    sourceFiles.includes("transition-work-order.ts"),
    "工单状态转换服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const { transitionWorkOrder } = await import(
    "../src/work-orders/transition-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R32");
  const created = await createDraftWorkOrder(database, {
    workOrderNo: "WO-R32",
    factoryId: fixture.factoryId,
    equipmentId: fixture.equipmentId,
    creatorMembershipId: fixture.membershipId,
    initialObservation: "测试非法跳转。",
    idempotencyKey: "R32-create-1",
  });

  await assert.rejects(
    transitionWorkOrder(database, {
      workOrderId: created.workOrderId,
      toStatus: "resolved",
      actorKind: "user",
      actorMembershipId: fixture.membershipId,
      content: "不能直接解决。",
      idempotencyKey: "R32-transition-1",
    }),
    /invalid work order transition/i,
  );

  const unchanged = await database.query<{ status: string; event_count: number }>(
    `
      select
        wo.status,
        count(event.id)::integer as event_count
      from work_orders wo
      left join work_order_events event on event.work_order_id = wo.id
      where wo.id = $1
      group by wo.id
    `,
    [created.workOrderId],
  );

  assert.deepEqual(unchanged.rows[0], {
    status: "draft",
    event_count: 1,
  });
});

test("R33：合法状态转换会同时更新当前状态并追加事件", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  const sourceFiles = await readdir(sourceDirectory);
  assert.ok(
    sourceFiles.includes("transition-work-order.ts"),
    "工单状态转换服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const { transitionWorkOrder } = await import(
    "../src/work-orders/transition-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R33");
  const created = await createDraftWorkOrder(database, {
    workOrderNo: "WO-R33",
    factoryId: fixture.factoryId,
    equipmentId: fixture.equipmentId,
    creatorMembershipId: fixture.membershipId,
    initialObservation: "准备进入排查。",
    idempotencyKey: "R33-create-1",
  });

  const transitioned = await transitionWorkOrder(database, {
    workOrderId: created.workOrderId,
    toStatus: "investigating",
    actorKind: "user",
    actorMembershipId: fixture.membershipId,
    content: "开始根据现场信息排查。",
    idempotencyKey: "R33-transition-1",
  });

  const saved = await database.query<{
    status: string;
    event_id: number;
    from_status: string;
    to_status: string;
  }>(
    `
      select
        wo.status,
        event.id as event_id,
        event.from_status,
        event.to_status
      from work_orders wo
      join work_order_events event on event.work_order_id = wo.id
      where wo.id = $1
        and event.event_type = 'status_changed'
    `,
    [created.workOrderId],
  );

  assert.deepEqual(saved.rows[0], {
    status: "investigating",
    event_id: transitioned.eventId,
    from_status: "draft",
    to_status: "investigating",
  });
});

test("R34：状态事件写入失败时当前状态必须回滚", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  const sourceFiles = await readdir(sourceDirectory);
  assert.ok(
    sourceFiles.includes("transition-work-order.ts"),
    "工单状态转换服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const { transitionWorkOrder } = await import(
    "../src/work-orders/transition-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R34");
  const duplicateKey = "R34-duplicate-key";
  const created = await createDraftWorkOrder(database, {
    workOrderNo: "WO-R34",
    factoryId: fixture.factoryId,
    equipmentId: fixture.equipmentId,
    creatorMembershipId: fixture.membershipId,
    initialObservation: "制造事件冲突。",
    idempotencyKey: duplicateKey,
  });

  await assert.rejects(
    transitionWorkOrder(database, {
      workOrderId: created.workOrderId,
      toStatus: "investigating",
      actorKind: "user",
      actorMembershipId: fixture.membershipId,
      content: "这条事件会因为幂等键冲突而失败。",
      idempotencyKey: duplicateKey,
    }),
    /unique/i,
  );

  const unchanged = await database.query<{ status: string }>(
    `select status from work_orders where id = $1`,
    [created.workOrderId],
  );
  assert.equal(unchanged.rows[0].status, "draft");
});

test("R35：已停用的厂区成员不能执行状态转换", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  const sourceFiles = await readdir(sourceDirectory);
  assert.ok(
    sourceFiles.includes("transition-work-order.ts"),
    "工单状态转换服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const { transitionWorkOrder } = await import(
    "../src/work-orders/transition-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R35");
  const created = await createDraftWorkOrder(database, {
    workOrderNo: "WO-R35",
    factoryId: fixture.factoryId,
    equipmentId: fixture.equipmentId,
    creatorMembershipId: fixture.membershipId,
    initialObservation: "创建后停用成员。",
    idempotencyKey: "R35-create-1",
  });

  await database.query(
    `update factory_memberships set is_active = false where id = $1`,
    [fixture.membershipId],
  );

  await assert.rejects(
    transitionWorkOrder(database, {
      workOrderId: created.workOrderId,
      toStatus: "investigating",
      actorKind: "user",
      actorMembershipId: fixture.membershipId,
      content: "停用成员不应转换状态。",
      idempotencyKey: "R35-transition-1",
    }),
    /active factory membership required/i,
  );
});

test("R36：用户账号停用后不能转换工单状态", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const sourceDirectory = new URL("../src/work-orders/", import.meta.url);
  const sourceFiles = await readdir(sourceDirectory);
  assert.ok(
    sourceFiles.includes("transition-work-order.ts"),
    "工单状态转换服务尚未实现",
  );

  const { createDraftWorkOrder } = await import(
    "../src/work-orders/create-draft-work-order.ts"
  );
  const { transitionWorkOrder } = await import(
    "../src/work-orders/transition-work-order.ts"
  );
  const fixture = await createWorkOrderPrerequisites(database, "R36");
  const created = await createDraftWorkOrder(database, {
    workOrderNo: "WO-R36",
    factoryId: fixture.factoryId,
    equipmentId: fixture.equipmentId,
    creatorMembershipId: fixture.membershipId,
    initialObservation: "创建后停用用户。",
    idempotencyKey: "R36-create-1",
  });

  await database.query(`update users set is_active = false where id = $1`, [
    fixture.userId,
  ]);

  await assert.rejects(
    transitionWorkOrder(database, {
      workOrderId: created.workOrderId,
      toStatus: "investigating",
      actorKind: "user",
      actorMembershipId: fixture.membershipId,
      content: "停用用户不应转换状态。",
      idempotencyKey: "R36-transition-1",
    }),
    /active factory membership required/i,
  );
});

test("R37：官方资料必须引用真实存在的规范产品系列", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "source_documents", "product_family_id");

  await assert.rejects(
    database.query(
      `
        insert into source_documents (
          publisher,
          title,
          document_reference,
          product_family_id,
          source_type,
          official_url
        )
        values (
          'Schneider Electric',
          '不存在系列的测试资料',
          'TEST-R37',
          999999,
          'official_manual',
          'https://example.test/TEST-R37'
        )
      `,
    ),
    /foreign key/i,
  );

  await assert.rejects(
    database.query(
      `
        insert into source_documents (
          publisher,
          title,
          document_reference,
          source_type,
          official_url
        )
        values (
          'Schneider Electric',
          '缺少系列的测试资料',
          'TEST-R37-NO-FAMILY',
          'official_manual',
          'https://example.test/TEST-R37-NO-FAMILY'
        )
      `,
    ),
    /not-null/i,
  );
});

test("R38：资料升级只连接已确认的规范系列并保留原始系列文字", async (context) => {
  const database = await openDatabaseThroughMigration(
    "008_work_order_identity_status_and_events.sql",
  );
  context.after(async () => database.close());

  const productFamily = await database.query<{ id: number }>(`
    insert into product_families (
      manufacturer_name,
      family_code,
      display_name
    )
    values (
      'Schneider Electric',
      'ATV320',
      'Altivar Machine ATV320'
    )
    returning id
  `);
  const legacyDocument = await database.query<{ id: number }>(`
    insert into source_documents (
      publisher,
      title,
      document_reference,
      product_family,
      source_type,
      official_url
    )
    values (
      ' schneider electric ',
      'ATV320 编程手册',
      'NVE41300',
      ' atv320 ',
      'official_manual',
      'https://www.se.com/download/document/NVE41300/'
    )
    returning id
  `);

  const migrationsDirectory = new URL("../database/migrations/", import.meta.url);
  const migrationFile = "009_link_source_documents_to_product_families.sql";
  const migrationFiles = await readdir(migrationsDirectory);
  assert.ok(migrationFiles.includes(migrationFile), `${migrationFile} 尚未实现`);

  const migrationSql = await readFile(
    new URL(migrationFile, migrationsDirectory),
    "utf8",
  );
  await database.exec(migrationSql);

  const migratedDocument = await database.query<{
    product_family_id: number;
    raw_product_family: string;
  }>(
    `
      select product_family_id, raw_product_family
      from source_documents
      where id = $1
    `,
    [legacyDocument.rows[0].id],
  );

  assert.deepEqual(migratedDocument.rows[0], {
    product_family_id: productFamily.rows[0].id,
    raw_product_family: " atv320 ",
  });
});

test("R39：官方资料类别只能使用经过设计的允许值", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const fixture = await createCanonicalSourceDocument(database, "R39");

  await assert.rejects(
    database.query(
      `
        insert into source_documents (
          publisher,
          title,
          document_reference,
          product_family_id,
          source_type,
          official_url
        )
        values (
          'Schneider Electric',
          '类别拼写错误的资料',
          'TEST-R39',
          $1,
          'offical_mannual',
          'https://example.test/TEST-R39'
        )
      `,
      [fixture.productFamilyId],
    ),
    /check constraint/i,
  );
});

test("R40：新导入的资料版本默认待审核而不是自动生效", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "source_versions", "version_status");
  const fixture = await createCanonicalSourceDocument(database, "R40");
  const sourceVersion = await database.query<{ version_status: string }>(
    `
      insert into source_versions (
        source_document_id,
        version_label,
        language_code,
        publisher_page_date,
        sha256,
        local_path
      )
      values ($1, '05', 'zh-CN', date '2025-07-04', $2, $3)
      returning version_status
    `,
    [
      fixture.sourceDocumentId,
      "b".repeat(64),
      "data/raw/official/schneider/atv320/NVE41300-v05-zh-CN.pdf",
    ],
  );

  assert.equal(sourceVersion.rows[0].version_status, "unreviewed");
});

test("R41：资料版本状态只能使用规定的四种状态", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const fixture = await createCanonicalSourceDocument(database, "R41");

  await assert.rejects(
    database.query(
      `
        insert into source_versions (
          source_document_id,
          version_label,
          language_code,
          sha256,
          local_path,
          version_status
        )
        values ($1, '05', 'zh-CN', $2, $3, 'approved')
      `,
      [
        fixture.sourceDocumentId,
        "c".repeat(64),
        "data/raw/official/schneider/atv320/R41-v05-zh-CN.pdf",
      ],
    ),
    /check constraint/i,
  );
});

test("R42：同一资料同一语言只能有一个当前有效版本", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const fixture = await createCanonicalSourceDocument(database, "R42");
  await database.query(
    `
      insert into source_versions (
        source_document_id,
        version_label,
        language_code,
        sha256,
        local_path,
        version_status
      )
      values ($1, '04', 'zh-CN', $2, $3, 'superseded')
    `,
    [
      fixture.sourceDocumentId,
      "d".repeat(64),
      "data/raw/official/schneider/atv320/R42-v04-zh-CN.pdf",
    ],
  );
  await database.query(
    `
      insert into source_versions (
        source_document_id,
        version_label,
        language_code,
        sha256,
        local_path,
        version_status
      )
      values ($1, '05', 'zh-CN', $2, $3, 'current')
    `,
    [
      fixture.sourceDocumentId,
      "e".repeat(64),
      "data/raw/official/schneider/atv320/R42-v05-zh-CN.pdf",
    ],
  );

  await assert.rejects(
    database.query(
      `
        insert into source_versions (
          source_document_id,
          version_label,
          language_code,
          sha256,
          local_path,
          version_status
        )
        values ($1, '06', ' zh-cn ', $2, $3, 'current')
      `,
      [
        fixture.sourceDocumentId,
        "f".repeat(64),
        "data/raw/official/schneider/atv320/R42-v06-zh-CN.pdf",
      ],
    ),
    /unique constraint/i,
  );
});

test("R06：同一资料版本和文件指纹不能重复导入", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const fixture = await createCanonicalSourceDocument(database, "R06");
  const fileFingerprint = "1".repeat(64);
  await database.query(
    `
      insert into source_versions (
        source_document_id,
        version_label,
        language_code,
        sha256,
        local_path
      )
      values ($1, '05', 'zh-CN', $2, $3)
    `,
    [
      fixture.sourceDocumentId,
      fileFingerprint,
      "data/raw/official/schneider/atv320/R06-first.pdf",
    ],
  );

  await assert.rejects(
    database.query(
      `
        insert into source_versions (
          source_document_id,
          version_label,
          language_code,
          sha256,
          local_path
        )
        values ($1, ' 05 ', 'zh-cn', $2, $3)
      `,
      [
        fixture.sourceDocumentId,
        fileFingerprint,
        "data/raw/official/schneider/atv320/R06-copy.pdf",
      ],
    ),
    /unique constraint/i,
  );
});

test("R43：同一发布机构和文件编号不能因大小写或空格重复建档", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const fixture = await createCanonicalSourceDocument(database, "R43");

  await assert.rejects(
    database.query(
      `
        insert into source_documents (
          publisher,
          title,
          document_reference,
          product_family_id,
          source_type,
          official_url
        )
        values (
          ' schneider electric ',
          '重复建档的 ATV320 编程手册',
          ' nve41300-r43 ',
          $1,
          'official_manual',
          'https://example.test/R43-duplicate'
        )
      `,
      [fixture.productFamilyId],
    ),
    /unique constraint/i,
  );
});

test("R44：官方文件指纹必须与清单一致且重复导入不会产生副本", async (context) => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../data/manifests/atv320-official-source-candidates.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    records: Array<{
      acquisition_status: string;
      sha256: string;
      local_path: string;
    }>;
  };
  const record = manifest.records[0];
  assert.equal(record.acquisition_status, "downloaded");

  const sourceFile = await readFile(new URL(`../${record.local_path}`, import.meta.url));
  const actualFingerprint = createHash("sha256").update(sourceFile).digest("hex");
  assert.equal(actualFingerprint, record.sha256);

  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const seedsDirectory = new URL("../database/seeds/", import.meta.url);
  let seedFiles: string[] = [];
  try {
    seedFiles = await readdir(seedsDirectory);
  } catch {
    assert.fail("官方资料种子目录尚未实现：database/seeds");
  }
  const seedFile = "001_atv320_nve41300.sql";
  assert.ok(seedFiles.includes(seedFile), `${seedFile} 尚未实现`);

  const seedSql = await readFile(new URL(seedFile, seedsDirectory), "utf8");
  await database.exec(seedSql);
  await database.exec(seedSql);

  const imported = await database.query<{
    document_count: number;
    version_count: number;
    version_status: string;
    sha256: string;
  }>(`
    select
      count(distinct source_document.id)::integer as document_count,
      count(source_version.id)::integer as version_count,
      min(source_version.version_status) as version_status,
      min(source_version.sha256) as sha256
    from source_documents as source_document
    join source_versions as source_version
      on source_version.source_document_id = source_document.id
    where lower(btrim(source_document.publisher)) = 'schneider electric'
      and lower(btrim(source_document.document_reference)) = 'nve41300'
  `);

  assert.deepEqual(imported.rows[0], {
    document_count: 1,
    version_count: 1,
    version_status: "unreviewed",
    sha256: record.sha256,
  });
});

test("R45：官方资料导入遇到同编号但产品系列冲突时必须失败", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  const wrongFamily = await database.query<{ id: number }>(`
    insert into product_families (
      manufacturer_name,
      family_code,
      display_name
    )
    values (
      'Schneider Electric',
      'ATV340',
      'Altivar Machine ATV340'
    )
    returning id
  `);
  await database.query(
    `
      insert into source_documents (
        publisher,
        title,
        document_reference,
        product_family_id,
        source_type,
        official_url
      )
      values (
        'Schneider Electric',
        '错误关联的 NVE41300',
        'NVE41300',
        $1,
        'official_manual',
        'https://example.test/wrong-NVE41300'
      )
    `,
    [wrongFamily.rows[0].id],
  );

  const seedSql = await readFile(
    new URL("../database/seeds/001_atv320_nve41300.sql", import.meta.url),
    "utf8",
  );

  await assert.rejects(
    database.exec(seedSql),
    /verified source document metadata conflict: NVE41300/i,
  );
});

test("R46：厂商网页日期和PDF版次月份必须分别保存", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "source_versions", "publisher_page_date");
  await assertColumnExists(database, "source_versions", "document_issue_label");

  const seedSql = await readFile(
    new URL("../database/seeds/001_atv320_nve41300.sql", import.meta.url),
    "utf8",
  );
  await database.exec(seedSql);

  const versionDates = await database.query<{
    publisher_page_date: string;
    document_issue_label: string;
  }>(`
    select
      publisher_page_date::text,
      document_issue_label
    from source_versions as source_version
    join source_documents as source_document
      on source_document.id = source_version.source_document_id
    where lower(btrim(source_document.publisher)) = 'schneider electric'
      and lower(btrim(source_document.document_reference)) = 'nve41300'
  `);

  assert.deepEqual(versionDates.rows[0], {
    publisher_page_date: "2025-07-04",
    document_issue_label: "07/2024",
  });
});

test("R47：页面提取记录必须属于真实存在的资料版本", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertTableExists(database, "document_pages");

  await assert.rejects(
    database.query(
      `
        insert into document_pages (source_version_id, pdf_page_number)
        values (999999, 1)
      `,
    ),
    /foreign key/i,
  );
});

test("R48：PDF页序必须从一开始", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into document_pages (source_version_id, pdf_page_number)
        values ($1, 0)
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R49：同一资料版本的同一PDF页不能重复保存", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  const insertPage = () =>
    database.query(
      `
        insert into document_pages (source_version_id, pdf_page_number)
        values ($1, 72)
      `,
      [sourceVersionId],
    );

  await insertPage();
  await assert.rejects(insertPage(), /unique constraint/i);
});

test("R50：页面提取方式只能使用规定的三种方式", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const documentPageId = await createDocumentPage(database, sourceVersionId, 1);

  await assert.rejects(
    database.query(
      `
        insert into page_extractions (
          document_page_id,
          extraction_method,
          extractor_name,
          extractor_version,
          extraction_status
        )
        values ($1, 'magic_ai', 'unknown', '1', 'failed')
      `,
      [documentPageId],
    ),
    /check constraint/i,
  );
});

test("R51：页面提取状态只能使用规定的四种状态", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const documentPageId = await createDocumentPage(database, sourceVersionId, 1);

  await assert.rejects(
    database.query(
      `
        insert into page_extractions (
          document_page_id,
          extraction_method,
          extractor_name,
          extractor_version,
          extraction_status
        )
        values ($1, 'embedded_text', 'pypdf', '6.0.0', 'looks_good')
      `,
      [documentPageId],
    ),
    /check constraint/i,
  );
});

test("R52：页面状态必须与正文和正文指纹一致", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const firstPageId = await createDocumentPage(database, sourceVersionId, 1);
  const secondPageId = await createDocumentPage(database, sourceVersionId, 2);

  await assert.rejects(
    database.query(
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
        values ($1, 'embedded_text', 'pypdf', '6.0.0', 'extracted', '   ', $2)
      `,
      [firstPageId, "a".repeat(64)],
    ),
    /check constraint/i,
  );

  await assert.rejects(
    database.query(
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
        values ($1, 'embedded_text', 'pypdf', '6.0.0', 'blank', '不是空白页', $2)
      `,
      [secondPageId, "b".repeat(64)],
    ),
    /check constraint/i,
  );
});

test("R53：每页必须记录非空的提取工具名称和版本", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const firstPageId = await createDocumentPage(database, sourceVersionId, 1);
  const secondPageId = await createDocumentPage(database, sourceVersionId, 2);

  await assert.rejects(
    database.query(
      `
        insert into page_extractions (
          document_page_id,
          extraction_method,
          extractor_name,
          extractor_version,
          extraction_status
        )
        values ($1, 'embedded_text', '   ', '6.10.0', 'blank')
      `,
      [firstPageId],
    ),
    /check constraint/i,
  );

  await assert.rejects(
    database.query(
      `
        insert into page_extractions (
          document_page_id,
          extraction_method,
          extractor_name,
          extractor_version,
          extraction_status
        )
        values ($1, 'embedded_text', 'pypdf', '', 'blank')
      `,
      [secondPageId],
    ),
    /check constraint/i,
  );
});

test("R54：真实PDF必须生成连续且可校验的440页提取文件", async () => {
  const artifactUrl = new URL(
    "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
    import.meta.url,
  );
  let artifactText = "";
  try {
    artifactText = await readFile(artifactUrl, "utf8");
  } catch {
    assert.fail("真实PDF页面提取文件尚未生成");
  }

  const artifact = JSON.parse(artifactText) as {
    schema_version: number;
    source_sha256: string;
    extractor: { name: string; version: string };
    pages: Array<{
      pdf_page_number: number;
      printed_page_label: string | null;
      extraction_method: string;
      extraction_status: string;
      extracted_text: string | null;
      text_sha256: string | null;
    }>;
  };

  assert.equal(artifact.schema_version, 1);
  assert.equal(
    artifact.source_sha256,
    "a6a033d439ab3340bde3d062979aba8bd6014762d12e2fb39aafe34aef000e57",
  );
  assert.deepEqual(artifact.extractor, { name: "pypdf", version: "6.10.0" });
  assert.equal(artifact.pages.length, 440);
  assert.deepEqual(
    artifact.pages.map((page) => page.pdf_page_number),
    Array.from({ length: 440 }, (_, index) => index + 1),
  );

  const blankPageNumbers: number[] = [];
  for (const page of artifact.pages) {
    assert.equal(page.extraction_method, "embedded_text");
    assert.equal(page.printed_page_label, null);

    if (page.extraction_status === "blank") {
      blankPageNumbers.push(page.pdf_page_number);
      assert.equal(page.extracted_text, null);
      assert.equal(page.text_sha256, null);
      continue;
    }

    assert.equal(page.extraction_status, "extracted");
    assert.ok(page.extracted_text?.trim());
    assert.equal(
      createHash("sha256").update(page.extracted_text, "utf8").digest("hex"),
      page.text_sha256,
    );
  }

  assert.deepEqual(blankPageNumbers, [14, 436, 439]);
  const ohfPage = artifact.pages[71];
  assert.match(ohfPage.extracted_text ?? "", /OHF/i);
  assert.match(ohfPage.extracted_text ?? "", /设备过热/);
});

test("R55：同一PDF页必须允许保留不同提取器的结果", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  await assertTableExists(database, "page_extractions");

  const documentPage = await database.query<{ id: number }>(
    `
      insert into document_pages (source_version_id, pdf_page_number)
      values ($1, 72)
      returning id
    `,
    [sourceVersionId],
  );

  await database.query(
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
    `,
    [documentPage.rows[0].id, "pypdf 提取的 OHF 页面", "a".repeat(64)],
  );
  await database.query(
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
      values ($1, 'embedded_text', 'docling', '2.0.0', 'extracted', $2, $3)
    `,
    [documentPage.rows[0].id, "Docling 提取的 OHF 页面", "b".repeat(64)],
  );

  const extractions = await database.query<{ extractor_name: string }>(
    `
      select extractor_name
      from page_extractions
      where document_page_id = $1
      order by extractor_name
    `,
    [documentPage.rows[0].id],
  );
  assert.deepEqual(extractions.rows, [
    { extractor_name: "docling" },
    { extractor_name: "pypdf" },
  ]);
});

test("R56：页面抽取结果必须属于真实存在的PDF页", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assert.rejects(
    database.query(`
      insert into page_extractions (
        document_page_id,
        extraction_method,
        extractor_name,
        extractor_version,
        extraction_status
      )
      values (999999, 'embedded_text', 'pypdf', '6.10.0', 'blank')
    `),
    /foreign key/i,
  );
});

test("R57：同一页面同一提取器版本和配置不能重复保存", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const documentPageId = await createDocumentPage(database, sourceVersionId, 72);

  const insertExtraction = () =>
    database.query(
      `
        insert into page_extractions (
          document_page_id,
          extraction_method,
          extractor_name,
          extractor_version,
          extraction_status
        )
        values ($1, 'embedded_text', ' PyPDF ', '6.10.0', 'blank')
      `,
      [documentPageId],
    );

  await insertExtraction();
  await assert.rejects(insertExtraction(), /unique constraint/i);
});

test("R58：TypeScript导入器会一次写入440个页面和440份基线结果", async (context) => {
  const sourceDirectory = new URL("../src/knowledge/", import.meta.url);
  let sourceFiles: string[] = [];
  try {
    sourceFiles = await readdir(sourceDirectory);
  } catch {
    assert.fail("知识资料导入目录尚未实现：src/knowledge");
  }
  assert.ok(
    sourceFiles.includes("import-document-pages.ts"),
    "页面导入器尚未实现",
  );

  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  const imported = await importDocumentPages(database, {
    sourceVersionId,
    artifact,
  });

  assert.deepEqual(imported, {
    sourceVersionId,
    pageCount: 440,
    extractionCount: 440,
  });
  const summary = await database.query<{
    page_count: number;
    extraction_count: number;
    extracted_count: number;
    blank_count: number;
  }>(`
    select
      count(distinct document_page.id)::integer as page_count,
      count(page_extraction.id)::integer as extraction_count,
      count(*) filter (
        where page_extraction.extraction_status = 'extracted'
      )::integer as extracted_count,
      count(*) filter (
        where page_extraction.extraction_status = 'blank'
      )::integer as blank_count
    from document_pages as document_page
    join page_extractions as page_extraction
      on page_extraction.document_page_id = document_page.id
    where document_page.source_version_id = $1
  `, [sourceVersionId]);
  assert.deepEqual(summary.rows[0], {
    page_count: 440,
    extraction_count: 440,
    extracted_count: 437,
    blank_count: 3,
  });

  const ohfPage = await database.query<{ extracted_text: string }>(
    `
      select page_extraction.extracted_text
      from document_pages as document_page
      join page_extractions as page_extraction
        on page_extraction.document_page_id = document_page.id
      where document_page.source_version_id = $1
        and document_page.pdf_page_number = 72
        and lower(btrim(page_extraction.extractor_name)) = 'pypdf'
    `,
    [sourceVersionId],
  );
  assert.match(ohfPage.rows[0].extracted_text, /OHF/i);
  assert.match(ohfPage.rows[0].extracted_text, /设备过热/);
});

test("R59：页面文件来源指纹与资料版本不一致时整批拒绝", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  artifact.source_sha256 = "0".repeat(64);

  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    importDocumentPages(database, { sourceVersionId, artifact }),
    /source version fingerprint mismatch/i,
  );
  const remaining = await database.query<{ page_count: number }>(
    `
      select count(*)::integer as page_count
      from document_pages
      where source_version_id = $1
    `,
    [sourceVersionId],
  );
  assert.equal(remaining.rows[0].page_count, 0);
});

test("R60：任一页正文与正文指纹不一致时整批拒绝", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  artifact.pages[71].extracted_text += "\n被篡改但没有更新指纹";

  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    importDocumentPages(database, { sourceVersionId, artifact }),
    /page 72 text fingerprint mismatch/i,
  );
  const remaining = await database.query<{ page_count: number }>(
    `
      select count(*)::integer as page_count
      from document_pages
      where source_version_id = $1
    `,
    [sourceVersionId],
  );
  assert.equal(remaining.rows[0].page_count, 0);
});

test("R61：任一抽取结果写入失败时页面身份也必须全部回滚", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  artifact.pages[439].extraction_status = "looks_good";

  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    importDocumentPages(database, { sourceVersionId, artifact }),
    /check constraint/i,
  );
  const remaining = await database.query<{
    page_count: number;
    extraction_count: number;
  }>(
    `
      select
        (select count(*) from document_pages)::integer as page_count,
        (select count(*) from page_extractions)::integer as extraction_count
    `,
  );
  assert.deepEqual(remaining.rows[0], {
    page_count: 0,
    extraction_count: 0,
  });
});

test("R62：同一份页面提取文件重复导入不会生成副本", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await importDocumentPages(database, { sourceVersionId, artifact });
  const retried = await importDocumentPages(database, {
    sourceVersionId,
    artifact,
  });

  assert.deepEqual(retried, {
    sourceVersionId,
    pageCount: 0,
    extractionCount: 0,
  });
  const totals = await database.query<{
    page_count: number;
    extraction_count: number;
  }>(`
    select
      (select count(*) from document_pages)::integer as page_count,
      (select count(*) from page_extractions)::integer as extraction_count
  `);
  assert.deepEqual(totals.rows[0], {
    page_count: 440,
    extraction_count: 440,
  });
});

test("R63：同一提取器身份出现不同页面正文时必须报告冲突", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  await importDocumentPages(database, { sourceVersionId, artifact });

  artifact.pages[71].extracted_text += "\n伪造的新正文";
  artifact.pages[71].text_sha256 = createHash("sha256")
    .update(artifact.pages[71].extracted_text, "utf8")
    .digest("hex");

  await assert.rejects(
    importDocumentPages(database, { sourceVersionId, artifact }),
    /existing extraction conflict on page 72/i,
  );
});

test("R64：页面提取文件缺页或乱序时必须整批拒绝", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  artifact.pages.splice(71, 1);

  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    importDocumentPages(database, { sourceVersionId, artifact }),
    /page sequence must be contiguous from 1/i,
  );
  const remaining = await database.query<{ page_count: number }>(`
    select count(*)::integer as page_count from document_pages
  `);
  assert.equal(remaining.rows[0].page_count, 0);
});

test("R67：未分类知识片段必须以保守状态进入待审核区", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  const inserted = await database.query<{
    content_kind: string;
    source_severity: string;
    usage_policy: string;
    review_status: string;
  }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        page_number
      )
      values ($1, 1, 'OHF：设备过热', 72)
      returning content_kind, source_severity, usage_policy, review_status
    `,
    [sourceVersionId],
  );

  assert.deepEqual(inserted.rows[0], {
    content_kind: "unclassified",
    source_severity: "unclassified",
    usage_policy: "reference_only",
    review_status: "unreviewed",
  });
});

test("R68：知识片段的内容种类只能使用规定值", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          content_kind
        )
        values ($1, 1, 'OHF：设备过热', 'maybe_fault')
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R69：资料原文的危险等级只能使用规定值", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          source_severity
        )
        values ($1, 1, '断电后等待15分钟。', 'very_dangerous')
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R70：知识片段的系统用途只能使用规定值", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          usage_policy
        )
        values ($1, 1, '拆机前必须隔离电源。', 'ai_decides_freely')
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R71：带注意警告或危险标识的原文不能作为低风险操作指导", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          content_kind,
          source_severity,
          usage_policy
        )
        values (
          $1,
          1,
          '危险：接触带电部件将导致死亡或严重伤害。',
          'safety_warning',
          'danger',
          'low_risk_guidance'
        )
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R72：知识片段审核状态只能使用规定值", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          review_status
        )
        values ($1, 1, 'OHF：设备过热', 'approved_by_ai')
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R73：没有完整分类和人工审核留痕的片段不能通过审核", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热",
  );

  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        'OHF：设备过热',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );
  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: source.documentPageId,
    pageExtractionId: source.pageExtractionId,
  });

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set review_status = 'approved'
        where id = $1
      `,
      [chunk.rows[0].id],
    ),
    /check constraint/i,
  );
});

test("R74：审核通过后必须同时保留机器原文和人工核对正文", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    50,
    "变频器热状态达到1 18%时触发OHF。",
  );
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R74-reviewer', '资料审核员-R74')
      returning id
    `,
  );

  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        page_number,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        '变频器热状态达到1 18%时触发OHF。',
        50,
        'threshold',
        'information',
        'reference_only',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );
  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: source.documentPageId,
    pageExtractionId: source.pageExtractionId,
  });
  const approved = await database.query<{
    original_text: string;
    verified_text: string;
    review_status: string;
  }>(
    `
      update knowledge_chunks
      set
        review_status = 'approved',
        verified_text = '变频器热状态达到118%时触发OHF。',
        reviewed_by_user_id = $2,
        reviewed_at = now(),
        review_notes = '对照官方PDF第50页，修正文字提取产生的数字空格。'
      where id = $1
      returning original_text, verified_text, review_status
    `,
    [chunk.rows[0].id, reviewer.rows[0].id],
  );

  assert.deepEqual(approved.rows[0], {
    original_text: "变频器热状态达到1 18%时触发OHF。",
    verified_text: "变频器热状态达到118%时触发OHF。",
    review_status: "approved",
  });
});

test("R75：审核驳回必须说明理由且不能留下已核对正文", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R73-reviewer', '资料审核员-R73')
      returning id
    `,
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          review_status,
          reviewed_by_user_id,
          reviewed_at
        )
        values ($1, 1, '无法确认页码的片段', 'rejected', $2, now())
      `,
      [sourceVersionId, reviewer.rows[0].id],
    ),
    /check constraint/i,
  );

  const rejected = await database.query<{
    review_status: string;
    verified_text: string | null;
    review_notes: string;
  }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        review_status,
        reviewed_by_user_id,
        reviewed_at,
        review_notes
      )
      values (
        $1,
        2,
        '无法确认页码的片段',
        'rejected',
        $2,
        now(),
        '未能在官方PDF中定位对应页面，不进入可用知识。'
      )
      returning review_status, verified_text, review_notes
    `,
    [sourceVersionId, reviewer.rows[0].id],
  );

  assert.equal(rejected.rows[0].review_status, "rejected");
  assert.equal(rejected.rows[0].verified_text, null);
  assert.match(rejected.rows[0].review_notes, /官方PDF/);
});

test("R76：知识片段不能伪造不存在的审核人", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        'OHF：设备过热',
        'fault_definition',
        'information',
        'reference_only',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );
  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: source.documentPageId,
    pageExtractionId: source.pageExtractionId,
  });

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set
          review_status = 'approved',
          verified_text = 'OHF：设备过热',
          reviewed_by_user_id = 999999,
          reviewed_at = now(),
          review_notes = '声称已审核但审核人不存在。'
        where id = $1
      `,
      [chunk.rows[0].id],
    ),
    /foreign key constraint/i,
  );
});

test("R77：升级三维分类时旧风险标签必须保留但不能再占用正式字段名", async (context) => {
  const database = await openDatabaseThroughMigration(
    "011_document_pages.sql",
  );
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await database.query(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        risk_label
      )
      values ($1, 1, '历史知识片段', 'high')
    `,
    [sourceVersionId],
  );

  const migrationSql = await readFile(
    new URL(
      "../database/migrations/012_classify_and_review_knowledge_chunks.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await database.exec(migrationSql);

  const columns = await database.query<{
    risk_label_exists: boolean;
    legacy_risk_label_exists: boolean;
  }>(`
    select
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'knowledge_chunks'
          and column_name = 'risk_label'
      ) as risk_label_exists,
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'knowledge_chunks'
          and column_name = 'legacy_risk_label'
      ) as legacy_risk_label_exists
  `);
  const migrated = await database.query<{
    legacy_risk_label: string;
    content_kind: string;
    source_severity: string;
    usage_policy: string;
    review_status: string;
  }>(`
    select
      legacy_risk_label,
      content_kind,
      source_severity,
      usage_policy,
      review_status
    from knowledge_chunks
    where chunk_no = 1
  `);

  assert.deepEqual(columns.rows[0], {
    risk_label_exists: false,
    legacy_risk_label_exists: true,
  });
  assert.deepEqual(migrated.rows[0], {
    legacy_risk_label: "high",
    content_kind: "unclassified",
    source_severity: "unclassified",
    usage_policy: "reference_only",
    review_status: "unreviewed",
  });
});

test("R78：知识片段必须能回查到具体页面和具体提取结果", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const documentPageId = await createDocumentPage(database, sourceVersionId, 50);
  const pageExtraction = await database.query<{ id: number }>(
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
      values (
        $1,
        'embedded_text',
        'pypdf',
        '6.10.0',
        'extracted',
        '变频器热状态达到1 18%时触发OHF。',
        $2
      )
      returning id
    `,
    [documentPageId, "a".repeat(64)],
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        page_number,
        content_kind,
        source_severity,
        usage_policy
      )
      values (
        $1,
        1,
        '变频器热状态达到1 18%时触发OHF。',
        50,
        'threshold',
        'information',
        'reference_only'
      )
      returning id
    `,
    [sourceVersionId],
  );

  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId,
    pageExtractionId: pageExtraction.rows[0].id,
  });

  const provenance = await database.query<{
    pdf_page_number: number;
    extractor_name: string;
    extractor_version: string;
    source_order: number;
  }>(
    `
      select
        document_page.pdf_page_number,
        page_extraction.extractor_name,
        page_extraction.extractor_version,
        chunk_source.source_order
      from knowledge_chunk_sources as chunk_source
      join document_pages as document_page
        on document_page.id = chunk_source.document_page_id
      join page_extractions as page_extraction
        on page_extraction.id = chunk_source.page_extraction_id
      where chunk_source.knowledge_chunk_id = $1
    `,
    [chunk.rows[0].id],
  );

  assert.deepEqual(provenance.rows, [
    {
      pdf_page_number: 50,
      extractor_name: "pypdf",
      extractor_version: "6.10.0",
      source_order: 1,
    },
  ]);
});

test("R79：来源关系中的资料版本必须与知识片段一致", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const version05Id = await seedOfficialSourceVersion(database);
  const version04Id = await createAlternateSourceVersion(
    database,
    version05Id,
    "04-R79",
  );
  const documentPageId = await createDocumentPage(database, version05Id, 50);
  const pageExtraction = await database.query<{ id: number }>(
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
      values (
        $1,
        'embedded_text',
        'pypdf',
        '6.10.0',
        'extracted',
        'OHF：设备过热',
        $2
      )
      returning id
    `,
    [documentPageId, "b".repeat(64)],
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text
      )
      values ($1, 1, 'OHF：设备过热')
      returning id
    `,
    [version05Id],
  );

  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: chunk.rows[0].id,
      sourceVersionId: version04Id,
      documentPageId,
      pageExtractionId: pageExtraction.rows[0].id,
    }),
    /foreign key constraint/i,
  );
});

test("R80：来源关系中的页面必须属于声明的同一资料版本", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const version05Id = await seedOfficialSourceVersion(database);
  const version04Id = await createAlternateSourceVersion(
    database,
    version05Id,
    "04-R80",
  );
  const version04Source = await createExtractedPage(
    database,
    version04Id,
    50,
    "04版OHF内容",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text
      )
      values ($1, 1, '05版OHF内容')
      returning id
    `,
    [version05Id],
  );

  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: chunk.rows[0].id,
      sourceVersionId: version05Id,
      documentPageId: version04Source.documentPageId,
      pageExtractionId: version04Source.pageExtractionId,
    }),
    /foreign key constraint/i,
  );
});

test("R81：来源关系中的提取结果必须属于声明的同一页面", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const page50Source = await createExtractedPage(
    database,
    sourceVersionId,
    50,
    "第50页OHF阈值",
  );
  const page72Id = await createDocumentPage(database, sourceVersionId, 72);
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text
      )
      values ($1, 1, 'OHF：设备过热')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: chunk.rows[0].id,
      sourceVersionId,
      documentPageId: page72Id,
      pageExtractionId: page50Source.pageExtractionId,
    }),
    /foreign key constraint/i,
  );
});

test("R82：知识片段来源顺序必须从正数开始", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    50,
    "第50页OHF阈值",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, '第50页OHF阈值')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: chunk.rows[0].id,
      sourceVersionId,
      documentPageId: source.documentPageId,
      pageExtractionId: source.pageExtractionId,
      sourceOrder: 0,
    }),
    /check constraint/i,
  );
});

test("R83：同一知识片段不能有两个相同的来源顺序", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const firstSource = await createExtractedPage(
    database,
    sourceVersionId,
    50,
    "第50页OHF阈值",
  );
  const secondSource = await createExtractedPage(
    database,
    sourceVersionId,
    51,
    "第51页OHF阈值续页",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, '第50页和第51页的OHF阈值内容')
      returning id
    `,
    [sourceVersionId],
  );

  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: firstSource.documentPageId,
    pageExtractionId: firstSource.pageExtractionId,
  });
  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: chunk.rows[0].id,
      sourceVersionId,
      documentPageId: secondSource.documentPageId,
      pageExtractionId: secondSource.pageExtractionId,
    }),
    /unique constraint/i,
  );
});

test("R84：同一提取结果不能重复挂到同一知识片段", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    50,
    "第50页OHF阈值",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, '第50页OHF阈值')
      returning id
    `,
    [sourceVersionId],
  );

  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: source.documentPageId,
    pageExtractionId: source.pageExtractionId,
  });
  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: chunk.rows[0].id,
      sourceVersionId,
      documentPageId: source.documentPageId,
      pageExtractionId: source.pageExtractionId,
      sourceOrder: 2,
    }),
    /unique constraint/i,
  );
});

test("R85：没有具体页面提取来源的知识片段不能通过审核", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R85-reviewer', '资料审核员-R85')
      returning id
    `,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        'OHF：设备过热',
        'fault_definition',
        'information',
        'reference_only',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set
          review_status = 'approved',
          verified_text = 'OHF：设备过热',
          reviewed_by_user_id = $2,
          reviewed_at = now(),
          review_notes = '正文和分类已核对，但没有绑定页面来源。'
        where id = $1
      `,
      [chunk.rows[0].id, reviewer.rows[0].id],
    ),
    /approved knowledge chunk requires source provenance/i,
  );
});

test("R86：绑定具体页面提取来源后知识片段才能通过审核", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "设备过热 OHF：设备过热",
  );
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R86-reviewer', '资料审核员-R86')
      returning id
    `,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        page_number,
        content_kind,
        source_severity,
        usage_policy,
        fault_code,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        '设备过热 OHF：设备过热',
        72,
        'fault_definition',
        'information',
        'reference_only',
        'OHF',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );
  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: source.documentPageId,
    pageExtractionId: source.pageExtractionId,
  });

  const approved = await database.query<{ review_status: string }>(
    `
      update knowledge_chunks
      set
        review_status = 'approved',
        verified_text = '设备过热 OHF：设备过热',
        reviewed_by_user_id = $2,
        reviewed_at = now(),
        review_notes = '对照官方PDF第72页确认故障定义。'
      where id = $1
      returning review_status
    `,
    [chunk.rows[0].id, reviewer.rows[0].id],
  );
  const evidence = await database.query<{
    pdf_page_number: number;
    extractor_name: string;
    review_status: string;
  }>(
    `
      select
        document_page.pdf_page_number,
        page_extraction.extractor_name,
        knowledge_chunk.review_status
      from knowledge_chunks as knowledge_chunk
      join knowledge_chunk_sources as chunk_source
        on chunk_source.knowledge_chunk_id = knowledge_chunk.id
      join document_pages as document_page
        on document_page.id = chunk_source.document_page_id
      join page_extractions as page_extraction
        on page_extraction.id = chunk_source.page_extraction_id
      where knowledge_chunk.id = $1
    `,
    [chunk.rows[0].id],
  );

  assert.equal(approved.rows[0].review_status, "approved");
  assert.deepEqual(evidence.rows, [
    {
      pdf_page_number: 72,
      extractor_name: "pypdf",
      review_status: "approved",
    },
  ]);
});

test("R87：已经保存的页面提取结果不能更新或删除", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "设备过热 OHF：设备过热",
  );
  const changedText = "被原地替换的正文";

  await assert.rejects(
    database.query(
      `
        update page_extractions
        set extracted_text = $2, text_sha256 = $3
        where id = $1
      `,
      [
        source.pageExtractionId,
        changedText,
        createHash("sha256").update(changedText).digest("hex"),
      ],
    ),
    /page extractions are immutable/i,
  );
  await assert.rejects(
    database.query(`delete from page_extractions where id = $1`, [
      source.pageExtractionId,
    ]),
    /page extractions are immutable/i,
  );
});

test("R88：审核完成后知识片段的来源关系不能增删改", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const approved = await createApprovedKnowledgeChunk(
    database,
    sourceVersionId,
    "R88",
  );
  const replacementSource = await createExtractedPage(
    database,
    sourceVersionId,
    73,
    "伪造的替代来源",
  );

  await assert.rejects(
    database.query(
      `
        update knowledge_chunk_sources
        set
          document_page_id = $2,
          page_extraction_id = $3,
          start_character = 1,
          end_character = char_length($4) + 1,
          source_excerpt = $4
        where id = $1
      `,
      [
        approved.chunkSourceId,
        replacementSource.documentPageId,
        replacementSource.pageExtractionId,
        "伪造的替代来源",
      ],
    ),
    /reviewed knowledge chunk sources are immutable/i,
  );
  await assert.rejects(
    database.query(`delete from knowledge_chunk_sources where id = $1`, [
      approved.chunkSourceId,
    ]),
    /reviewed knowledge chunk sources are immutable/i,
  );
  await assert.rejects(
    insertKnowledgeChunkSource(database, {
      knowledgeChunkId: approved.knowledgeChunkId,
      sourceVersionId,
      documentPageId: replacementSource.documentPageId,
      pageExtractionId: replacementSource.pageExtractionId,
      sourceOrder: 2,
    }),
    /reviewed knowledge chunk sources are immutable/i,
  );
});

test("R89：审核完成后的知识片段正文和分类不能更新或删除", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const approved = await createApprovedKnowledgeChunk(
    database,
    sourceVersionId,
    "R89",
  );

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set verified_text = '未经重新审核就替换的正文'
        where id = $1
      `,
      [approved.knowledgeChunkId],
    ),
    /reviewed knowledge chunks are immutable/i,
  );
  await assert.rejects(
    database.query(`delete from knowledge_chunks where id = $1`, [
      approved.knowledgeChunkId,
    ]),
    /reviewed knowledge chunks are immutable/i,
  );
});

test("R90：真实手册第72页OHF定义能形成完整可回查来源链", async (context) => {
  const { importDocumentPages } = await import(
    "../src/knowledge/import-document-pages.ts"
  );
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../data/processed/schneider/atv320/NVE41300-v05-zh-CN-pages.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  await importDocumentPages(database, { sourceVersionId, artifact });

  const actualSource = await database.query<{
    document_page_id: number;
    page_extraction_id: number;
    extracted_text: string;
    text_sha256: string;
  }>(
    `
      select
        document_page.id as document_page_id,
        page_extraction.id as page_extraction_id,
        page_extraction.extracted_text,
        page_extraction.text_sha256
      from document_pages as document_page
      join page_extractions as page_extraction
        on page_extraction.document_page_id = document_page.id
      where document_page.source_version_id = $1
        and document_page.pdf_page_number = 72
        and lower(btrim(page_extraction.extractor_name)) = 'pypdf'
        and lower(btrim(page_extraction.extractor_version)) = '6.10.0'
    `,
    [sourceVersionId],
  );
  assert.equal(actualSource.rows.length, 1);
  assert.match(
    actualSource.rows[0].extracted_text,
    /\[设备过热\] OHF: 设备过热/,
  );
  assert.equal(
    actualSource.rows[0].text_sha256,
    "e8e2fddc584251547b8364c8a25faeba2058a5ea6cc1b13fefb42a0e231d9056",
  );

  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R90-reviewer', '资料审核员-R90')
      returning id
    `,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        page_number,
        content_kind,
        source_severity,
        usage_policy,
        fault_code,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        '• [设备过热] OHF: 设备过热',
        72,
        'fault_definition',
        'information',
        'reference_only',
        'OHF',
        'manual_selection',
        'database-test-fixture',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );
  await insertKnowledgeChunkSource(database, {
    knowledgeChunkId: chunk.rows[0].id,
    sourceVersionId,
    documentPageId: actualSource.rows[0].document_page_id,
    pageExtractionId: actualSource.rows[0].page_extraction_id,
    excerpt: "• [设备过热] OHF: 设备过热",
  });
  await database.query(
    `
      update knowledge_chunks
      set
        review_status = 'approved',
        verified_text = '• [设备过热] OHF: 设备过热',
        reviewed_by_user_id = $2,
        reviewed_at = now(),
        review_notes = '对照NVE41300中文05版PDF第72页确认。'
      where id = $1
    `,
    [chunk.rows[0].id, reviewer.rows[0].id],
  );

  const verified = await database.query<{
    fault_code: string;
    pdf_page_number: number;
    extractor_name: string;
    extractor_version: string;
    review_status: string;
  }>(
    `
      select
        knowledge_chunk.fault_code,
        document_page.pdf_page_number,
        page_extraction.extractor_name,
        page_extraction.extractor_version,
        knowledge_chunk.review_status
      from knowledge_chunks as knowledge_chunk
      join knowledge_chunk_sources as chunk_source
        on chunk_source.knowledge_chunk_id = knowledge_chunk.id
      join document_pages as document_page
        on document_page.id = chunk_source.document_page_id
      join page_extractions as page_extraction
        on page_extraction.id = chunk_source.page_extraction_id
      where knowledge_chunk.id = $1
    `,
    [chunk.rows[0].id],
  );

  assert.deepEqual(verified.rows, [
    {
      fault_code: "OHF",
      pdf_page_number: 72,
      extractor_name: "pypdf",
      extractor_version: "6.10.0",
      review_status: "approved",
    },
  ]);
});

test("R91：旧库存在无来源的已通过片段时来源链迁移必须阻断", async (context) => {
  const database = await openDatabaseThroughMigration(
    "012_classify_and_review_knowledge_chunks.sql",
  );
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R91-reviewer', '资料审核员-R91')
      returning id
    `,
  );
  await database.query(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        review_status,
        verified_text,
        reviewed_by_user_id,
        reviewed_at,
        review_notes
      )
      values (
        $1,
        1,
        '旧库中没有具体来源的已通过片段',
        'fault_definition',
        'information',
        'reference_only',
        'approved',
        '旧库中没有具体来源的已通过片段',
        $2,
        now(),
        '旧审核记录'
      )
    `,
    [sourceVersionId, reviewer.rows[0].id],
  );
  const migrationSql = await readFile(
    new URL(
      "../database/migrations/013_trace_knowledge_chunks_to_page_extractions.sql",
      import.meta.url,
    ),
    "utf8",
  );

  await assert.rejects(
    database.exec(migrationSql),
    /approved knowledge chunks without source provenance/i,
  );
  const tableExists = await database.query<{ table_exists: boolean }>(`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'knowledge_chunk_sources'
    ) as table_exists
  `);
  assert.equal(tableExists.rows[0].table_exists, false);
});

test("R92：知识片段来源必须保存并核对页面内的精确原文范围", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());

  await assertColumnExists(database, "knowledge_chunks", "chunking_method");
  await assertColumnExists(database, "knowledge_chunks", "chunker_name");
  await assertColumnExists(database, "knowledge_chunks", "chunker_version");
  await assertColumnExists(
    database,
    "knowledge_chunk_sources",
    "start_character",
  );
  await assertColumnExists(
    database,
    "knowledge_chunk_sources",
    "end_character",
  );
  await assertColumnExists(
    database,
    "knowledge_chunk_sources",
    "source_excerpt",
  );

  const sourceVersionId = await seedOfficialSourceVersion(database);
  const pageText = "错误代码表\n• [设备过热] OHF: 设备过热\n下一条故障";
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    pageText,
  );
  const excerpt = "• [设备过热] OHF: 设备过热";
  const startCharacter = Array.from(pageText).indexOf("•") + 1;
  const endCharacter = startCharacter + Array.from(excerpt).length;
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        $2,
        'fault_definition',
        'information',
        'reference_only',
        'structure_rule',
        'atv320-structure-chunker',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId, excerpt],
  );

  const relation = await database.query<{
    start_character: number;
    end_character: number;
    source_excerpt: string;
  }>(
    `
      insert into knowledge_chunk_sources (
        knowledge_chunk_id,
        source_version_id,
        document_page_id,
        page_extraction_id,
        source_order,
        start_character,
        end_character,
        source_excerpt
      )
      values ($1, $2, $3, $4, 1, $5, $6, $7)
      returning start_character, end_character, source_excerpt
    `,
    [
      chunk.rows[0].id,
      sourceVersionId,
      source.documentPageId,
      source.pageExtractionId,
      startCharacter,
      endCharacter,
      excerpt,
    ],
  );

  assert.deepEqual(relation.rows[0], {
    start_character: startCharacter,
    end_character: endCharacter,
    source_excerpt: excerpt,
  });
});

test("R93：数据库拒绝与页面原文不一致的片段摘录", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const pageText = "错误代码表\n• [设备过热] OHF: 设备过热\n下一条故障";
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    pageText,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text
      )
      values ($1, 1, '模型编造的OHF定义')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order,
          start_character,
          end_character,
          source_excerpt
        )
        values ($1, $2, $3, $4, 1, 7, 25, '模型编造的OHF定义')
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        source.documentPageId,
        source.pageExtractionId,
      ],
    ),
    /excerpt does not match the stored page range/i,
  );
});

test("R94：知识片段来源不能省略精确范围和原文摘录", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, 'OHF：设备过热')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order
        )
        values ($1, $2, $3, $4, 1)
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        source.documentPageId,
        source.pageExtractionId,
      ],
    ),
    /not-null constraint/i,
  );
});

test("R95：页面内原文范围必须使用从1开始且左闭右开的有效区间", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, 'OHF：')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order,
          start_character,
          end_character,
          source_excerpt
        )
        values ($1, $2, $3, $4, 1, 0, 5, 'OHF：')
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        source.documentPageId,
        source.pageExtractionId,
      ],
    ),
    /check constraint/i,
  );
});

test("R96：页面内原文范围的结束位置必须大于开始位置", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, 'OHF')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order,
          start_character,
          end_character,
          source_excerpt
        )
        values ($1, $2, $3, $4, 1, 4, 4, 'OHF')
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        source.documentPageId,
        source.pageExtractionId,
      ],
    ),
    /check constraint/i,
  );
});

test("R97：空白文字不能成为知识片段来源", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "标题\n   \n正文",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, '等待来源校验的候选片段')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order,
          start_character,
          end_character,
          source_excerpt
        )
        values ($1, $2, $3, $4, 1, 4, 7, '   ')
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        source.documentPageId,
        source.pageExtractionId,
      ],
    ),
    /check constraint/i,
  );
});

test("R98：只有提取成功且包含文字的页面结果才能作为片段来源", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const documentPageId = await createDocumentPage(
    database,
    sourceVersionId,
    72,
  );
  const failedExtraction = await database.query<{ id: number }>(
    `
      insert into page_extractions (
        document_page_id,
        extraction_method,
        extractor_name,
        extractor_version,
        extraction_status
      )
      values ($1, 'ocr', 'failed-ocr', '1.0.0', 'failed')
      returning id
    `,
    [documentPageId],
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, 'OHF：设备过热')
      returning id
    `,
    [sourceVersionId],
  );

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order,
          start_character,
          end_character,
          source_excerpt
        )
        values ($1, $2, $3, $4, 1, 1, 9, 'OHF：设备过热')
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        documentPageId,
        failedExtraction.rows[0].id,
      ],
    ),
    /requires an extracted page with text/i,
  );
});

test("R99：知识片段只能使用规定的切片方式", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          chunking_method,
          chunker_name,
          chunker_version
        )
        values (
          $1,
          1,
          'OHF：设备过热',
          'model_decides_everything',
          'unknown-model',
          'latest'
        )
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R100：正式切片方式必须同时记录工具名称和版本", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);

  await assert.rejects(
    database.query(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          chunking_method
        )
        values ($1, 1, 'OHF：设备过热', 'structure_rule')
      `,
      [sourceVersionId],
    ),
    /check constraint/i,
  );
});

test("R101：没有可复现切片方式的知识片段不能通过审核", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const text = "OHF：设备过热";
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    text,
  );
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R101-reviewer', '资料审核员-R101')
      returning id
    `,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy
      )
      values (
        $1,
        1,
        $2,
        'fault_definition',
        'information',
        'reference_only'
      )
      returning id
    `,
    [sourceVersionId, text],
  );
  await database.query(
    `
      insert into knowledge_chunk_sources (
        knowledge_chunk_id,
        source_version_id,
        document_page_id,
        page_extraction_id,
        source_order,
        start_character,
        end_character,
        source_excerpt
      )
      values ($1, $2, $3, $4, 1, 1, $5, $6)
    `,
    [
      chunk.rows[0].id,
      sourceVersionId,
      source.documentPageId,
      source.pageExtractionId,
      Array.from(text).length + 1,
      text,
    ],
  );

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set
          review_status = 'approved',
          verified_text = $2,
          reviewed_by_user_id = $3,
          reviewed_at = now(),
          review_notes = '已核对正文，但缺少可复现切片方式。'
        where id = $1
      `,
      [chunk.rows[0].id, text, reviewer.rows[0].id],
    ),
    /approved knowledge chunk requires versioned chunking evidence/i,
  );
});

test("R102：审核通过时机器原文必须等于按顺序拼接的来源摘录", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const sourceText = "OHF：设备过热";
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    sourceText,
  );
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R102-reviewer', '资料审核员-R102')
      returning id
    `,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        '模型擅自改写为：变频器已经损坏',
        'fault_definition',
        'information',
        'reference_only',
        'ai_proposed',
        'coordinator-agent',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId],
  );
  await database.query(
    `
      insert into knowledge_chunk_sources (
        knowledge_chunk_id,
        source_version_id,
        document_page_id,
        page_extraction_id,
        source_order,
        start_character,
        end_character,
        source_excerpt
      )
      values ($1, $2, $3, $4, 1, 1, $5, $6)
    `,
    [
      chunk.rows[0].id,
      sourceVersionId,
      source.documentPageId,
      source.pageExtractionId,
      Array.from(sourceText).length + 1,
      sourceText,
    ],
  );

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set
          review_status = 'approved',
          verified_text = $2,
          reviewed_by_user_id = $3,
          reviewed_at = now(),
          review_notes = '不能让模型改写冒充机器原文。'
        where id = $1
      `,
      [chunk.rows[0].id, sourceText, reviewer.rows[0].id],
    ),
    /original text must match ordered source excerpts/i,
  );
});

test("R103：多段来源的顺序必须从1开始连续编号后才能通过审核", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const firstText = "OHF：设备过热";
  const secondText = "如果原因已经消失，可手动复位。";
  const firstSource = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    firstText,
  );
  const secondSource = await createExtractedPage(
    database,
    sourceVersionId,
    310,
    secondText,
  );
  const reviewer = await database.query<{ id: number }>(
    `
      insert into users (external_subject, display_name)
      values ('idp|R103-reviewer', '资料审核员-R103')
      returning id
    `,
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (
        source_version_id,
        chunk_no,
        original_text,
        content_kind,
        source_severity,
        usage_policy,
        chunking_method,
        chunker_name,
        chunker_version
      )
      values (
        $1,
        1,
        $2,
        'diagnostic_context',
        'information',
        'reference_only',
        'manual_selection',
        'review-console',
        '1.0.0'
      )
      returning id
    `,
    [sourceVersionId, `${firstText}\n${secondText}`],
  );
  for (const [sourceOrder, source, excerpt] of [
    [1, firstSource, firstText],
    [3, secondSource, secondText],
  ] as const) {
    await database.query(
      `
        insert into knowledge_chunk_sources (
          knowledge_chunk_id,
          source_version_id,
          document_page_id,
          page_extraction_id,
          source_order,
          start_character,
          end_character,
          source_excerpt
        )
        values ($1, $2, $3, $4, $5, 1, $6, $7)
      `,
      [
        chunk.rows[0].id,
        sourceVersionId,
        source.documentPageId,
        source.pageExtractionId,
        sourceOrder,
        Array.from(excerpt).length + 1,
        excerpt,
      ],
    );
  }

  await assert.rejects(
    database.query(
      `
        update knowledge_chunks
        set
          review_status = 'approved',
          verified_text = original_text,
          reviewed_by_user_id = $2,
          reviewed_at = now(),
          review_notes = '来源编号有缺口，不能通过。'
        where id = $1
      `,
      [chunk.rows[0].id, reviewer.rows[0].id],
    ),
    /contiguous source order from 1/i,
  );
});

test("R104：旧来源关系没有精确范围时迁移必须明确阻断而不是猜测回填", async (context) => {
  const database = await openDatabaseThroughMigration(
    "013_trace_knowledge_chunks_to_page_extractions.sql",
  );
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const source = await createExtractedPage(
    database,
    sourceVersionId,
    72,
    "OHF：设备过热",
  );
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, 'OHF：设备过热')
      returning id
    `,
    [sourceVersionId],
  );
  await database.query(
    `
      insert into knowledge_chunk_sources (
        knowledge_chunk_id,
        source_version_id,
        document_page_id,
        page_extraction_id,
        source_order
      )
      values ($1, $2, $3, $4, 1)
    `,
    [
      chunk.rows[0].id,
      sourceVersionId,
      source.documentPageId,
      source.pageExtractionId,
    ],
  );
  const migrationSql = await readFile(
    new URL(
      "../database/migrations/014_record_exact_chunk_boundaries.sql",
      import.meta.url,
    ),
    "utf8",
  );

  await assert.rejects(
    database.exec(migrationSql),
    /existing chunk sources require explicit boundary backfill/i,
  );
  const columns = await database.query<{ column_exists: boolean }>(`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'knowledge_chunk_sources'
        and column_name = 'start_character'
    ) as column_exists
  `);
  assert.equal(columns.rows[0].column_exists, false);
});

test("R105：旧的未审核片段迁移后必须明确标为没有版本的历史切片", async (context) => {
  const database = await openDatabaseThroughMigration(
    "013_trace_knowledge_chunks_to_page_extractions.sql",
  );
  context.after(async () => database.close());
  const sourceVersionId = await seedOfficialSourceVersion(database);
  const chunk = await database.query<{ id: number }>(
    `
      insert into knowledge_chunks (source_version_id, chunk_no, original_text)
      values ($1, 1, '旧的未审核片段')
      returning id
    `,
    [sourceVersionId],
  );
  const migrationSql = await readFile(
    new URL(
      "../database/migrations/014_record_exact_chunk_boundaries.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await database.exec(migrationSql);

  const migrated = await database.query<{
    chunking_method: string;
    chunker_name: string | null;
    chunker_version: string | null;
  }>(
    `
      select chunking_method, chunker_name, chunker_version
      from knowledge_chunks
      where id = $1
    `,
    [chunk.rows[0].id],
  );
  assert.deepEqual(migrated.rows[0], {
    chunking_method: "legacy_unversioned",
    chunker_name: null,
    chunker_version: null,
  });
});
