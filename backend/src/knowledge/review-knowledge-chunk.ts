import type { PGliteInterface } from "@electric-sql/pglite";

type ContentKind =
  | "fault_definition"
  | "threshold"
  | "reset_condition"
  | "procedure"
  | "diagnostic_context"
  | "safety_warning"
  | "restricted_setting";

type SourceSeverity =
  | "information"
  | "notice"
  | "caution"
  | "warning"
  | "danger";

type UsagePolicy =
  | "reference_only"
  | "low_risk_guidance"
  | "engineer_only";

interface KnowledgeChunkReviewBase {
  knowledgeChunkId: number;
  authenticatedReviewerUserId: number;
}

export interface ApproveKnowledgeChunkInput extends KnowledgeChunkReviewBase {
  decision: "approve";
  corrections?: {
    verifiedText?: string;
    contentKind?: ContentKind;
    sourceSeverity?: SourceSeverity;
    usagePolicy?: UsagePolicy;
  };
  reviewNotes?: string;
}

export interface RejectKnowledgeChunkInput extends KnowledgeChunkReviewBase {
  decision: "reject";
  reviewNotes: string;
}

export interface ReviewedKnowledgeChunk {
  knowledgeChunkId: number;
  reviewStatus: "approved" | "rejected";
}

export async function reviewKnowledgeChunk(
  database: PGliteInterface,
  input: ApproveKnowledgeChunkInput | RejectKnowledgeChunkInput,
): Promise<ReviewedKnowledgeChunk> {
  return database.transaction(async (transaction) => {
    const candidate = await transaction.query<{
      id: number;
      original_text: string;
      content_kind: ContentKind | "unclassified";
      source_severity: SourceSeverity | "unclassified";
      usage_policy: UsagePolicy;
      review_status: string;
      product_family_id: number;
    }>(
      `
        select
          knowledge_chunk.id,
          knowledge_chunk.original_text,
          knowledge_chunk.content_kind,
          knowledge_chunk.source_severity,
          knowledge_chunk.usage_policy,
          knowledge_chunk.review_status,
          source_document.product_family_id
        from knowledge_chunks as knowledge_chunk
        join source_versions as source_version
          on source_version.id = knowledge_chunk.source_version_id
        join source_documents as source_document
          on source_document.id = source_version.source_document_id
        where knowledge_chunk.id = $1
        for update of knowledge_chunk
      `,
      [input.knowledgeChunkId],
    );
    if (candidate.rows.length !== 1) {
      throw new Error("knowledge chunk candidate not found");
    }
    if (candidate.rows[0].review_status !== "unreviewed") {
      throw new Error("knowledge chunk candidate has already been reviewed");
    }

    const reviewer = await transaction.query<{ id: number }>(
      `
        select reviewer.id
        from product_family_knowledge_reviewers as reviewer
        join users as reviewer_user
          on reviewer_user.id = reviewer.user_id
        where reviewer.product_family_id = $1
          and reviewer.user_id = $2
          and reviewer.is_active = true
          and reviewer_user.is_active = true
      `,
      [
        candidate.rows[0].product_family_id,
        input.authenticatedReviewerUserId,
      ],
    );
    if (reviewer.rows.length !== 1) {
      throw new Error(
        "authenticated user is not an active reviewer for this product family",
      );
    }

    if (input.decision === "reject") {
      if (input.reviewNotes.trim() === "") {
        throw new Error("review notes are required when rejecting a candidate");
      }
      await transaction.query(
        `
          update knowledge_chunks
          set
            review_status = 'rejected',
            reviewed_by_user_id = $2,
            reviewed_at = now(),
            review_notes = $3
          where id = $1
        `,
        [
          candidate.rows[0].id,
          input.authenticatedReviewerUserId,
          input.reviewNotes.trim(),
        ],
      );

      return {
        knowledgeChunkId: candidate.rows[0].id,
        reviewStatus: "rejected",
      };
    }

    const hasCorrections =
      input.corrections !== undefined &&
      Object.keys(input.corrections).length > 0;
    if (hasCorrections && !input.reviewNotes?.trim()) {
      throw new Error("review notes are required when correcting a candidate");
    }
    const corrections = input.corrections ?? {};
    const reviewNotes =
      input.reviewNotes?.trim() || "对照官方原文确认，无修改。";

    await transaction.query(
      `
        update knowledge_chunks
        set
          content_kind = $2,
          source_severity = $3,
          usage_policy = $4,
          review_status = 'approved',
          verified_text = $5,
          reviewed_by_user_id = $6,
          reviewed_at = now(),
          review_notes = $7
        where id = $1
      `,
      [
        candidate.rows[0].id,
        corrections.contentKind ?? candidate.rows[0].content_kind,
        corrections.sourceSeverity ?? candidate.rows[0].source_severity,
        corrections.usagePolicy ?? candidate.rows[0].usage_policy,
        corrections.verifiedText ?? candidate.rows[0].original_text,
        input.authenticatedReviewerUserId,
        reviewNotes,
      ],
    );

    return {
      knowledgeChunkId: candidate.rows[0].id,
      reviewStatus: "approved",
    };
  });
}
