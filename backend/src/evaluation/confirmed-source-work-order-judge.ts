import type { PGliteInterface } from "@electric-sql/pglite";

import type {
  AnswerabilityCandidate,
  AnswerabilityDecision,
  QwenAnswerabilityJudge,
} from "./qwen-answerability-judge.ts";
import type {
  SourceAwareAnswerabilityJudge,
  SourceAwareAnswerabilityCandidate,
} from "./source-aware-work-order-judge.ts";

export const CONFIRMED_SOURCE_CONSTRAINT_VERSION =
  "confirmed-source-exact-v1" as const;
export const CONFIRMED_SOURCE_NO_MATCH_REASON =
  "检索候选中没有与人工确认的资料编号、版本和语言完全一致的来源。" as const;

export interface ConfirmedSourceIdentity {
  documentReference: string;
  versionLabel: string;
  languageCode: string;
}

export interface ConfirmedSourceRequest {
  /**
   * Untrusted original search question. It is used only to bind the
   * confirmation to one search run and is never forwarded to the model.
   */
  rawQuestion: string;
  /** Human-confirmed, source-free content question forwarded to the model. */
  confirmedContentQuestion: string;
  requestedSourceIdentity: ConfirmedSourceIdentity;
}

interface CandidateIdentityRow {
  candidate_id: string;
  document_reference: string;
  version_label: string;
  language_code: string;
}

interface ValidatedConfirmedSourceRequest {
  rawQuestion: string;
  confirmedContentQuestion: string;
  requestedSourceIdentity: ConfirmedSourceIdentity;
}

function requiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`confirmed source ${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function canonicalLanguageCode(value: string): string {
  const parts = value.split("-");
  if (parts.length === 1) return parts[0].toLowerCase();
  return [parts[0].toLowerCase(), parts[1].toUpperCase(), ...parts.slice(2)].join(
    "-",
  );
}

function validateRequest(
  request: ConfirmedSourceRequest,
): ValidatedConfirmedSourceRequest {
  return {
    rawQuestion: requiredText(request?.rawQuestion, "raw question"),
    confirmedContentQuestion: requiredText(
      request?.confirmedContentQuestion,
      "content question",
    ),
    requestedSourceIdentity: {
      documentReference: requiredText(
        request?.requestedSourceIdentity?.documentReference,
        "document reference",
      ).toUpperCase(),
      versionLabel: requiredText(
        request?.requestedSourceIdentity?.versionLabel,
        "version label",
      ),
      languageCode: canonicalLanguageCode(
        requiredText(
          request?.requestedSourceIdentity?.languageCode,
          "language code",
        ),
      ),
    },
  };
}

function positiveCandidateId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(
      "confirmed source candidate ID must be a positive database integer",
    );
  }
  return parsed;
}

async function loadMatchingIdentities(
  database: PGliteInterface,
  candidates: readonly AnswerabilityCandidate[],
  requested: ConfirmedSourceIdentity,
): Promise<Map<string, CandidateIdentityRow>> {
  const candidateIds = candidates.map(({ id }) => positiveCandidateId(id));
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("confirmed source candidate IDs must be unique");
  }
  if (candidateIds.length === 0) return new Map();

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
        and lower(btrim(source_document.document_reference)) = lower(btrim($2))
        and lower(btrim(source_version.version_label)) = lower(btrim($3))
        and lower(btrim(source_version.language_code)) = lower(btrim($4))
    `,
    [
      candidateIds,
      requested.documentReference,
      requested.versionLabel,
      requested.languageCode,
    ],
  );

  const identities = new Map<string, CandidateIdentityRow>();
  for (const row of result.rows) {
    if (identities.has(row.candidate_id)) {
      throw new Error("confirmed source candidate has multiple identities");
    }
    identities.set(row.candidate_id, row);
  }
  return identities;
}

function sourceAwareCandidate(
  candidate: AnswerabilityCandidate,
  identity: CandidateIdentityRow,
): SourceAwareAnswerabilityCandidate {
  return {
    ...candidate,
    documentReference: requiredText(
      identity.document_reference,
      "database document reference",
    ),
    versionLabel: requiredText(
      identity.version_label,
      "database version label",
    ),
    languageCode: requiredText(
      identity.language_code,
      "database language code",
    ),
  };
}

function noMatchingSourceDecision(): AnswerabilityDecision {
  return {
    verdict: "not_answerable",
    candidateId: null,
    sourcePageNumber: null,
    supportingQuote: null,
    reason: CONFIRMED_SOURCE_NO_MATCH_REASON,
  };
}

/**
 * Binds a trusted source confirmation to the existing evidence-gate interface.
 * The raw question is checked for equality but never appears in model input.
 */
export function createConfirmedSourceWorkOrderJudge(
  database: PGliteInterface,
  contentJudge: SourceAwareAnswerabilityJudge,
  request: ConfirmedSourceRequest,
): QwenAnswerabilityJudge {
  const confirmed = validateRequest(request);
  const modelId = requiredText(contentJudge.modelId, "judge model ID");
  const contentPromptVersion = requiredText(
    contentJudge.promptVersion,
    "judge prompt version",
  );
  const identity = confirmed.requestedSourceIdentity;
  const auditPromptVersion = [
    contentPromptVersion,
    CONFIRMED_SOURCE_CONSTRAINT_VERSION,
    `${identity.documentReference}/${identity.versionLabel}/${identity.languageCode}`,
  ].join("|");

  return {
    modelId,
    // The evidence table persists this value, so the exact confirmed source is
    // auditable even though the frozen schema has no dedicated source columns.
    promptVersion:
      auditPromptVersion as QwenAnswerabilityJudge["promptVersion"],
    async judge(input): Promise<AnswerabilityDecision> {
      const actualRawQuestion = requiredText(input?.question, "runtime raw question");
      if (actualRawQuestion !== confirmed.rawQuestion) {
        throw new Error(
          "runtime raw question does not match the confirmed raw question",
        );
      }

      const identities = await loadMatchingIdentities(
        database,
        input.candidates,
        identity,
      );
      const filteredCandidates = input.candidates.flatMap((candidate) => {
        const matchedIdentity = identities.get(candidate.id);
        return matchedIdentity
          ? [sourceAwareCandidate(candidate, matchedIdentity)]
          : [];
      });
      if (filteredCandidates.length === 0) return noMatchingSourceDecision();

      const decision = await contentJudge.judge({
        question: confirmed.confirmedContentQuestion,
        candidates: filteredCandidates,
      });
      if (
        decision.verdict !== "not_answerable" &&
        !filteredCandidates.some(({ id }) => id === decision.candidateId)
      ) {
        throw new Error(
          "content judge selected a candidate outside the confirmed source",
        );
      }
      return decision;
    },
  };
}
