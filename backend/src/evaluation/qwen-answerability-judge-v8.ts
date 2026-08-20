import type {
  AnswerabilityDecision,
  CreateQwenAnswerabilityFromEnvironmentOptions,
  CreateQwenAnswerabilityJudgeOptions,
  QwenAnswerabilityEnvironment,
} from "./qwen-answerability-judge.ts";
import {
  createQwenAnswerabilityJudgeV7,
  createQwenAnswerabilityJudgeV7FromEnvironment,
} from "./qwen-answerability-judge-v7.ts";
import type {
  SourceAwareAnswerabilityJudge,
  SourceAwareAnswerabilityJudgeInput,
} from "./source-aware-work-order-judge.ts";

export const QWEN_ANSWERABILITY_PROMPT_VERSION_V8 =
  "answerability-v8-candidate-isolated" as const;

export interface QwenAnswerabilityJudgeV8 extends SourceAwareAnswerabilityJudge {
  promptVersion: typeof QWEN_ANSWERABILITY_PROMPT_VERSION_V8;
  judge(input: SourceAwareAnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}

const semanticPolicy = [
  "事实支持按语义等价判断，不要求问题与原文出现完全相同的抽象词。",
  "当原文列举具体检查内容时，这些列举可以语义等价地回答检查范围、涉及方面或检查对象；不得仅因原文没有出现‘范围’二字而拒绝。",
].join("\n");

function withSemanticPolicy(providerFetch: typeof fetch): typeof fetch {
  return async (request, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("answerability v8 expected a JSON request body");
    }
    const body = JSON.parse(init.body) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
      [key: string]: unknown;
    };
    body.messages = body.messages?.map((message) =>
      message.role === "system" && typeof message.content === "string"
        ? { ...message, content: `${message.content}\n${semanticPolicy}` }
        : message,
    );
    return providerFetch(request, { ...init, body: JSON.stringify(body) });
  };
}

function validateInput(input: SourceAwareAnswerabilityJudgeInput): void {
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < 1 ||
    input.candidates.length > 5
  ) {
    throw new Error("answerability v8 needs between one and five candidates");
  }
  if (new Set(input.candidates.map(({ id }) => id)).size !== input.candidates.length) {
    throw new Error("answerability v8 candidate IDs must be unique");
  }
}

function asCandidateIsolated(base: {
  modelId: string;
  judge(input: SourceAwareAnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}): QwenAnswerabilityJudgeV8 {
  return {
    modelId: base.modelId,
    promptVersion: QWEN_ANSWERABILITY_PROMPT_VERSION_V8,
    async judge(input) {
      validateInput(input);
      let firstPartial: AnswerabilityDecision | null = null;
      const refusalReasons: string[] = [];
      for (const candidate of input.candidates) {
        const decision = await base.judge({
          question: input.question,
          candidates: [candidate],
        });
        if (decision.verdict === "directly_answerable") return decision;
        if (decision.verdict === "partially_related" && firstPartial === null) {
          firstPartial = decision;
        }
        if (decision.verdict === "not_answerable") {
          refusalReasons.push(decision.reason);
        }
      }
      if (firstPartial) return firstPartial;
      return {
        verdict: "not_answerable",
        candidateId: null,
        sourcePageNumber: null,
        supportingQuote: null,
        reason: refusalReasons.join(" | ") || "所有候选均不能回答问题。",
      };
    },
  };
}

export function createQwenAnswerabilityJudgeV8(
  options: CreateQwenAnswerabilityJudgeOptions,
): QwenAnswerabilityJudgeV8 {
  return asCandidateIsolated(
    createQwenAnswerabilityJudgeV7({
      ...options,
      fetchImplementation: withSemanticPolicy(
        options.fetchImplementation ?? fetch,
      ),
    }),
  );
}

export function createQwenAnswerabilityJudgeV8FromEnvironment(
  environment: QwenAnswerabilityEnvironment = process.env,
  options: CreateQwenAnswerabilityFromEnvironmentOptions = {},
): QwenAnswerabilityJudgeV8 {
  return asCandidateIsolated(
    createQwenAnswerabilityJudgeV7FromEnvironment(environment, {
      fetchImplementation: withSemanticPolicy(
        options.fetchImplementation ?? fetch,
      ),
    }),
  );
}
