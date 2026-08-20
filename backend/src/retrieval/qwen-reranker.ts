export const QWEN_RERANKER_MODEL_ID = "qwen3-rerank";
export const QWEN_RERANKER_INSTRUCTION =
  "Given an industrial equipment support query, retrieve passages that directly answer the query, including applicable safety warnings.";

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

export interface QwenReranker {
  modelId: string;
  rerank(query: string, documents: string[]): Promise<RerankResult[]>;
}

export interface CreateQwenRerankerOptions {
  apiKey: string;
  workspaceId: string;
  region?: string;
  modelId?: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be non-blank text`);
  }
  return value.trim();
}

function normalizeRegion(value: string | undefined): string {
  const region = (value ?? "cn-beijing").trim().toLowerCase();
  if (!/^[a-z]{2}-[a-z]+$/.test(region)) {
    throw new Error("reranker region is invalid");
  }
  return region;
}

export function createQwenReranker(
  options: CreateQwenRerankerOptions,
): QwenReranker {
  const apiKey = requiredText(options.apiKey, "reranker API key");
  const workspaceId = requiredText(options.workspaceId, "reranker workspace ID");
  const region = normalizeRegion(options.region);
  const modelId = requiredText(
    options.modelId ?? QWEN_RERANKER_MODEL_ID,
    "reranker model ID",
  );
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    requestTimeoutMs > 600_000
  ) {
    throw new Error("reranker request timeout must be between 1 and 600000 ms");
  }
  const endpoint = `https://${workspaceId}.${region}.maas.aliyuncs.com/compatible-api/v1/reranks`;
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    modelId,
    async rerank(query, documents): Promise<RerankResult[]> {
      const normalizedQuery = requiredText(query, "reranker query");
      if (!Array.isArray(documents) || documents.length === 0 || documents.length > 500) {
        throw new Error("reranker documents must contain between 1 and 500 items");
      }
      const normalizedDocuments = documents.map((document) =>
        requiredText(document, "reranker document"),
      );
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
        body: JSON.stringify({
          model: modelId,
          query: normalizedQuery,
          documents: normalizedDocuments,
          top_n: normalizedDocuments.length,
          instruct: QWEN_RERANKER_INSTRUCTION,
        }),
      });
      if (!response.ok) {
        throw new Error(`qwen reranker request failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        results?: Array<{ index?: unknown; relevance_score?: unknown }>;
      };
      if (!Array.isArray(body.results) || body.results.length !== documents.length) {
        throw new Error("qwen reranker response did not contain every document");
      }
      const seenIndexes = new Set<number>();
      return body.results.map((result) => {
        if (
          !Number.isSafeInteger(result.index) ||
          Number(result.index) < 0 ||
          Number(result.index) >= documents.length ||
          seenIndexes.has(Number(result.index))
        ) {
          throw new Error("qwen reranker result index is invalid");
        }
        if (
          typeof result.relevance_score !== "number" ||
          !Number.isFinite(result.relevance_score) ||
          result.relevance_score < 0 ||
          result.relevance_score > 1
        ) {
          throw new Error("qwen reranker relevance score is invalid");
        }
        seenIndexes.add(Number(result.index));
        return {
          index: Number(result.index),
          relevanceScore: result.relevance_score,
        };
      });
    },
  };
}

function inferRegion(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    const labels = new URL(baseUrl).hostname.split(".");
    return labels.find((label) => /^cn-[a-z]+$/.test(label));
  } catch {
    throw new Error("DASHSCOPE_BASE_URL must be a valid URL");
  }
}

export function createQwenRerankerFromEnvironment(
  environment: Record<string, string | undefined>,
): QwenReranker {
  const apiKey = environment.QWEN_RERANKER_API_KEY;
  if (!apiKey?.trim()) throw new Error("QWEN_RERANKER_API_KEY is required");
  const workspaceId = environment.QWEN_RERANKER_WORKSPACE_ID;
  if (!workspaceId?.trim()) {
    throw new Error("QWEN_RERANKER_WORKSPACE_ID is required");
  }
  const timeoutSeconds = environment.PROVIDER_TIMEOUT_SECONDS
    ? Number(environment.PROVIDER_TIMEOUT_SECONDS)
    : 60;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("PROVIDER_TIMEOUT_SECONDS must be a positive number");
  }
  return createQwenReranker({
    apiKey,
    workspaceId,
    region:
      environment.QWEN_RERANKER_REGION ??
      inferRegion(environment.QWEN_RERANKER_BASE_URL),
    modelId: environment.QWEN_RERANKER_MODEL ?? QWEN_RERANKER_MODEL_ID,
    requestTimeoutMs: Math.round(timeoutSeconds * 1000),
  });
}
