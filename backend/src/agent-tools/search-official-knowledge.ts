import type { PGliteInterface } from "@electric-sql/pglite";

import { isKeywordRankingConfident } from "../retrieval/keyword-confidence.ts";
import {
  SEARCH_ANALYZER_NAME,
  SEARCH_ANALYZER_VERSION,
} from "../retrieval/lexical-terms.ts";
import {
  searchApprovedKnowledge,
  type QueryEmbedder,
  type RetrievalHit,
} from "../retrieval/search-approved-knowledge.ts";
import { hasConflictingAtvProductFamily } from "../retrieval/product-scope.ts";

const FUSION_STRATEGY = "confidence-gated-rrf";
const FUSION_STRATEGY_VERSION = "1.1.0";
const SEARCHABLE_WORK_ORDER_STATUSES = new Set([
  "draft",
  "investigating",
  "awaiting_information",
]);

interface WorkOrderSearchScope {
  work_order_id: number;
  factory_id: number;
  equipment_id: number;
  equipment_model_id: number;
  product_family_id: number;
  product_family_code: string;
  status: string;
  model_is_active: boolean;
  family_is_active: boolean;
  requester_is_authorized: boolean;
}

interface PersistedSearchRun {
  id: number;
  work_order_id: number;
  factory_id: number;
  equipment_id: number;
  equipment_model_id: number;
  product_family_id: number;
  requester_membership_id: number;
  query_text: string;
  requested_limit: number;
  idempotency_key: string;
  model_id: string;
  model_revision: string;
  embedding_dimensions: number;
  pooling_method: "mean";
  is_normalized: boolean;
  analyzer_name: string;
  analyzer_version: string;
  fusion_strategy: string;
  keyword_participated_in_fusion: boolean;
}

interface PersistedSearchHit {
  knowledge_chunk_id: number;
  verified_text: string;
  fault_code: string | null;
  content_kind: string;
  source_severity: string;
  usage_policy: string;
  result_rank: number;
  keyword_rank: number | null;
  keyword_score: number | null;
  vector_rank: number | null;
  vector_similarity: number | null;
  fusion_score: number;
}

export interface OfficialKnowledgeEvidence {
  knowledgeChunkId: number;
  verifiedText: string;
  faultCode: string | null;
  contentKind: string;
  sourceSeverity: string;
  usagePolicy: string;
  resultRank: number;
  keywordRank: number | null;
  keywordScore: number | null;
  vectorRank: number | null;
  vectorSimilarity: number | null;
  fusionScore: number;
  matchedBy: Array<"keyword" | "vector">;
  citations: OfficialKnowledgeCitation[];
}

export interface OfficialKnowledgeCitation {
  sourceOrder: number;
  publisher: string;
  title: string;
  documentReference: string;
  officialUrl: string;
  versionLabel: string;
  documentIssueLabel: string | null;
  languageCode: string;
  sourceVersionSha256: string;
  pdfPageNumber: number;
  startCharacter: number;
  endCharacter: number;
  sourceExcerpt: string;
}

type EvidenceWithoutCitations = Omit<OfficialKnowledgeEvidence, "citations">;

interface PersistedCitation {
  knowledge_chunk_id: number;
  source_order: number;
  publisher: string;
  title: string;
  document_reference: string;
  official_url: string;
  version_label: string;
  document_issue_label: string | null;
  language_code: string;
  source_version_sha256: string;
  pdf_page_number: number;
  start_character: number;
  end_character: number;
  source_excerpt: string;
}

export interface OfficialKnowledgeSearchResult {
  searchRunId: number;
  workOrderId: number;
  factoryId: number;
  equipmentId: number;
  equipmentModelId: number;
  productFamilyId: number;
  queryText: string;
  keywordParticipatedInFusion: boolean;
  hits: OfficialKnowledgeEvidence[];
}

export interface SearchOfficialKnowledgeInput {
  workOrderId: number;
  requesterMembershipId: number;
  queryText: string;
  idempotencyKey: string;
  embedder: QueryEmbedder;
  limit?: number;
}

async function loadAuthorizedScope(
  database: PGliteInterface,
  input: Pick<
    SearchOfficialKnowledgeInput,
    "workOrderId" | "requesterMembershipId"
  >,
): Promise<WorkOrderSearchScope> {
  const scope = await database.query<WorkOrderSearchScope>(
    `
      select
        work_order.id as work_order_id,
        work_order.factory_id,
        work_order.equipment_id,
        equipment.equipment_model_id,
        equipment_model.product_family_id,
        product_family.family_code as product_family_code,
        work_order.status,
        equipment_model.is_active as model_is_active,
        product_family.is_active as family_is_active,
        (
          requester_membership.id is not null
          and requester_user.id is not null
        ) as requester_is_authorized
      from work_orders as work_order
      join equipment
        on equipment.id = work_order.equipment_id
       and equipment.factory_id = work_order.factory_id
      join equipment_models as equipment_model
        on equipment_model.id = equipment.equipment_model_id
      join product_families as product_family
        on product_family.id = equipment_model.product_family_id
      left join factory_memberships as requester_membership
        on requester_membership.id = $2
       and requester_membership.factory_id = work_order.factory_id
       and requester_membership.is_active = true
      left join users as requester_user
        on requester_user.id = requester_membership.user_id
       and requester_user.is_active = true
      where work_order.id = $1
    `,
    [input.workOrderId, input.requesterMembershipId],
  );
  if (scope.rows.length !== 1) throw new Error("work order not found");
  const current = scope.rows[0];
  if (!current.requester_is_authorized) {
    throw new Error("active membership for the work order factory is required");
  }
  if (!current.model_is_active || !current.family_is_active) {
    throw new Error("active equipment model and product family are required");
  }
  if (!SEARCHABLE_WORK_ORDER_STATUSES.has(current.status)) {
    throw new Error("work order status does not allow agent knowledge search");
  }
  return current;
}

async function findPersistedRun(
  database: PGliteInterface,
  workOrderId: number,
  idempotencyKey: string,
): Promise<PersistedSearchRun | null> {
  const result = await database.query<PersistedSearchRun>(
    `
      select *
      from knowledge_search_runs
      where work_order_id = $1
        and idempotency_key = $2
    `,
    [workOrderId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function requestMatchesPersistedRun(
  run: PersistedSearchRun,
  scope: WorkOrderSearchScope,
  input: SearchOfficialKnowledgeInput,
  queryText: string,
  limit: number,
): boolean {
  return (
    run.factory_id === scope.factory_id &&
    run.equipment_id === scope.equipment_id &&
    run.equipment_model_id === scope.equipment_model_id &&
    run.product_family_id === scope.product_family_id &&
    run.requester_membership_id === input.requesterMembershipId &&
    run.query_text === queryText &&
    run.requested_limit === limit &&
    run.model_id === input.embedder.modelId &&
    run.model_revision === input.embedder.modelRevision &&
    run.embedding_dimensions === input.embedder.dimensions &&
    run.pooling_method === input.embedder.poolingMethod &&
    run.is_normalized === input.embedder.isNormalized &&
    run.analyzer_name === SEARCH_ANALYZER_NAME &&
    run.analyzer_version === SEARCH_ANALYZER_VERSION &&
    run.fusion_strategy === `${FUSION_STRATEGY}@${FUSION_STRATEGY_VERSION}`
  );
}

function matchedBy(
  keywordParticipatedInFusion: boolean,
  keywordRank: number | null,
  vectorRank: number | null,
): Array<"keyword" | "vector"> {
  return [
    ...(keywordParticipatedInFusion && keywordRank !== null
      ? (["keyword"] as const)
      : []),
    ...(vectorRank !== null ? (["vector"] as const) : []),
  ];
}

function toEvidence(
  row: PersistedSearchHit,
  keywordParticipatedInFusion: boolean,
): EvidenceWithoutCitations {
  return {
    knowledgeChunkId: row.knowledge_chunk_id,
    verifiedText: row.verified_text,
    faultCode: row.fault_code,
    contentKind: row.content_kind,
    sourceSeverity: row.source_severity,
    usagePolicy: row.usage_policy,
    resultRank: row.result_rank,
    keywordRank: row.keyword_rank,
    keywordScore: row.keyword_score,
    vectorRank: row.vector_rank,
    vectorSimilarity: row.vector_similarity,
    fusionScore: row.fusion_score,
    matchedBy: matchedBy(
      keywordParticipatedInFusion,
      row.keyword_rank,
      row.vector_rank,
    ),
  };
}

async function attachCitations(
  database: PGliteInterface,
  hits: EvidenceWithoutCitations[],
): Promise<OfficialKnowledgeEvidence[]> {
  if (hits.length === 0) return [];
  const citations = await database.query<PersistedCitation>(
    `
      select
        chunk_source.knowledge_chunk_id,
        chunk_source.source_order,
        source_document.publisher,
        source_document.title,
        source_document.document_reference,
        source_document.official_url,
        source_version.version_label,
        source_version.document_issue_label,
        source_version.language_code,
        source_version.sha256 as source_version_sha256,
        document_page.pdf_page_number,
        chunk_source.start_character,
        chunk_source.end_character,
        chunk_source.source_excerpt
      from knowledge_chunk_sources as chunk_source
      join source_versions as source_version
        on source_version.id = chunk_source.source_version_id
      join source_documents as source_document
        on source_document.id = source_version.source_document_id
      join document_pages as document_page
        on document_page.id = chunk_source.document_page_id
      where chunk_source.knowledge_chunk_id = any($1::bigint[])
      order by chunk_source.knowledge_chunk_id, chunk_source.source_order
    `,
    [hits.map(({ knowledgeChunkId }) => knowledgeChunkId)],
  );
  const byChunk = new Map<number, OfficialKnowledgeCitation[]>();
  for (const citation of citations.rows) {
    const current = byChunk.get(citation.knowledge_chunk_id) ?? [];
    current.push({
      sourceOrder: citation.source_order,
      publisher: citation.publisher,
      title: citation.title,
      documentReference: citation.document_reference,
      officialUrl: citation.official_url,
      versionLabel: citation.version_label,
      documentIssueLabel: citation.document_issue_label,
      languageCode: citation.language_code,
      sourceVersionSha256: citation.source_version_sha256,
      pdfPageNumber: citation.pdf_page_number,
      startCharacter: citation.start_character,
      endCharacter: citation.end_character,
      sourceExcerpt: citation.source_excerpt,
    });
    byChunk.set(citation.knowledge_chunk_id, current);
  }
  return hits.map((hit) => ({
    ...hit,
    citations: byChunk.get(hit.knowledgeChunkId) ?? [],
  }));
}

async function readPersistedResult(
  database: PGliteInterface,
  run: PersistedSearchRun,
): Promise<OfficialKnowledgeSearchResult> {
  const hits = await database.query<PersistedSearchHit>(
    `
      select
        search_hit.knowledge_chunk_id,
        knowledge_chunk.verified_text,
        knowledge_chunk.fault_code,
        knowledge_chunk.content_kind,
        knowledge_chunk.source_severity,
        knowledge_chunk.usage_policy,
        search_hit.result_rank,
        search_hit.keyword_rank,
        search_hit.keyword_score,
        search_hit.vector_rank,
        search_hit.vector_similarity,
        search_hit.fusion_score
      from knowledge_search_hits as search_hit
      join knowledge_chunks as knowledge_chunk
        on knowledge_chunk.id = search_hit.knowledge_chunk_id
      where search_hit.search_run_id = $1
      order by search_hit.result_rank
    `,
    [run.id],
  );
  return {
    searchRunId: run.id,
    workOrderId: run.work_order_id,
    factoryId: run.factory_id,
    equipmentId: run.equipment_id,
    equipmentModelId: run.equipment_model_id,
    productFamilyId: run.product_family_id,
    queryText: run.query_text,
    keywordParticipatedInFusion: run.keyword_participated_in_fusion,
    hits: await attachCitations(
      database,
      hits.rows.map((row) =>
        toEvidence(row, run.keyword_participated_in_fusion),
      ),
    ),
  };
}

function prepareEvidence(
  hybrid: RetrievalHit[],
  keyword: RetrievalHit[],
  vector: RetrievalHit[],
  keywordParticipatedInFusion: boolean,
): EvidenceWithoutCitations[] {
  return hybrid.map((hit, resultIndex) => {
    const keywordIndex = keyword.findIndex(
      ({ knowledgeChunkId }) => knowledgeChunkId === hit.knowledgeChunkId,
    );
    const vectorIndex = vector.findIndex(
      ({ knowledgeChunkId }) => knowledgeChunkId === hit.knowledgeChunkId,
    );
    const keywordHit = keywordIndex === -1 ? null : keyword[keywordIndex];
    const vectorHit = vectorIndex === -1 ? null : vector[vectorIndex];
    const keywordRank = keywordIndex === -1 ? null : keywordIndex + 1;
    const vectorRank = vectorIndex === -1 ? null : vectorIndex + 1;
    return {
      knowledgeChunkId: hit.knowledgeChunkId,
      verifiedText: hit.verifiedText,
      faultCode: hit.faultCode,
      contentKind: hit.contentKind,
      sourceSeverity: hit.sourceSeverity,
      usagePolicy: hit.usagePolicy,
      resultRank: resultIndex + 1,
      keywordRank,
      keywordScore: keywordHit?.keywordScore ?? null,
      vectorRank,
      vectorSimilarity: vectorHit?.vectorSimilarity ?? null,
      fusionScore: hit.fusionScore ?? 0,
      matchedBy: matchedBy(
        keywordParticipatedInFusion,
        keywordRank,
        vectorRank,
      ),
    };
  });
}

async function insertEvidenceBatch(
  database: PGliteInterface,
  searchRunId: number,
  hits: OfficialKnowledgeEvidence[],
): Promise<void> {
  if (hits.length === 0) return;
  const values: unknown[] = [];
  const rows = hits.map((hit, rowIndex) => {
    const offset = rowIndex * 8;
    values.push(
      searchRunId,
      hit.knowledgeChunkId,
      hit.resultRank,
      hit.keywordRank,
      hit.keywordScore,
      hit.vectorRank,
      hit.vectorSimilarity,
      hit.fusionScore,
    );
    return `(${Array.from({ length: 8 }, (_, index) => `$${offset + index + 1}`).join(", ")})`;
  });
  await database.query(
    `
      insert into knowledge_search_hits (
        search_run_id,
        knowledge_chunk_id,
        result_rank,
        keyword_rank,
        keyword_score,
        vector_rank,
        vector_similarity,
        fusion_score
      )
      values ${rows.join(",\n")}
    `,
    values,
  );
}

export async function searchOfficialKnowledge(
  database: PGliteInterface,
  input: SearchOfficialKnowledgeInput,
): Promise<OfficialKnowledgeSearchResult> {
  const queryText = input.queryText.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const limit = input.limit ?? 5;
  if (queryText === "") throw new Error("search query must not be blank");
  if (idempotencyKey === "") throw new Error("idempotency key must not be blank");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("search limit must be an integer from 1 to 20");
  }

  const scope = await loadAuthorizedScope(database, input);
  const existing = await findPersistedRun(
    database,
    input.workOrderId,
    idempotencyKey,
  );
  if (existing) {
    if (!requestMatchesPersistedRun(existing, scope, input, queryText, limit)) {
      throw new Error("idempotency key was already used for a different search");
    }
    return readPersistedResult(database, existing);
  }

  const productScopeConflict = hasConflictingAtvProductFamily(
    queryText,
    scope.product_family_code,
  );
  const retrieval = productScopeConflict
    ? { keyword: [], vector: [], hybrid: [] }
    : await searchApprovedKnowledge(database, {
        productFamilyId: scope.product_family_id,
        queryText,
        embedder: input.embedder,
        limit,
      });
  const keywordParticipatedInFusion = isKeywordRankingConfident(
    retrieval.keyword.map(({ keywordScore }) => keywordScore ?? 0),
  );
  const preparedHits = await attachCitations(
    database,
    prepareEvidence(
      retrieval.hybrid,
      retrieval.keyword,
      retrieval.vector,
      keywordParticipatedInFusion,
    ),
  );

  return database.transaction(async (transaction) => {
    let currentScope: WorkOrderSearchScope;
    try {
      currentScope = await loadAuthorizedScope(transaction, input);
    } catch {
      throw new Error(
        "authorization or equipment scope changed while search was running",
      );
    }
    if (
      currentScope.factory_id !== scope.factory_id ||
      currentScope.equipment_id !== scope.equipment_id ||
      currentScope.equipment_model_id !== scope.equipment_model_id ||
      currentScope.product_family_id !== scope.product_family_id
    ) {
      throw new Error(
        "authorization or equipment scope changed while search was running",
      );
    }

    const racedExisting = await findPersistedRun(
      transaction,
      input.workOrderId,
      idempotencyKey,
    );
    if (racedExisting) {
      if (
        !requestMatchesPersistedRun(
          racedExisting,
          currentScope,
          input,
          queryText,
          limit,
        )
      ) {
        throw new Error("idempotency key was already used for a different search");
      }
      return readPersistedResult(transaction, racedExisting);
    }

    const run = await transaction.query<PersistedSearchRun>(
      `
        insert into knowledge_search_runs (
          work_order_id,
          factory_id,
          equipment_id,
          equipment_model_id,
          product_family_id,
          requester_membership_id,
          query_text,
          requested_limit,
          idempotency_key,
          model_id,
          model_revision,
          embedding_dimensions,
          pooling_method,
          is_normalized,
          analyzer_name,
          analyzer_version,
          fusion_strategy,
          keyword_participated_in_fusion
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18
        )
        returning *
      `,
      [
        currentScope.work_order_id,
        currentScope.factory_id,
        currentScope.equipment_id,
        currentScope.equipment_model_id,
        currentScope.product_family_id,
        input.requesterMembershipId,
        queryText,
        limit,
        idempotencyKey,
        input.embedder.modelId,
        input.embedder.modelRevision,
        input.embedder.dimensions,
        input.embedder.poolingMethod,
        input.embedder.isNormalized,
        SEARCH_ANALYZER_NAME,
        SEARCH_ANALYZER_VERSION,
        `${FUSION_STRATEGY}@${FUSION_STRATEGY_VERSION}`,
        keywordParticipatedInFusion,
      ],
    );
    await insertEvidenceBatch(transaction, run.rows[0].id, preparedHits);
    await transaction.query(
      `
        insert into work_order_events (
          work_order_id,
          factory_id,
          event_type,
          actor_kind,
          actor_membership_id,
          content,
          details,
          idempotency_key,
          knowledge_search_run_id
        )
        values (
          $1,
          $2,
          'knowledge_searched',
          'agent',
          null,
          '协调助手检索了当前设备适用的官方资料。',
          $3::jsonb,
          $4,
          $5
        )
      `,
      [
        currentScope.work_order_id,
        currentScope.factory_id,
        JSON.stringify({
          searchRunId: run.rows[0].id,
          resultCount: preparedHits.length,
          productFamilyId: currentScope.product_family_id,
        }),
        `search_official_knowledge:${idempotencyKey}`,
        run.rows[0].id,
      ],
    );

    return {
      searchRunId: run.rows[0].id,
      workOrderId: currentScope.work_order_id,
      factoryId: currentScope.factory_id,
      equipmentId: currentScope.equipment_id,
      equipmentModelId: currentScope.equipment_model_id,
      productFamilyId: currentScope.product_family_id,
      queryText,
      keywordParticipatedInFusion,
      hits: preparedHits,
    };
  });
}
