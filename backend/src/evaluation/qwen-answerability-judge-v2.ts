import {
  createQwenAnswerabilityJudge,
  createQwenAnswerabilityJudgeFromEnvironment,
  type AnswerabilityDecision,
  type AnswerabilityJudgeInput,
  type CreateQwenAnswerabilityFromEnvironmentOptions,
  type CreateQwenAnswerabilityJudgeOptions,
  type QwenAnswerabilityEnvironment,
} from "./qwen-answerability-judge.ts";

export const QWEN_ANSWERABILITY_PROMPT_VERSION_V2 = "answerability-v2";

export interface QwenAnswerabilityJudgeV2 {
  modelId: string;
  promptVersion: typeof QWEN_ANSWERABILITY_PROMPT_VERSION_V2;
  judge(input: AnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}

const v2DecisionBoundary = [
  "补充分类边界：三类结论互斥，必须严格按以下顺序判断。",
  "第一步，先判断directly_answerable：候选原文是否足以完整回答问题要求的事实、关系、数值或步骤。满足才选择它。",
  "第二步，再判断partially_related：不能完整回答，但至少一份候选原文明示了问题中的关键对象、动作或条件，只是缺少所问的关系、数值或步骤。此时必须选择该候选并引用重合原文。",
  "第三步，最后才判断not_answerable：没有任何候选与问题所问对象或事实实质相关。不要因为候选缺少完整答案，就把本应partially_related的资料判成not_answerable。",
  "边界例子：问题询问通风口堵塞与OHF是否存在直接因果关系，资料只写了观察通风口是否被遮挡，却没有写OHF或因果关系，应判partially_related；保修期问题面对通风检查资料，应判not_answerable。",
].join("\n");

function withV2DecisionBoundary(
  fetchImplementation: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("answerability v2 expected a JSON request body");
    }
    const body = JSON.parse(init.body) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const systemMessage = body.messages?.find(
      ({ role }) => role === "system",
    );
    if (!systemMessage || typeof systemMessage.content !== "string") {
      throw new Error("answerability v2 expected a system message");
    }
    systemMessage.content = `${systemMessage.content}\n${v2DecisionBoundary}`;
    return fetchImplementation(input, {
      ...init,
      body: JSON.stringify(body),
    });
  };
}

function asV2(base: {
  modelId: string;
  judge(input: AnswerabilityJudgeInput): Promise<AnswerabilityDecision>;
}): QwenAnswerabilityJudgeV2 {
  return {
    modelId: base.modelId,
    promptVersion: QWEN_ANSWERABILITY_PROMPT_VERSION_V2,
    judge: (input) => base.judge(input),
  };
}

export function createQwenAnswerabilityJudgeV2(
  options: CreateQwenAnswerabilityJudgeOptions,
): QwenAnswerabilityJudgeV2 {
  return asV2(
    createQwenAnswerabilityJudge({
      ...options,
      fetchImplementation: withV2DecisionBoundary(
        options.fetchImplementation ?? fetch,
      ),
    }),
  );
}

export function createQwenAnswerabilityJudgeV2FromEnvironment(
  environment: QwenAnswerabilityEnvironment = process.env,
  options: CreateQwenAnswerabilityFromEnvironmentOptions = {},
): QwenAnswerabilityJudgeV2 {
  return asV2(
    createQwenAnswerabilityJudgeFromEnvironment(environment, {
      fetchImplementation: withV2DecisionBoundary(
        options.fetchImplementation ?? fetch,
      ),
    }),
  );
}
