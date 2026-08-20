import type { PGliteInterface } from "@electric-sql/pglite";

import {
  CONFIRMED_SOURCE_CONSTRAINT_VERSION,
  createConfirmedSourceWorkOrderJudge,
  type ConfirmedSourceRequest,
} from "../evaluation/confirmed-source-work-order-judge.ts";
import {
  QWEN_ANSWERABILITY_PROMPT_VERSION_V8,
  createQwenAnswerabilityJudgeV8FromEnvironment,
  type QwenAnswerabilityJudgeV8,
} from "../evaluation/qwen-answerability-judge-v8.ts";
import type { QwenAnswerabilityJudge } from "../evaluation/qwen-answerability-judge.ts";
import type { SourceAwareAnswerabilityJudge } from "../evaluation/source-aware-work-order-judge.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";
import type { QwenCoordinatorModelV3 } from "./qwen-coordinator-model-v3.ts";
import {
  createQwenCoordinatorModelV3FromEnvironment,
  type QwenCoordinatorV3Environment,
} from "./qwen-coordinator-runtime-v3.ts";
import {
  runWorkOrderCoordinatorV2,
  type RunWorkOrderCoordinatorV2Input,
  type WorkOrderCoordinatorRunV2,
} from "./run-work-order-coordinator-v2.ts";
import { WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION } from "./work-order-main-chain.ts";

export interface WorkOrderMainChainV4Dependencies {
  coordinatorModel: QwenCoordinatorModelV3;
  sourceAwareAnswerabilityModel: SourceAwareAnswerabilityJudge;
}

export interface RunWorkOrderMainChainV4Input
  extends Omit<
    RunWorkOrderCoordinatorV2Input,
    "model" | "embedder" | "answerabilityJudge"
  > {
  confirmedSourceRequest: ConfirmedSourceRequest;
}

export interface WorkOrderMainChainV4 {
  versions: {
    coordinatorPrompt: QwenCoordinatorModelV3["promptVersion"];
    answerabilityPrompt: QwenAnswerabilityJudgeV8["promptVersion"];
    sourceIdentityBinding: typeof WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION;
    sourceConstraint: typeof CONFIRMED_SOURCE_CONSTRAINT_VERSION;
  };
  coordinatorModel: QwenCoordinatorModelV3;
  createConfirmedAnswerabilityJudge(
    request: ConfirmedSourceRequest,
  ): QwenAnswerabilityJudge;
  run(input: RunWorkOrderMainChainV4Input): Promise<WorkOrderCoordinatorRunV2>;
}

export function createWorkOrderMainChainV4(
  database: PGliteInterface,
  embedder: QueryEmbedder,
  dependencies: WorkOrderMainChainV4Dependencies,
): WorkOrderMainChainV4 {
  if (
    dependencies.sourceAwareAnswerabilityModel.promptVersion !==
    QWEN_ANSWERABILITY_PROMPT_VERSION_V8
  ) {
    throw new Error("formal work-order main chain v4 requires answerability v8");
  }
  const coordinatorModel = dependencies.coordinatorModel;
  const contentJudge = dependencies.sourceAwareAnswerabilityModel;

  function createConfirmedAnswerabilityJudge(
    request: ConfirmedSourceRequest,
  ): QwenAnswerabilityJudge {
    return createConfirmedSourceWorkOrderJudge(database, contentJudge, request);
  }

  return {
    versions: {
      coordinatorPrompt: coordinatorModel.promptVersion,
      answerabilityPrompt: QWEN_ANSWERABILITY_PROMPT_VERSION_V8,
      sourceIdentityBinding: WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION,
      sourceConstraint: CONFIRMED_SOURCE_CONSTRAINT_VERSION,
    },
    coordinatorModel,
    createConfirmedAnswerabilityJudge,
    run(input) {
      const { confirmedSourceRequest, ...coordinatorInput } = input;
      return runWorkOrderCoordinatorV2(database, {
        ...coordinatorInput,
        model: coordinatorModel,
        embedder,
        answerabilityJudge:
          createConfirmedAnswerabilityJudge(confirmedSourceRequest),
      });
    },
  };
}

export function createWorkOrderMainChainV4FromEnvironment(
  database: PGliteInterface,
  embedder: QueryEmbedder,
  environment: QwenCoordinatorV3Environment = process.env,
  options: {
    answerabilityFetchImplementation?: typeof fetch;
    coordinatorFetchImplementation?: typeof fetch;
  } = {},
): WorkOrderMainChainV4 {
  const coordinatorModel = createQwenCoordinatorModelV3FromEnvironment(
    environment,
    options.coordinatorFetchImplementation
      ? { fetchImplementation: options.coordinatorFetchImplementation }
      : {},
  );
  const sourceAwareAnswerabilityModel =
    createQwenAnswerabilityJudgeV8FromEnvironment(
      environment,
      options.answerabilityFetchImplementation
        ? { fetchImplementation: options.answerabilityFetchImplementation }
        : {},
    );
  return createWorkOrderMainChainV4(database, embedder, {
    coordinatorModel,
    sourceAwareAnswerabilityModel,
  });
}
