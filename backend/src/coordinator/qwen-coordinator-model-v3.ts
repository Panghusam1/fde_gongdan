import {
  createQwenCoordinatorModel,
  QWEN_COORDINATOR_MODEL_ID,
  type CoordinatorDecision,
  type CoordinatorModelInput,
  type CreateQwenCoordinatorModelOptions,
} from "./qwen-coordinator-model.ts";

export const QWEN_COORDINATOR_PROMPT_VERSION_V3 =
  "coordinator-v3-state-bound" as const;

export interface QwenCoordinatorModelV3 {
  modelId: string;
  promptVersion: typeof QWEN_COORDINATOR_PROMPT_VERSION_V3;
  decide(input: CoordinatorModelInput): Promise<CoordinatorDecision>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/**
 * The model drafts business intent. Database identifiers are application state,
 * so the application copies them from the current work-order context.
 */
export function bindCoordinatorDecisionToContext(
  value: unknown,
  contextValue: unknown,
): unknown {
  const decision = asRecord(value);
  if (!decision || typeof decision.action !== "string") return value;
  const context = asRecord(contextValue);
  if (!context) return value;
  const latestSearch = asRecord(context.latestSearch);
  const latestRisk = asRecord(context.latestRiskAssessment);
  const latestProposal = asRecord(context.latestProposal);

  switch (decision.action) {
    case "run_risk_assessment": {
      const searchRunId = positiveInteger(latestSearch?.searchRunId);
      return searchRunId === null ? decision : { ...decision, searchRunId };
    }
    case "draft_resolution_proposal": {
      const riskAssessmentId = positiveInteger(latestRisk?.riskAssessmentId);
      const selectedSearchHitId = positiveInteger(
        latestRisk?.selectedSearchHitId,
      );
      const observations = Array.isArray(context.observations)
        ? context.observations
        : [];
      const feedback = observations
        .map(asRecord)
        .find((event) => event?.eventType === "user_feedback_recorded");
      const basisObservationEventId = positiveInteger(feedback?.eventId);
      const isSecondProposal = latestProposal?.feedbackOutcome === "not_resolved";
      const {
        riskAssessmentId: _ignoredRiskId,
        evidenceSearchHitIds: _ignoredHitIds,
        basisObservationEventId: _ignoredBasisId,
        ...businessFields
      } = decision;
      return {
        ...businessFields,
        ...(riskAssessmentId === null
          ? { riskAssessmentId: decision.riskAssessmentId }
          : { riskAssessmentId }),
        ...(selectedSearchHitId === null
          ? { evidenceSearchHitIds: decision.evidenceSearchHitIds }
          : { evidenceSearchHitIds: [selectedSearchHitId] }),
        ...(isSecondProposal && basisObservationEventId !== null
          ? { basisObservationEventId }
          : {}),
      };
    }
    case "request_user_confirmation":
    case "record_user_confirmation": {
      const proposalId = positiveInteger(latestProposal?.proposalId);
      return proposalId === null ? decision : { ...decision, proposalId };
    }
    default:
      return decision;
  }
}

function addStateBoundaryToPrompt(init: RequestInit | undefined): RequestInit {
  if (typeof init?.body !== "string") return init ?? {};
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return init;
  }
  if (!Array.isArray(body.messages)) return init;
  body.messages = body.messages.map((messageValue) => {
    const message = asRecord(messageValue);
    if (message?.role !== "system" || typeof message.content !== "string") {
      return messageValue;
    }
    return {
      ...message,
      content: [
        message.content,
        "数据库编号属于程序状态：只能照抄当前工单上下文，禁止猜测或新造编号。",
        "第一版方案不得输出basisObservationEventId；不要用null代替缺省字段。",
      ].join("\n"),
    };
  });
  return { ...init, body: JSON.stringify(body) };
}

async function normalizeProviderResponse(
  response: Response,
  workOrderContext: unknown,
): Promise<Response> {
  if (!response.ok) return response;
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  if (typeof message?.content === "string") {
    try {
      const parsedDecision = JSON.parse(message.content) as unknown;
      const boundDecision = bindCoordinatorDecisionToContext(
        parsedDecision,
        workOrderContext,
      );
      message.content = JSON.stringify(boundDecision);
    } catch {
      // Keep invalid model output unchanged so the existing strict parser rejects it.
    }
  }
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createQwenCoordinatorModelV3(
  options: CreateQwenCoordinatorModelOptions,
): QwenCoordinatorModelV3 {
  const providerFetch = options.fetchImplementation ?? fetch;
  const modelId = options.modelId?.trim() || QWEN_COORDINATOR_MODEL_ID;
  return {
    modelId,
    promptVersion: QWEN_COORDINATOR_PROMPT_VERSION_V3,
    async decide(input) {
      const model = createQwenCoordinatorModel({
        ...options,
        fetchImplementation: async (request, init) => {
          const response = await providerFetch(
            request,
            addStateBoundaryToPrompt(init),
          );
          return normalizeProviderResponse(response, input.workOrderContext);
        },
      });
      return model.decide(input);
    },
  };
}
