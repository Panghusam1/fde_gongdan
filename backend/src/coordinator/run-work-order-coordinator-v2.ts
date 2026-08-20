import type { PGliteInterface } from "@electric-sql/pglite";

import type { WorkOrderContextResult } from "../agent-tools/get-work-order-context.ts";
import {
  coordinateWorkOrderTurn,
  runWorkOrderCoordinator,
  type CoordinatedWorkOrderStep,
  type CoordinateWorkOrderTurnInput,
  type RunWorkOrderCoordinatorInput,
  type WorkOrderCoordinatorModel,
  type WorkOrderCoordinatorRun,
} from "./run-work-order-coordinator.ts";
import {
  bindCoordinatorDecisionToContext,
  type QwenCoordinatorModelV3,
} from "./qwen-coordinator-model-v3.ts";
import type {
  CoordinatorDecision,
  CoordinatorModelInput,
} from "./qwen-coordinator-model.ts";

export const COORDINATOR_STATE_BINDING_VERSION =
  "coordinator-state-binding-v1" as const;

interface UntrustedCoordinatorModel {
  modelId: string;
  promptVersion: string;
  decide(input: CoordinatorModelInput): Promise<unknown>;
}

export interface CoordinateWorkOrderTurnV2Input
  extends Omit<CoordinateWorkOrderTurnInput, "model"> {
  model: UntrustedCoordinatorModel | QwenCoordinatorModelV3;
}

export interface CoordinatedWorkOrderStepV2 extends CoordinatedWorkOrderStep {
  modelDecision: unknown;
  stateBindingVersion: typeof COORDINATOR_STATE_BINDING_VERSION;
}

function createStateBoundModel(
  model: UntrustedCoordinatorModel,
  onRawDecision?: (decision: unknown) => void,
): WorkOrderCoordinatorModel {
  return {
    modelId: model.modelId,
    promptVersion: model.promptVersion,
    async decide(input): Promise<CoordinatorDecision> {
      const rawDecision = await model.decide(input);
      onRawDecision?.(rawDecision);
      return bindCoordinatorDecisionToContext(
        rawDecision,
        input.workOrderContext,
      ) as CoordinatorDecision;
    },
  };
}

export async function coordinateWorkOrderTurnV2(
  database: PGliteInterface,
  input: CoordinateWorkOrderTurnV2Input,
): Promise<CoordinatedWorkOrderStepV2> {
  let modelDecision: unknown;
  const step = await coordinateWorkOrderTurn(database, {
    ...input,
    model: createStateBoundModel(input.model, (decision) => {
      modelDecision = decision;
    }),
  });
  return {
    ...step,
    modelDecision,
    stateBindingVersion: COORDINATOR_STATE_BINDING_VERSION,
  };
}

export interface RunWorkOrderCoordinatorV2Input
  extends Omit<RunWorkOrderCoordinatorInput, "model"> {
  model: UntrustedCoordinatorModel | QwenCoordinatorModelV3;
}

export interface WorkOrderCoordinatorRunV2 extends WorkOrderCoordinatorRun {
  stateBindingVersion: typeof COORDINATOR_STATE_BINDING_VERSION;
  finalContext: WorkOrderContextResult;
}

export async function runWorkOrderCoordinatorV2(
  database: PGliteInterface,
  input: RunWorkOrderCoordinatorV2Input,
): Promise<WorkOrderCoordinatorRunV2> {
  const run = await runWorkOrderCoordinator(database, {
    ...input,
    model: createStateBoundModel(input.model),
  });
  return {
    ...run,
    stateBindingVersion: COORDINATOR_STATE_BINDING_VERSION,
    finalContext: run.context,
  };
}
