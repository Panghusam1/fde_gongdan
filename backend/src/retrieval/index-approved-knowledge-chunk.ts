import { createHash } from "node:crypto";

import type { PGliteInterface } from "@electric-sql/pglite";

import {
  buildSearchTerms,
  SEARCH_ANALYZER_NAME,
  SEARCH_ANALYZER_VERSION,
} from "./lexical-terms.ts";

export interface PassageEmbedder {
  modelId: string;
  modelRevision: string;
  dimensions: number;
  poolingMethod: "mean";
  isNormalized: true;
  embedPassage(text: string): Promise<number[]>;
}

export async function indexApprovedKnowledgeChunk(
  database: PGliteInterface,
  input: {
    knowledgeChunkId: number;
    embedder: PassageEmbedder;
  },
): Promise<{ knowledgeChunkId: number; termCount: number }> {
  const candidate = await database.query<{
    id: number;
    verified_text: string | null;
    section_title: string | null;
    fault_code: string | null;
    review_status: string;
  }>(
    `
      select id, verified_text, section_title, fault_code, review_status
      from knowledge_chunks
      where id = $1
    `,
    [input.knowledgeChunkId],
  );
  if (
    candidate.rows.length !== 1 ||
    candidate.rows[0].review_status !== "approved" ||
    candidate.rows[0].verified_text === null
  ) {
    throw new Error("only an approved knowledge chunk can be indexed");
  }

  const verifiedText = candidate.rows[0].verified_text;
  const embedding = await input.embedder.embedPassage(verifiedText);
  if (
    embedding.length !== input.embedder.dimensions ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("embedder returned an invalid vector dimension or value");
  }
  const norm = Math.sqrt(
    embedding.reduce((total, value) => total + value * value, 0),
  );
  if (Math.abs(norm - 1) > 0.001) {
    throw new Error("embedder declared normalized output but vector norm is not 1");
  }
  const terms = buildSearchTerms({
    text: verifiedText,
    sectionTitle: candidate.rows[0].section_title,
    faultCode: candidate.rows[0].fault_code,
  });
  const inputSha256 = createHash("sha256").update(verifiedText).digest("hex");
  const vectorLiteral = `[${embedding.join(",")}]`;

  await database.transaction(async (transaction) => {
    const current = await transaction.query<{
      verified_text: string | null;
      review_status: string;
    }>(
      `
        select verified_text, review_status
        from knowledge_chunks
        where id = $1
        for update
      `,
      [input.knowledgeChunkId],
    );
    if (
      current.rows.length !== 1 ||
      current.rows[0].review_status !== "approved" ||
      current.rows[0].verified_text !== verifiedText
    ) {
      throw new Error("knowledge chunk changed before indexing completed");
    }

    for (const term of terms) {
      await transaction.query(
        `
          insert into knowledge_chunk_search_terms (
            knowledge_chunk_id,
            analyzer_name,
            analyzer_version,
            term_kind,
            term
          )
          values ($1, $2, $3, $4, $5)
          on conflict do nothing
        `,
        [
          input.knowledgeChunkId,
          SEARCH_ANALYZER_NAME,
          SEARCH_ANALYZER_VERSION,
          term.kind,
          term.term,
        ],
      );
    }
    await transaction.query(
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
        values ($1, $2, $3, $4, $5, 'passage: ', $6, $7, $8, $9::vector)
        on conflict do nothing
      `,
      [
        input.knowledgeChunkId,
        input.embedder.modelId,
        input.embedder.modelRevision,
        input.embedder.poolingMethod,
        input.embedder.isNormalized,
        verifiedText,
        inputSha256,
        input.embedder.dimensions,
        vectorLiteral,
      ],
    );
  });

  return { knowledgeChunkId: input.knowledgeChunkId, termCount: terms.length };
}
