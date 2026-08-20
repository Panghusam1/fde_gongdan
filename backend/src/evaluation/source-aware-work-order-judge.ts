import type { PGliteInterface } from "@electric-sql/pglite";

import type {
  AnswerabilityCandidate,
  AnswerabilityDecision,
  AnswerabilityJudgeInput,
  QwenAnswerabilityJudge,
} from "./qwen-answerability-judge.ts";

export interface SourceAwareAnswerabilityCandidate
  extends AnswerabilityCandidate {
  documentReference: string;
  versionLabel: string;
  languageCode: string;
}

export interface SourceAwareAnswerabilityJudgeInput
  extends Omit<AnswerabilityJudgeInput, "candidates"> {
  candidates: SourceAwareAnswerabilityCandidate[];
}

export interface SourceAwareAnswerabilityJudge {
  modelId: string;
  promptVersion: string;
  judge(input: SourceAwareAnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}

interface CandidateIdentityRow {
  candidate_id: string;
  document_reference: string;
  version_label: string;
  language_code: string;
}

function positiveCandidateId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error("source-aware candidate ID must be a positive database integer");
  }
  return parsed;
}

function requiredText(value: string, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`source-aware ${fieldName} must not be blank`);
  return normalized;
}

async function loadCandidateIdentities(
  database: PGliteInterface,
  candidates: readonly AnswerabilityCandidate[],
): Promise<Map<string, CandidateIdentityRow>> {
  const candidateIds = candidates.map(({ id }) => positiveCandidateId(id));
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("source-aware candidate IDs must be unique");
  }
  const result = await database.query<CandidateIdentityRow>(
    `
      select
        search_hit.id::text as candidate_id,
        source_document.document_reference,
        source_version.version_label,
        source_version.language_code
      from knowledge_search_hits as search_hit
      join knowledge_chunks as knowledge_chunk
        on knowledge_chunk.id = search_hit.knowledge_chunk_id
      join source_versions as source_version
        on source_version.id = knowledge_chunk.source_version_id
      join source_documents as source_document
        on source_document.id = source_version.source_document_id
      where search_hit.id = any($1::bigint[])
    `,
    [candidateIds],
  );
  const identities = new Map<string, CandidateIdentityRow>();
  for (const row of result.rows) {
    if (identities.has(row.candidate_id)) {
      throw new Error("source-aware candidate has multiple source identities");
    }
    identities.set(row.candidate_id, row);
  }
  if (identities.size !== candidates.length) {
    throw new Error("source-aware candidate identity is missing from the database");
  }
  return identities;
}

export function createSourceAwareWorkOrderJudge(
  database: PGliteInterface,
  judge: SourceAwareAnswerabilityJudge,
): QwenAnswerabilityJudge {
  return {
    modelId: requiredText(judge.modelId, "judge model ID"),
    promptVersion: requiredText(
      judge.promptVersion,
      "judge prompt version",
    ) as QwenAnswerabilityJudge["promptVersion"],
    async judge(input) {
      const identities = await loadCandidateIdentities(
        database,
        input.candidates,
      );
      return judge.judge({
        question: input.question,
        candidates: input.candidates.map((candidate) => {
          const identity = identities.get(candidate.id)!;
          return {
            ...candidate,
            documentReference: requiredText(
              identity.document_reference,
              "document reference",
            ),
            versionLabel: requiredText(identity.version_label, "version label"),
            languageCode: requiredText(identity.language_code, "language code"),
          };
        }),
      });
    },
  };
}
