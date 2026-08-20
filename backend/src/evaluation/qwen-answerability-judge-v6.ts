import {
  QWEN_ANSWERABILITY_MODEL_ID,
  type AnswerabilityDecision,
  type CreateQwenAnswerabilityFromEnvironmentOptions,
  type CreateQwenAnswerabilityJudgeOptions,
  type QwenAnswerabilityEnvironment,
} from "./qwen-answerability-judge.ts";
import {
  createQwenAnswerabilityJudgeV5,
  createQwenAnswerabilityJudgeV5FromEnvironment,
} from "./qwen-answerability-judge-v5.ts";
import type {
  SourceAwareAnswerabilityCandidate,
  SourceAwareAnswerabilityJudge,
  SourceAwareAnswerabilityJudgeInput,
} from "./source-aware-work-order-judge.ts";

export const QWEN_ANSWERABILITY_PROMPT_VERSION_V6 =
  "answerability-v6-source-aware" as const;

export interface QwenAnswerabilityJudgeV6
  extends SourceAwareAnswerabilityJudge {
  promptVersion: typeof QWEN_ANSWERABILITY_PROMPT_VERSION_V6;
  judge(input: SourceAwareAnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}

function requiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`answerability v6 ${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function validateSourceCandidates(
  candidates: SourceAwareAnswerabilityCandidate[],
): SourceAwareAnswerabilityCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("answerability v6 needs source-aware candidates");
  }
  return candidates.map((candidate) => ({
    ...candidate,
    documentReference: requiredText(
      candidate.documentReference,
      "document reference",
    ),
    versionLabel: requiredText(candidate.versionLabel, "version label"),
    languageCode: requiredText(candidate.languageCode, "language code"),
  }));
}

function withSourceIdentity(
  providerFetch: typeof fetch,
  candidates: readonly SourceAwareAnswerabilityCandidate[],
): typeof fetch {
  const identityById = new Map(
    candidates.map((candidate) => [candidate.id, candidate] as const),
  );
  return async (request, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("answerability v6 expected a JSON request body");
    }
    const body = JSON.parse(init.body) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
      [key: string]: unknown;
    };
    body.messages = body.messages?.map((message) => {
      if (message.role === "system" && typeof message.content === "string") {
        return {
          ...message,
          content: [
            message.content,
            "候选中的documentReference、versionLabel和languageCode来自数据库来源链；当问题指定资料编号、版本或语言时，必须同时核对这些字段。",
          ].join("\n"),
        };
      }
      if (message.role !== "user" || typeof message.content !== "string") {
        return message;
      }
      const userContent = JSON.parse(message.content) as {
        question?: unknown;
        candidates?: Array<Record<string, unknown>>;
      };
      if (!Array.isArray(userContent.candidates)) {
        throw new Error("answerability v6 expected candidates in the user message");
      }
      userContent.candidates = userContent.candidates.map((candidate) => {
        const id = typeof candidate.id === "string" ? candidate.id : "";
        const identity = identityById.get(id);
        if (!identity) {
          throw new Error("answerability v6 candidate identity is missing");
        }
        return {
          ...candidate,
          documentReference: identity.documentReference,
          versionLabel: identity.versionLabel,
          languageCode: identity.languageCode,
        };
      });
      return { ...message, content: JSON.stringify(userContent) };
    });
    return providerFetch(request, { ...init, body: JSON.stringify(body) });
  };
}

export function createQwenAnswerabilityJudgeV6(
  options: CreateQwenAnswerabilityJudgeOptions,
): QwenAnswerabilityJudgeV6 {
  const modelId = requiredText(
    options.modelId ?? QWEN_ANSWERABILITY_MODEL_ID,
    "model ID",
  );
  const providerFetch = options.fetchImplementation ?? fetch;
  return {
    modelId,
    promptVersion: QWEN_ANSWERABILITY_PROMPT_VERSION_V6,
    async judge(input) {
      const candidates = validateSourceCandidates(input.candidates);
      const base = createQwenAnswerabilityJudgeV5({
        ...options,
        fetchImplementation: withSourceIdentity(providerFetch, candidates),
      });
      return base.judge({
        question: input.question,
        candidates,
      });
    },
  };
}

export function createQwenAnswerabilityJudgeV6FromEnvironment(
  environment: QwenAnswerabilityEnvironment = process.env,
  options: CreateQwenAnswerabilityFromEnvironmentOptions = {},
): QwenAnswerabilityJudgeV6 {
  const modelId =
    environment.QWEN_ANSWERABILITY_MODEL?.trim() ||
    environment.CREATIVE_MODEL?.trim() ||
    QWEN_ANSWERABILITY_MODEL_ID;
  const providerFetch = options.fetchImplementation ?? fetch;
  return {
    modelId,
    promptVersion: QWEN_ANSWERABILITY_PROMPT_VERSION_V6,
    async judge(input) {
      const candidates = validateSourceCandidates(input.candidates);
      const base = createQwenAnswerabilityJudgeV5FromEnvironment(environment, {
        fetchImplementation: withSourceIdentity(providerFetch, candidates),
      });
      return base.judge({
        question: input.question,
        candidates,
      });
    },
  };
}
