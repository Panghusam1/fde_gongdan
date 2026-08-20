import type { PGliteInterface } from "@electric-sql/pglite";

import type {
  AnswerabilityCandidate,
  AnswerabilityDecision,
  QwenAnswerabilityJudge,
} from "../evaluation/qwen-answerability-judge.ts";

export type WorkOrderEvidenceVerdict =
  | "directly_answerable"
  | "partially_related"
  | "not_answerable"
  | "judge_error";

export interface AssessWorkOrderEvidenceInput {
  workOrderId: number;
  requesterMembershipId: number;
  searchRunId: number;
  idempotencyKey: string;
  judge: QwenAnswerabilityJudge;
}

export interface WorkOrderEvidenceAssessmentResult {
  evidenceAssessmentId: number;
  workOrderId: number;
  searchRunId: number;
  verdict: WorkOrderEvidenceVerdict;
  decisionSource: "model" | "program_no_candidates" | "model_error";
  selectedSearchHitId: number | null;
  selectedKnowledgeChunkId: number | null;
  selectedChunkSourceId: number | null;
  sourcePageNumber: number | null;
  supportingQuote: string | null;
  reason: string;
  modelId: string;
  promptVersion: string;
  candidateCount: number;
}

interface EvidenceScope {
  work_order_id: number;
  factory_id: number;
  equipment_id: number;
  status: string;
  query_text: string;
  requester_is_authorized: boolean;
}

interface CandidateSourceRow {
  search_hit_id: number;
  knowledge_chunk_id: number;
  section_title: string | null;
  content_kind: string;
  result_rank: number;
  chunk_source_id: number;
  pdf_page_number: number;
  source_excerpt: string;
}

interface CandidateSource {
  chunkSourceId: number;
  pageNumber: number;
  text: string;
}

interface WorkOrderCandidate extends AnswerabilityCandidate {
  searchHitId: number;
  knowledgeChunkId: number;
  resultRank: number;
  sources: CandidateSource[];
}

interface PersistedAssessment {
  id: number;
  work_order_id: number;
  search_run_id: number;
  requester_membership_id: number;
  verdict: WorkOrderEvidenceVerdict;
  decision_source: "model" | "program_no_candidates" | "model_error";
  selected_search_hit_id: number | null;
  selected_knowledge_chunk_id: number | null;
  selected_chunk_source_id: number | null;
  source_page_number: number | null;
  supporting_quote: string | null;
  reason: string;
  model_id: string;
  prompt_version: string;
  candidate_count: number;
  idempotency_key: string;
}

interface PreparedDecision {
  verdict: WorkOrderEvidenceVerdict;
  decisionSource: "model" | "program_no_candidates" | "model_error";
  selectedSearchHitId: number | null;
  selectedKnowledgeChunkId: number | null;
  selectedChunkSourceId: number | null;
  sourcePageNumber: number | null;
  supportingQuote: string | null;
  reason: string;
}

function requiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

async function loadScope(
  database: PGliteInterface,
  input: Pick<
    AssessWorkOrderEvidenceInput,
    "workOrderId" | "requesterMembershipId" | "searchRunId"
  >,
): Promise<EvidenceScope> {
  const result = await database.query<EvidenceScope>(
    `
      select
        work_order.id as work_order_id,
        work_order.factory_id,
        work_order.equipment_id,
        work_order.status,
        search_run.query_text,
        (
          requester_membership.id is not null
          and requester_user.id is not null
        ) as requester_is_authorized
      from work_orders as work_order
      join knowledge_search_runs as search_run
        on search_run.id = $3
       and search_run.work_order_id = work_order.id
       and search_run.factory_id = work_order.factory_id
       and search_run.equipment_id = work_order.equipment_id
      left join factory_memberships as requester_membership
        on requester_membership.id = $2
       and requester_membership.factory_id = work_order.factory_id
       and requester_membership.is_active = true
      left join users as requester_user
        on requester_user.id = requester_membership.user_id
       and requester_user.is_active = true
      where work_order.id = $1
    `,
    [input.workOrderId, input.requesterMembershipId, input.searchRunId],
  );
  if (result.rows.length !== 1) {
    throw new Error("knowledge search run does not belong to this work order");
  }
  if (!result.rows[0].requester_is_authorized) {
    throw new Error("active membership for the work order factory is required");
  }
  return result.rows[0];
}

async function loadCandidates(
  database: PGliteInterface,
  searchRunId: number,
): Promise<WorkOrderCandidate[]> {
  const result = await database.query<CandidateSourceRow>(
    `
      select
        search_hit.id as search_hit_id,
        search_hit.knowledge_chunk_id,
        knowledge_chunk.section_title,
        knowledge_chunk.content_kind,
        search_hit.result_rank,
        chunk_source.id as chunk_source_id,
        document_page.pdf_page_number,
        chunk_source.source_excerpt
      from knowledge_search_hits as search_hit
      join knowledge_chunks as knowledge_chunk
        on knowledge_chunk.id = search_hit.knowledge_chunk_id
      join knowledge_chunk_sources as chunk_source
        on chunk_source.knowledge_chunk_id = knowledge_chunk.id
      join document_pages as document_page
        on document_page.id = chunk_source.document_page_id
      where search_hit.search_run_id = $1
        and search_hit.result_rank <= 5
      order by search_hit.result_rank, chunk_source.source_order
    `,
    [searchRunId],
  );
  const candidates = new Map<number, WorkOrderCandidate>();
  for (const row of result.rows) {
    const current = candidates.get(row.search_hit_id) ?? {
      id: String(row.search_hit_id),
      searchHitId: row.search_hit_id,
      knowledgeChunkId: row.knowledge_chunk_id,
      resultRank: row.result_rank,
      sectionTitle: row.section_title?.trim() || row.content_kind,
      sources: [],
    };
    current.sources.push({
      chunkSourceId: row.chunk_source_id,
      pageNumber: row.pdf_page_number,
      text: row.source_excerpt,
    });
    candidates.set(row.search_hit_id, current);
  }
  return [...candidates.values()];
}

function prepareModelDecision(
  value: AnswerabilityDecision,
  candidates: readonly WorkOrderCandidate[],
): PreparedDecision {
  if (typeof value !== "object" || value === null) {
    throw new Error("evidence judge decision must be an object");
  }
  const reason = requiredText(value.reason, "evidence judge reason");
  if (value.verdict === "not_answerable") {
    if (
      value.candidateId !== null ||
      value.sourcePageNumber !== null ||
      value.supportingQuote !== null
    ) {
      throw new Error("not-answerable evidence fields must be null");
    }
    return {
      verdict: value.verdict,
      decisionSource: "model",
      selectedSearchHitId: null,
      selectedKnowledgeChunkId: null,
      selectedChunkSourceId: null,
      sourcePageNumber: null,
      supportingQuote: null,
      reason,
    };
  }
  if (
    value.verdict !== "directly_answerable" &&
    value.verdict !== "partially_related"
  ) {
    throw new Error("evidence judge verdict is invalid");
  }
  const candidateId = requiredText(value.candidateId, "evidence candidate ID");
  const selected = candidates.find(({ id }) => id === candidateId);
  if (!selected) throw new Error("evidence candidate is not in the search run");
  if (
    !Number.isSafeInteger(value.sourcePageNumber) ||
    Number(value.sourcePageNumber) <= 0
  ) {
    throw new Error("evidence source page must be positive");
  }
  const pageNumber = Number(value.sourcePageNumber);
  const quote = requiredText(value.supportingQuote, "evidence supporting quote");
  const source = selected.sources.find(
    (item) =>
      item.pageNumber === pageNumber &&
      normalizeWhitespace(item.text).includes(normalizeWhitespace(quote)),
  );
  if (!source) {
    throw new Error("evidence quote is not in the selected source page");
  }
  return {
    verdict: value.verdict,
    decisionSource: "model",
    selectedSearchHitId: selected.searchHitId,
    selectedKnowledgeChunkId: selected.knowledgeChunkId,
    selectedChunkSourceId: source.chunkSourceId,
    sourcePageNumber: pageNumber,
    supportingQuote: quote,
    reason,
  };
}

function toResult(
  assessment: PersistedAssessment,
): WorkOrderEvidenceAssessmentResult {
  return {
    evidenceAssessmentId: assessment.id,
    workOrderId: assessment.work_order_id,
    searchRunId: assessment.search_run_id,
    verdict: assessment.verdict,
    decisionSource: assessment.decision_source,
    selectedSearchHitId: assessment.selected_search_hit_id,
    selectedKnowledgeChunkId: assessment.selected_knowledge_chunk_id,
    selectedChunkSourceId: assessment.selected_chunk_source_id,
    sourcePageNumber: assessment.source_page_number,
    supportingQuote: assessment.supporting_quote,
    reason: assessment.reason,
    modelId: assessment.model_id,
    promptVersion: assessment.prompt_version,
    candidateCount: assessment.candidate_count,
  };
}

async function findExisting(
  database: PGliteInterface,
  workOrderId: number,
  idempotencyKey: string,
): Promise<PersistedAssessment | null> {
  const result = await database.query<PersistedAssessment>(
    `
      select *
      from evidence_assessments
      where work_order_id = $1 and idempotency_key = $2
    `,
    [workOrderId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function existingMatches(
  existing: PersistedAssessment,
  input: AssessWorkOrderEvidenceInput,
): boolean {
  return (
    existing.search_run_id === input.searchRunId &&
    existing.requester_membership_id === input.requesterMembershipId &&
    existing.model_id === input.judge.modelId &&
    existing.prompt_version === input.judge.promptVersion
  );
}

export async function assessWorkOrderEvidence(
  database: PGliteInterface,
  input: AssessWorkOrderEvidenceInput,
): Promise<WorkOrderEvidenceAssessmentResult> {
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    "evidence assessment idempotency key",
  );
  const scope = await loadScope(database, input);
  const existing = await findExisting(database, input.workOrderId, idempotencyKey);
  if (existing) {
    if (!existingMatches(existing, input)) {
      throw new Error(
        "idempotency key was already used for a different evidence assessment",
      );
    }
    return toResult(existing);
  }
  if (scope.status !== "investigating") {
    throw new Error("work order status does not allow evidence assessment");
  }
  const candidates = await loadCandidates(database, input.searchRunId);

  let prepared: PreparedDecision;
  if (candidates.length === 0) {
    prepared = {
      verdict: "not_answerable",
      decisionSource: "program_no_candidates",
      selectedSearchHitId: null,
      selectedKnowledgeChunkId: null,
      selectedChunkSourceId: null,
      sourcePageNumber: null,
      supportingQuote: null,
      reason: "本次检索没有返回可供核验的官方资料。",
    };
  } else {
    try {
      prepared = prepareModelDecision(
        await input.judge.judge({
          question: scope.query_text,
          candidates: candidates.map(({ id, sectionTitle, sources }) => ({
            id,
            sectionTitle,
            sources: sources.map(({ pageNumber, text }) => ({
              pageNumber,
              text,
            })),
          })),
        }),
        candidates,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      prepared = {
        verdict: "judge_error",
        decisionSource: "model_error",
        selectedSearchHitId: null,
        selectedKnowledgeChunkId: null,
        selectedChunkSourceId: null,
        sourcePageNumber: null,
        supportingQuote: null,
        reason: `证据判断失败：${message}`,
      };
    }
  }

  return database.transaction(async (transaction) => {
    let currentScope: EvidenceScope;
    try {
      currentScope = await loadScope(transaction, input);
    } catch {
      throw new Error(
        "authorization or evidence scope changed while assessment was running",
      );
    }
    if (
      currentScope.factory_id !== scope.factory_id ||
      currentScope.equipment_id !== scope.equipment_id ||
      currentScope.query_text !== scope.query_text
    ) {
      throw new Error(
        "authorization or evidence scope changed while assessment was running",
      );
    }
    const racedExisting = await findExisting(
      transaction,
      input.workOrderId,
      idempotencyKey,
    );
    if (racedExisting) {
      if (!existingMatches(racedExisting, input)) {
        throw new Error(
          "idempotency key was already used for a different evidence assessment",
        );
      }
      return toResult(racedExisting);
    }
    if (currentScope.status !== "investigating") {
      throw new Error(
        "authorization or evidence scope changed while assessment was running",
      );
    }

    if (prepared.selectedSearchHitId !== null) {
      const stillValid = await transaction.query<{ id: number }>(
        `
          select search_hit.id
          from knowledge_search_hits as search_hit
          join knowledge_chunk_sources as chunk_source
            on chunk_source.id = $4
           and chunk_source.knowledge_chunk_id = search_hit.knowledge_chunk_id
          join document_pages as document_page
            on document_page.id = chunk_source.document_page_id
          where search_hit.id = $1
            and search_hit.search_run_id = $2
            and search_hit.knowledge_chunk_id = $3
            and document_page.pdf_page_number = $5
            and strpos(
              regexp_replace(chunk_source.source_excerpt, '[[:space:]]+', '', 'g'),
              regexp_replace($6, '[[:space:]]+', '', 'g')
            ) > 0
        `,
        [
          prepared.selectedSearchHitId,
          input.searchRunId,
          prepared.selectedKnowledgeChunkId,
          prepared.selectedChunkSourceId,
          prepared.sourcePageNumber,
          prepared.supportingQuote,
        ],
      );
      if (stillValid.rows.length !== 1) {
        throw new Error(
          "authorization or evidence scope changed while assessment was running",
        );
      }
    }

    const inserted = await transaction.query<PersistedAssessment>(
      `
        insert into evidence_assessments (
          work_order_id, factory_id, equipment_id, search_run_id,
          requester_membership_id, verdict, decision_source,
          selected_search_hit_id, selected_knowledge_chunk_id,
          selected_chunk_source_id, source_page_number, supporting_quote,
          reason, model_id, prompt_version, candidate_count, idempotency_key
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17
        )
        returning *
      `,
      [
        currentScope.work_order_id,
        currentScope.factory_id,
        currentScope.equipment_id,
        input.searchRunId,
        input.requesterMembershipId,
        prepared.verdict,
        prepared.decisionSource,
        prepared.selectedSearchHitId,
        prepared.selectedKnowledgeChunkId,
        prepared.selectedChunkSourceId,
        prepared.sourcePageNumber,
        prepared.supportingQuote,
        prepared.reason,
        input.judge.modelId,
        input.judge.promptVersion,
        candidates.length,
        idempotencyKey,
      ],
    );
    const assessment = inserted.rows[0];
    await transaction.query(
      `
        insert into work_order_events (
          work_order_id, factory_id, event_type, actor_kind,
          actor_membership_id, content, details, idempotency_key,
          evidence_assessment_id
        )
        values (
          $1, $2, 'evidence_assessed', 'agent', null,
          $3, $4::jsonb, $5, $6
        )
      `,
      [
        currentScope.work_order_id,
        currentScope.factory_id,
        prepared.verdict === "directly_answerable"
          ? "证据判断确认当前官方资料足以直接回答。"
          : "证据判断未允许当前资料进入自动方案。",
        JSON.stringify({
          evidenceAssessmentId: assessment.id,
          searchRunId: input.searchRunId,
          verdict: prepared.verdict,
          decisionSource: prepared.decisionSource,
          selectedSearchHitId: prepared.selectedSearchHitId,
        }),
        `assess_work_order_evidence:${idempotencyKey}`,
        assessment.id,
      ],
    );
    return toResult(assessment);
  });
}
