import type { PGliteInterface } from "@electric-sql/pglite";

export interface CreateKnowledgeChunkCandidateInput {
  sourceVersionId: number;
  contentKind:
    | "fault_definition"
    | "threshold"
    | "reset_condition"
    | "procedure"
    | "diagnostic_context"
    | "safety_warning"
    | "restricted_setting";
  sourceSeverity:
    | "information"
    | "notice"
    | "caution"
    | "warning"
    | "danger";
  usagePolicy: "reference_only" | "low_risk_guidance" | "engineer_only";
  faultCode?: string;
  sectionTitle?: string;
  chunkingMethod: "manual_selection" | "structure_rule" | "ai_proposed";
  chunkerName: string;
  chunkerVersion: string;
  sources: Array<{
    pageExtractionId: number;
    excerpt: string;
  }>;
}

export interface CreatedKnowledgeChunkCandidate {
  knowledgeChunkId: number;
  originalText: string;
  reviewStatus: "unreviewed";
  sourceCount: number;
}

export async function createKnowledgeChunkCandidate(
  database: PGliteInterface,
  input: CreateKnowledgeChunkCandidateInput,
): Promise<CreatedKnowledgeChunkCandidate> {
  if (input.sources.length === 0) {
    throw new Error("at least one page excerpt is required");
  }

  return database.transaction(async (transaction) => {
    const resolvedSources: Array<{
      pageExtractionId: number;
      documentPageId: number;
      pdfPageNumber: number;
      excerpt: string;
      startCharacter: number;
      endCharacter: number;
    }> = [];
    for (const proposedSource of input.sources) {
      const source = await transaction.query<{
        page_extraction_id: number;
        document_page_id: number;
        pdf_page_number: number;
        extracted_text: string | null;
      }>(
        `
          select
            page_extraction.id as page_extraction_id,
            document_page.id as document_page_id,
            document_page.pdf_page_number,
            page_extraction.extracted_text
          from page_extractions as page_extraction
          join document_pages as document_page
            on document_page.id = page_extraction.document_page_id
          where page_extraction.id = $1
            and document_page.source_version_id = $2
            and page_extraction.extraction_status = 'extracted'
        `,
        [proposedSource.pageExtractionId, input.sourceVersionId],
      );
      if (source.rows.length !== 1 || source.rows[0].extracted_text === null) {
        throw new Error("candidate source extraction not found");
      }

      const pageCharacters = Array.from(source.rows[0].extracted_text);
      const excerptCharacters = Array.from(proposedSource.excerpt);
      const startIndex = pageCharacters.findIndex((_, index) =>
        excerptCharacters.every(
          (character, offset) => pageCharacters[index + offset] === character,
        ),
      );
      if (startIndex === -1) {
        throw new Error("proposed excerpt was not found in page extraction");
      }
      const secondStartIndex = pageCharacters.findIndex(
        (_, index) =>
          index > startIndex &&
          excerptCharacters.every(
            (character, offset) =>
              pageCharacters[index + offset] === character,
          ),
      );
      if (secondStartIndex !== -1) {
        throw new Error(
          "proposed excerpt occurs more than once in page extraction",
        );
      }

      resolvedSources.push({
        pageExtractionId: source.rows[0].page_extraction_id,
        documentPageId: source.rows[0].document_page_id,
        pdfPageNumber: source.rows[0].pdf_page_number,
        excerpt: proposedSource.excerpt,
        startCharacter: startIndex + 1,
        endCharacter: startIndex + excerptCharacters.length + 1,
      });
    }
    const originalText = resolvedSources
      .map((source) => source.excerpt)
      .join("\n");

    const nextChunkNumber = await transaction.query<{ chunk_no: number }>(
      `
        select coalesce(max(chunk_no), 0) + 1 as chunk_no
        from knowledge_chunks
        where source_version_id = $1
      `,
      [input.sourceVersionId],
    );
    const chunk = await transaction.query<{ id: number }>(
      `
        insert into knowledge_chunks (
          source_version_id,
          chunk_no,
          original_text,
          page_number,
          section_title,
          fault_code,
          content_kind,
          source_severity,
          usage_policy,
          chunking_method,
          chunker_name,
          chunker_version
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning id
      `,
      [
        input.sourceVersionId,
        nextChunkNumber.rows[0].chunk_no,
        originalText,
        resolvedSources[0].pdfPageNumber,
        input.sectionTitle ?? null,
        input.faultCode ?? null,
        input.contentKind,
        input.sourceSeverity,
        input.usagePolicy,
        input.chunkingMethod,
        input.chunkerName,
        input.chunkerVersion,
      ],
    );
    for (const [index, source] of resolvedSources.entries()) {
      await transaction.query(
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
        `,
        [
          chunk.rows[0].id,
          input.sourceVersionId,
          source.documentPageId,
          source.pageExtractionId,
          index + 1,
          source.startCharacter,
          source.endCharacter,
          source.excerpt,
        ],
      );
    }

    return {
      knowledgeChunkId: chunk.rows[0].id,
      originalText,
      reviewStatus: "unreviewed",
      sourceCount: resolvedSources.length,
    };
  });
}
