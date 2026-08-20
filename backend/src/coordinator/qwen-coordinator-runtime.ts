import {
  createQwenCoordinatorModel,
  type QwenCoordinatorModel,
} from "./qwen-coordinator-model.ts";

const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export type QwenCoordinatorEnvironment = Record<string, string | undefined>;

export interface CreateQwenCoordinatorFromEnvironmentOptions {
  fetchImplementation?: typeof fetch;
}

function requiredEnvironmentText(
  environment: QwenCoordinatorEnvironment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function resolveQwenChatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("DASHSCOPE_BASE_URL must be an absolute HTTP URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("DASHSCOPE_BASE_URL must be an absolute HTTP URL");
  }
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/compatible-mode/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/compatible-mode/v1/chat/completions`;
}

function providerTimeoutMs(environment: QwenCoordinatorEnvironment): number {
  const raw = environment.PROVIDER_TIMEOUT_SECONDS?.trim() || "60";
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("PROVIDER_TIMEOUT_SECONDS must be greater than 0 and at most 600");
  }
  return Math.round(seconds * 1000);
}

export function createQwenCoordinatorModelFromEnvironment(
  environment: QwenCoordinatorEnvironment = process.env,
  options: CreateQwenCoordinatorFromEnvironmentOptions = {},
): QwenCoordinatorModel {
  const apiKey = requiredEnvironmentText(environment, "DASHSCOPE_API_KEY");
  const baseUrl = environment.DASHSCOPE_BASE_URL?.trim() || defaultBaseUrl;
  const modelId =
    environment.QWEN_COORDINATOR_MODEL?.trim() ||
    environment.CREATIVE_MODEL?.trim();
  return createQwenCoordinatorModel({
    apiKey,
    endpoint: resolveQwenChatCompletionsEndpoint(baseUrl),
    requestTimeoutMs: providerTimeoutMs(environment),
    ...(modelId ? { modelId } : {}),
    ...(options.fetchImplementation
      ? { fetchImplementation: options.fetchImplementation }
      : {}),
  });
}
