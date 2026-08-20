import type { PGliteInterface } from "@electric-sql/pglite";

import type { PassageEmbedder } from "./index-approved-knowledge-chunk.ts";
import { isKeywordRankingConfident } from "./keyword-confidence.ts";
import {
  buildSearchTerms,
  SEARCH_ANALYZER_NAME,
  SEARCH_ANALYZER_VERSION,
} from "./lexical-terms.ts";

export interface QueryEmbedder extends PassageEmbedder {
  embedQuery(text: string): Promise<number[]>;
}

export interface RetrievalHit {
  knowledgeChunkId: number;
  verifiedText: string;
  faultCode: string | null;
  contentKind: string;
  sourceSeverity: string;
  usagePolicy: string;
  keywordScore?: number;
  vectorSimilarity?: number;
  fusionScore?: number;
  matchedBy?: Array<"keyword" | "vector">;
}

interface PersistedHit {
  knowledge_chunk_id: number;
  verified_text: string;
  fault_code: string | null;
  content_kind: string;
  source_severity: string;
  usage_policy: string;
}

function toHit(row: PersistedHit): RetrievalHit {
  return {
    knowledgeChunkId: row.knowledge_chunk_id,
    verifiedText: row.verified_text,
    faultCode: row.fault_code,
    contentKind: row.content_kind,
    sourceSeverity: row.source_severity,
    usagePolicy: row.usage_policy,
  };
}

export function reciprocalRankFusion(
  keyword: RetrievalHit[],
  vector: RetrievalHit[],
  limit: number,
  rankConstant = 60,
): RetrievalHit[] {
  const fused = new Map<
    number,
    { hit: RetrievalHit; score: number; keywordRank?: number; vectorRank?: number }
  >();
  const addRanking = (
    hits: RetrievalHit[],
    channel: "keyword" | "vector",
  ): void => {
    hits.forEach((hit, index) => {
      const current = fused.get(hit.knowledgeChunkId) ?? {
        hit,
        score: 0,
      };
      current.score += 1 / (rankConstant + index + 1);
      if (channel === "keyword") current.keywordRank = index + 1;
      if (channel === "vector") current.vectorRank = index + 1;
      fused.set(hit.knowledgeChunkId, current);
    });
  };
  addRanking(keyword, "keyword");
  addRanking(vector, "vector");

  return [...fused.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftBest = Math.min(
        left.keywordRank ?? Number.POSITIVE_INFINITY,
        left.vectorRank ?? Number.POSITIVE_INFINITY,
      );
      const rightBest = Math.min(
        right.keywordRank ?? Number.POSITIVE_INFINITY,
        right.vectorRank ?? Number.POSITIVE_INFINITY,
      );
      return leftBest - rightBest || left.hit.knowledgeChunkId - right.hit.knowledgeChunkId;
    })
    .slice(0, limit)
    .map(({ hit, score, keywordRank, vectorRank }) => ({
      ...hit,
      fusionScore: score,
      matchedBy: [
        ...(keywordRank === undefined ? [] : (["keyword"] as const)),
        ...(vectorRank === undefined ? [] : (["vector"] as const)),
      ],
    }));
}

export async function searchApprovedKnowledge(
  database: PGliteInterface,
  input: {
    productFamilyId: number;
    queryText: string;
    embedder: QueryEmbedder;
    limit?: number;
  },
): Promise<{
  keyword: RetrievalHit[];
  vector: RetrievalHit[];
  hybrid: RetrievalHit[];
}> {
  const queryText = input.queryText.trim();
  if (queryText === "") throw new Error("search query must not be blank");
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("search limit must be an integer from 1 to 20");
  }
  const candidateLimit = Math.max(limit * 4, 20);
  const queryTerms = [
    ...new Set(buildSearchTerms({ text: queryText }).map((term) => term.term)),
  ];
  const queryEmbedding = await input.embedder.embedQuery(queryText);
  if (
    queryEmbedding.length !== input.embedder.dimensions ||
    queryEmbedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("embedder returned an invalid query vector");
  }
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  let keyword: RetrievalHit[] = [];
  if (queryTerms.length > 0) {
    const rows = await database.query<
      PersistedHit & { keyword_score: number }
    >(
      `
        select
          knowledge_chunk.id as knowledge_chunk_id,
          knowledge_chunk.verified_text,
          knowledge_chunk.fault_code,
          knowledge_chunk.content_kind,
          knowledge_chunk.source_severity,
          knowledge_chunk.usage_policy,
          sum(
            case search_term.term_kind
              when 'fault_code' then 8
              when 'ascii_token' then 3
              else 1
            end
          )::double precision as keyword_score
        from knowledge_chunk_search_terms as search_term
        join knowledge_chunks as knowledge_chunk
          on knowledge_chunk.id = search_term.knowledge_chunk_id
        join source_versions as source_version
          on source_version.id = knowledge_chunk.source_version_id
        join source_documents as source_document
          on source_document.id = source_version.source_document_id
        where source_document.product_family_id = $1
          and source_version.version_status = 'current'
          and knowledge_chunk.review_status = 'approved'
          and search_term.analyzer_name = $2
          and search_term.analyzer_version = $3
          and search_term.term = any($4::text[])
        group by knowledge_chunk.id
        order by keyword_score desc, knowledge_chunk.id
        limit $5
      `,
      [
        input.productFamilyId,
        SEARCH_ANALYZER_NAME,
        SEARCH_ANALYZER_VERSION,
        queryTerms,
        candidateLimit,
      ],
    );
    keyword = rows.rows.slice(0, limit).map((row) => ({
      ...toHit(row),
      keywordScore: row.keyword_score,
    }));
  }

  const vectorRows = await database.query<
    PersistedHit & { vector_similarity: number }
  >(
    `
      select
        knowledge_chunk.id as knowledge_chunk_id,
        knowledge_chunk.verified_text,
        knowledge_chunk.fault_code,
        knowledge_chunk.content_kind,
        knowledge_chunk.source_severity,
        knowledge_chunk.usage_policy,
        (1 - (chunk_embedding.embedding <=> $4::vector))::double precision
          as vector_similarity
      from knowledge_chunk_embeddings as chunk_embedding
      join knowledge_chunks as knowledge_chunk
        on knowledge_chunk.id = chunk_embedding.knowledge_chunk_id
      join source_versions as source_version
        on source_version.id = knowledge_chunk.source_version_id
      join source_documents as source_document
        on source_document.id = source_version.source_document_id
      where source_document.product_family_id = $1
        and source_version.version_status = 'current'
        and knowledge_chunk.review_status = 'approved'
        and chunk_embedding.model_id = $2
        and chunk_embedding.model_revision = $3
        and chunk_embedding.embedding_dimensions = $5
        and chunk_embedding.is_normalized = true
      order by chunk_embedding.embedding <=> $4::vector, knowledge_chunk.id
      limit $6
    `,
    [
      input.productFamilyId,
      input.embedder.modelId,
      input.embedder.modelRevision,
      vectorLiteral,
      input.embedder.dimensions,
      candidateLimit,
    ],
  );
  const vector = vectorRows.rows.slice(0, limit).map((row) => ({
    ...toHit(row),
    vectorSimilarity: row.vector_similarity,
  }));
  const confidentKeyword = isKeywordRankingConfident(
    keyword.map(({ keywordScore }) => keywordScore ?? 0),
  )
    ? keyword
    : [];

  return {
    keyword,
    vector,
    hybrid: reciprocalRankFusion(confidentKeyword, vector, limit),
  };
}
