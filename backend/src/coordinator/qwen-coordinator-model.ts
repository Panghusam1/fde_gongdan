export const QWEN_COORDINATOR_MODEL_ID = "qwen3.7-plus-2026-05-26";
export const QWEN_COORDINATOR_PROMPT_VERSION = "coordinator-v2";

const defaultEndpoint =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

export type CoordinatorDecision =
  | { action: "append_observation"; observationType: string; content: string }
  | { action: "search_official_knowledge"; queryText: string }
  | { action: "run_risk_assessment"; searchRunId: number }
  | {
      action: "draft_resolution_proposal";
      riskAssessmentId: number;
      evidenceSearchHitIds: number[];
      summary: string;
      confirmedFacts: string[];
      assumptions: string[];
      steps: string[];
      stopConditions: string[];
      expectedObservations: string[];
      basisObservationEventId?: number;
    }
  | { action: "request_user_confirmation"; proposalId: number }
  | {
      action: "record_user_confirmation";
      proposalId: number;
      outcome: "resolved" | "not_resolved";
      actualResult: string;
    };

export interface CoordinatorModelInput {
  userMessage: string;
  workOrderContext: unknown;
  allowedActions: string[];
}

export interface QwenCoordinatorModel {
  modelId: string;
  promptVersion: typeof QWEN_COORDINATOR_PROMPT_VERSION;
  decide(input: CoordinatorModelInput): Promise<CoordinatorDecision>;
}

export interface CreateQwenCoordinatorModelOptions {
  apiKey: string;
  endpoint?: string;
  modelId?: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

const coordinatorActionContract = [
  'append_observation: {"action":"append_observation","observationType":"symptom|action_taken|measurement|environment|user_feedback","content":"非空文字"}',
  'search_official_knowledge: {"action":"search_official_knowledge","queryText":"非空检索问题"}',
  'run_risk_assessment: {"action":"run_risk_assessment","searchRunId":正整数}',
  'draft_resolution_proposal: {"action":"draft_resolution_proposal","riskAssessmentId":正整数,"evidenceSearchHitIds":[正整数],"summary":"非空文字","confirmedFacts":["非空文字"],"assumptions":["文字，可为空数组"],"steps":["非空文字"],"stopConditions":["非空文字"],"expectedObservations":["非空文字"],"basisObservationEventId":"仅第二版需要的正整数"}',
  'request_user_confirmation: {"action":"request_user_confirmation","proposalId":正整数}',
  'record_user_confirmation: {"action":"record_user_confirmation","proposalId":正整数,"outcome":"resolved|not_resolved","actualResult":"非空文字"}',
].join("\n");

function requiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`coordinator decision ${fieldName} must be non-blank text`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`coordinator decision ${fieldName} must be a positive integer`);
  }
  return Number(value);
}

function requiredTextArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`coordinator decision ${fieldName} must be a non-empty array`);
  }
  return value.map((item) => requiredText(item, fieldName));
}

function optionalTextArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`coordinator decision ${fieldName} must be an array`);
  }
  return value.map((item) => requiredText(item, fieldName));
}

function validateDecision(
  value: unknown,
  allowedActions: readonly string[],
): CoordinatorDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("coordinator decision must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const knownActions = new Set([
    "append_observation",
    "search_official_knowledge",
    "run_risk_assessment",
    "draft_resolution_proposal",
    "request_user_confirmation",
    "record_user_confirmation",
  ]);
  if (typeof record.action !== "string" || !knownActions.has(record.action)) {
    throw new Error("coordinator decision action is invalid");
  }
  if (!allowedActions.includes(record.action)) {
    throw new Error(
      "coordinator selected an action that is not currently allowed",
    );
  }

  switch (record.action) {
    case "append_observation":
      return {
        action: record.action,
        observationType: requiredText(record.observationType, "observationType"),
        content: requiredText(record.content, "content"),
      };
    case "search_official_knowledge":
      return {
        action: record.action,
        queryText: requiredText(record.queryText, "queryText"),
      };
    case "run_risk_assessment":
      return {
        action: record.action,
        searchRunId: requiredPositiveInteger(record.searchRunId, "searchRunId"),
      };
    case "draft_resolution_proposal": {
      if (!Array.isArray(record.evidenceSearchHitIds) || record.evidenceSearchHitIds.length === 0) {
        throw new Error(
          "coordinator decision evidenceSearchHitIds must be a non-empty array",
        );
      }
      const basisObservationEventId =
        record.basisObservationEventId === undefined
          ? undefined
          : requiredPositiveInteger(
              record.basisObservationEventId,
              "basisObservationEventId",
            );
      return {
        action: record.action,
        riskAssessmentId: requiredPositiveInteger(
          record.riskAssessmentId,
          "riskAssessmentId",
        ),
        evidenceSearchHitIds: record.evidenceSearchHitIds.map((item) =>
          requiredPositiveInteger(item, "evidenceSearchHitIds"),
        ),
        summary: requiredText(record.summary, "summary"),
        confirmedFacts: requiredTextArray(record.confirmedFacts, "confirmedFacts"),
        assumptions: optionalTextArray(record.assumptions, "assumptions"),
        steps: requiredTextArray(record.steps, "steps"),
        stopConditions: requiredTextArray(record.stopConditions, "stopConditions"),
        expectedObservations: requiredTextArray(
          record.expectedObservations,
          "expectedObservations",
        ),
        ...(basisObservationEventId === undefined
          ? {}
          : { basisObservationEventId }),
      };
    }
    case "request_user_confirmation":
      return {
        action: record.action,
        proposalId: requiredPositiveInteger(record.proposalId, "proposalId"),
      };
    case "record_user_confirmation": {
      if (record.outcome !== "resolved" && record.outcome !== "not_resolved") {
        throw new Error("coordinator decision outcome is invalid");
      }
      return {
        action: record.action,
        proposalId: requiredPositiveInteger(record.proposalId, "proposalId"),
        outcome: record.outcome,
        actualResult: requiredText(record.actualResult, "actualResult"),
      };
    }
  }
}

export function createQwenCoordinatorModel(
  options: CreateQwenCoordinatorModelOptions,
): QwenCoordinatorModel {
  const apiKey = requiredText(options.apiKey, "API key");
  const endpoint = options.endpoint ?? defaultEndpoint;
  const modelId = requiredText(
    options.modelId ?? QWEN_COORDINATOR_MODEL_ID,
    "model ID",
  );
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    requestTimeoutMs > 600_000
  ) {
    throw new Error("coordinator request timeout must be between 1 and 600000 ms");
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    modelId,
    promptVersion: QWEN_COORDINATOR_PROMPT_VERSION,
    async decide(input): Promise<CoordinatorDecision> {
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
        body: JSON.stringify({
          model: modelId,
          messages: [
            {
              role: "system",
              content: [
                "你是工业工单协调助手，只能从当前允许动作中选择一个动作。",
                "固定规则、数据库状态和人工确认高于模型判断。",
                "输出必须是一个JSON对象，不得输出JSON之外的文字。",
                "不要自行宣布设备恢复，不要编造官方证据。",
                "严格使用以下动作参数契约，不得新增字段：",
                coordinatorActionContract,
              ].join("\n"),
            },
            {
              role: "user",
              content: JSON.stringify({
                userMessage: input.userMessage,
                allowedActions: input.allowedActions,
                workOrderContext: input.workOrderContext,
              }),
            },
          ],
          response_format: { type: "json_object" },
          enable_thinking: false,
          temperature: 0,
        }),
      });
      if (!response.ok) {
        throw new Error(`qwen coordinator request failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("qwen coordinator response did not contain text content");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error("coordinator model returned invalid JSON");
      }
      return validateDecision(parsed, input.allowedActions);
    },
  };
}
