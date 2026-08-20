import { resolveQwenChatCompletionsEndpoint } from "./qwen-coordinator-runtime.ts";
import {
  createQwenCoordinatorModelV3,
  type QwenCoordinatorModelV3,
} from "./qwen-coordinator-model-v3.ts";

const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export type QwenCoordinatorV3Environment = Record<string, string | undefined>;

export interface CreateQwenCoordinatorV3FromEnvironmentOptions {
  fetchImplementation?: typeof fetch;
}

function requiredEnvironmentText(
  environment: QwenCoordinatorV3Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function providerTimeoutMs(environment: QwenCoordinatorV3Environment): number {
  const raw = environment.PROVIDER_TIMEOUT_SECONDS?.trim() || "60";
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("PROVIDER_TIMEOUT_SECONDS must be greater than 0 and at most 600");
  }
  return Math.round(seconds * 1000);
}

export function createQwenCoordinatorModelV3FromEnvironment(
  environment: QwenCoordinatorV3Environment = process.env,
  options: CreateQwenCoordinatorV3FromEnvironmentOptions = {},
): QwenCoordinatorModelV3 {
  const apiKey = requiredEnvironmentText(environment, "DASHSCOPE_API_KEY");
  const baseUrl = environment.DASHSCOPE_BASE_URL?.trim() || defaultBaseUrl;
  const modelId =
    environment.QWEN_COORDINATOR_MODEL?.trim() ||
    environment.CREATIVE_MODEL?.trim();
  return createQwenCoordinatorModelV3({
    apiKey,
    endpoint: resolveQwenChatCompletionsEndpoint(baseUrl),
    requestTimeoutMs: providerTimeoutMs(environment),
    ...(modelId ? { modelId } : {}),
    ...(options.fetchImplementation
      ? { fetchImplementation: options.fetchImplementation }
      : {}),
  });
}
