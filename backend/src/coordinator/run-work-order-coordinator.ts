import type { PGliteInterface } from "@electric-sql/pglite";

import { appendObservation } from "../agent-tools/append-observation.ts";
import { assessEvidenceAndRunRisk } from "../agent-tools/assess-evidence-and-run-risk.ts";
import { draftResolutionProposal } from "../agent-tools/draft-resolution-proposal.ts";
import {
  getWorkOrderContext,
  type WorkOrderContextResult,
} from "../agent-tools/get-work-order-context.ts";
import { recordUserConfirmation } from "../agent-tools/record-user-confirmation.ts";
import { requestUserConfirmation } from "../agent-tools/request-user-confirmation.ts";
import { searchOfficialKnowledge } from "../agent-tools/search-official-knowledge.ts";
import type { QwenAnswerabilityJudge } from "../evaluation/qwen-answerability-judge.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";
import type {
  CoordinatorDecision,
  CoordinatorModelInput,
} from "./qwen-coordinator-model.ts";

export interface WorkOrderCoordinatorModel {
  modelId: string;
  promptVersion: string;
  decide(input: CoordinatorModelInput): Promise<CoordinatorDecision>;
}

export interface CoordinateWorkOrderTurnInput {
  workOrderId: number;
  requesterMembershipId: number;
  userMessage: string;
  requestId: string;
  model: WorkOrderCoordinatorModel;
  embedder: QueryEmbedder;
  answerabilityJudge: QwenAnswerabilityJudge;
  excludedActions?: readonly CoordinatorDecision["action"][];
}

export interface CoordinatedWorkOrderStep {
  action: CoordinatorDecision["action"];
  decision: CoordinatorDecision;
  toolResult: unknown;
  contextBefore: WorkOrderContextResult;
  contextAfter: WorkOrderContextResult;
}

function normalizeRequestId(value: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error("coordinator request id must not be blank");
  return normalized;
}

export async function coordinateWorkOrderTurn(
  database: PGliteInterface,
  input: CoordinateWorkOrderTurnInput,
): Promise<CoordinatedWorkOrderStep> {
  const requestId = normalizeRequestId(input.requestId);
  const contextBefore = await getWorkOrderContext(database, {
    workOrderId: input.workOrderId,
    requesterMembershipId: input.requesterMembershipId,
  });
  const excludedActions = new Set(input.excludedActions ?? []);
  const effectiveAllowedActions = contextBefore.allowedActions.filter(
    (action) => !excludedActions.has(action),
  );
  if (effectiveAllowedActions.length === 0) {
    throw new Error("work order has no coordinator action available");
  }
  const decision = await input.model.decide({
    userMessage: input.userMessage,
    workOrderContext: contextBefore,
    allowedActions: effectiveAllowedActions,
  });
  if (!effectiveAllowedActions.includes(decision.action)) {
    throw new Error("coordinator selected an action that is not currently allowed");
  }

  const idempotencyKey = `${requestId}:${decision.action}`;
  let toolResult: unknown;
  switch (decision.action) {
    case "append_observation":
      toolResult = await appendObservation(database, {
        workOrderId: input.workOrderId,
        requesterMembershipId: input.requesterMembershipId,
        observationType: decision.observationType as
          | "symptom"
          | "action_taken"
          | "measurement"
          | "environment"
          | "user_feedback",
        content: decision.content,
        idempotencyKey,
      });
      break;
    case "search_official_knowledge":
      toolResult = await searchOfficialKnowledge(database, {
        workOrderId: input.workOrderId,
        requesterMembershipId: input.requesterMembershipId,
        queryText: decision.queryText,
        idempotencyKey,
        embedder: input.embedder,
        // Top five is the frozen v2 recall policy. These are candidates only;
        // the mandatory evidence gate below selects at most one executable hit.
        limit: 5,
      });
      break;
    case "run_risk_assessment":
      toolResult = await assessEvidenceAndRunRisk(database, {
        workOrderId: input.workOrderId,
        requesterMembershipId: input.requesterMembershipId,
        searchRunId: decision.searchRunId,
        evidenceIdempotencyKey: `${idempotencyKey}:evidence`,
        riskIdempotencyKey: `${idempotencyKey}:risk`,
        judge: input.answerabilityJudge,
      });
      break;
    case "draft_resolution_proposal":
      toolResult = await draftResolutionProposal(database, {
        workOrderId: input.workOrderId,
        requesterMembershipId: input.requesterMembershipId,
        riskAssessmentId: decision.riskAssessmentId,
        evidenceSearchHitIds: decision.evidenceSearchHitIds,
        summary: decision.summary,
        confirmedFacts: decision.confirmedFacts,
        assumptions: decision.assumptions,
        steps: decision.steps,
        stopConditions: decision.stopConditions,
        expectedObservations: decision.expectedObservations,
        modelId: input.model.modelId,
        modelVersion: input.model.modelId,
        promptVersion: input.model.promptVersion,
        idempotencyKey,
        ...(decision.basisObservationEventId === undefined
          ? {}
          : { basisObservationEventId: decision.basisObservationEventId }),
      });
      break;
    case "request_user_confirmation":
      toolResult = await requestUserConfirmation(database, {
        workOrderId: input.workOrderId,
        requesterMembershipId: input.requesterMembershipId,
        proposalId: decision.proposalId,
        idempotencyKey,
      });
      break;
    case "record_user_confirmation":
      toolResult = await recordUserConfirmation(database, {
        workOrderId: input.workOrderId,
        requesterMembershipId: input.requesterMembershipId,
        proposalId: decision.proposalId,
        outcome: decision.outcome,
        actualResult: decision.actualResult,
        idempotencyKey,
      });
      break;
  }

  const contextAfter = await getWorkOrderContext(database, {
    workOrderId: input.workOrderId,
    requesterMembershipId: input.requesterMembershipId,
  });
  return {
    action: decision.action,
    decision,
    toolResult,
    contextBefore,
    contextAfter,
  };
}

export interface RunWorkOrderCoordinatorInput
  extends CoordinateWorkOrderTurnInput {
  maxSteps?: number;
}

export interface WorkOrderCoordinatorRun {
  steps: CoordinatedWorkOrderStep[];
  context: WorkOrderContextResult;
  stopReason:
    | "awaiting_user_confirmation"
    | "awaiting_human"
    | "resolved"
    | "terminal"
    | "user_input_required";
}

function stopReason(
  context: WorkOrderContextResult,
): WorkOrderCoordinatorRun["stopReason"] | null {
  switch (context.workOrder.status) {
    case "awaiting_user_confirmation":
      return "awaiting_user_confirmation";
    case "awaiting_human":
    case "human_processing":
      return "awaiting_human";
    case "resolved":
      return "resolved";
    case "closed":
    case "cancelled":
      return "terminal";
  }
  if (
    context.allowedActions.length === 0 ||
    (context.allowedActions.length === 1 &&
      context.allowedActions[0] === "append_observation")
  ) {
    return "user_input_required";
  }
  return null;
}

export async function runWorkOrderCoordinator(
  database: PGliteInterface,
  input: RunWorkOrderCoordinatorInput,
): Promise<WorkOrderCoordinatorRun> {
  const requestId = normalizeRequestId(input.requestId);
  const maxSteps = input.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) {
    throw new Error("coordinator max steps must be between 1 and 20");
  }

  const steps: CoordinatedWorkOrderStep[] = [];
  let userInputObservationConsumed = false;
  let context = await getWorkOrderContext(database, {
    workOrderId: input.workOrderId,
    requesterMembershipId: input.requesterMembershipId,
  });
  const initialStop = stopReason(context);
  if (initialStop) return { steps, context, stopReason: initialStop };

  for (let index = 1; index <= maxSteps; index += 1) {
    const step = await coordinateWorkOrderTurn(database, {
      ...input,
      requestId: `${requestId}:step-${index}`,
      excludedActions: userInputObservationConsumed
        ? ["append_observation"]
        : [],
    });
    steps.push(step);
    if (step.action === "append_observation") {
      userInputObservationConsumed = true;
    }
    context = step.contextAfter;
    const reason = stopReason(context);
    if (reason) return { steps, context, stopReason: reason };
  }
  throw new Error("coordinator reached the maximum step limit");
}
