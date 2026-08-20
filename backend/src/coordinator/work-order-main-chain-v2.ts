import type { PGliteInterface } from "@electric-sql/pglite";

import {
  QWEN_ANSWERABILITY_PROMPT_VERSION_V7,
  createQwenAnswerabilityJudgeV7FromEnvironment,
  type QwenAnswerabilityJudgeV7,
} from "../evaluation/qwen-answerability-judge-v7.ts";
import {
  createSourceAwareWorkOrderJudge,
  type SourceAwareAnswerabilityJudge,
} from "../evaluation/source-aware-work-order-judge.ts";
import type { QwenAnswerabilityJudge } from "../evaluation/qwen-answerability-judge.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";
import {
  createQwenCoordinatorModelV3FromEnvironment,
  type QwenCoordinatorV3Environment,
} from "./qwen-coordinator-runtime-v3.ts";
import type { QwenCoordinatorModelV3 } from "./qwen-coordinator-model-v3.ts";
import {
  runWorkOrderCoordinatorV2,
  type RunWorkOrderCoordinatorV2Input,
  type WorkOrderCoordinatorRunV2,
} from "./run-work-order-coordinator-v2.ts";
import { WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION } from "./work-order-main-chain.ts";

export interface WorkOrderMainChainV2Options {
  answerabilityFetchImplementation?: typeof fetch;
  coordinatorFetchImplementation?: typeof fetch;
}

export interface WorkOrderMainChainV2Dependencies {
  coordinatorModel: QwenCoordinatorModelV3;
  sourceAwareAnswerabilityModel: SourceAwareAnswerabilityJudge;
}

export interface WorkOrderMainChainV2 {
  versions: {
    coordinatorPrompt: QwenCoordinatorModelV3["promptVersion"];
    answerabilityPrompt: QwenAnswerabilityJudgeV7["promptVersion"];
    sourceIdentityBinding: typeof WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION;
  };
  coordinatorModel: QwenCoordinatorModelV3;
  answerabilityJudge: QwenAnswerabilityJudge;
  run(
    input: Omit<
      RunWorkOrderCoordinatorV2Input,
      "model" | "embedder" | "answerabilityJudge"
    >,
  ): Promise<WorkOrderCoordinatorRunV2>;
}

export function createWorkOrderMainChainV2(
  database: PGliteInterface,
  embedder: QueryEmbedder,
  dependencies: WorkOrderMainChainV2Dependencies,
): WorkOrderMainChainV2 {
  if (
    dependencies.sourceAwareAnswerabilityModel.promptVersion !==
    QWEN_ANSWERABILITY_PROMPT_VERSION_V7
  ) {
    throw new Error("formal work-order main chain v2 requires answerability v7");
  }
  const coordinatorModel = dependencies.coordinatorModel;
  const answerabilityJudge = createSourceAwareWorkOrderJudge(
    database,
    dependencies.sourceAwareAnswerabilityModel,
  );
  return {
    versions: {
      coordinatorPrompt: coordinatorModel.promptVersion,
      answerabilityPrompt: QWEN_ANSWERABILITY_PROMPT_VERSION_V7,
      sourceIdentityBinding: WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION,
    },
    coordinatorModel,
    answerabilityJudge,
    run(input) {
      return runWorkOrderCoordinatorV2(database, {
        ...input,
        model: coordinatorModel,
        embedder,
        answerabilityJudge,
      });
    },
  };
}

export function createWorkOrderMainChainV2FromEnvironment(
  database: PGliteInterface,
  embedder: QueryEmbedder,
  environment: QwenCoordinatorV3Environment = process.env,
  options: WorkOrderMainChainV2Options = {},
): WorkOrderMainChainV2 {
  const coordinatorModel = createQwenCoordinatorModelV3FromEnvironment(
    environment,
    options.coordinatorFetchImplementation
      ? { fetchImplementation: options.coordinatorFetchImplementation }
      : {},
  );
  const sourceAwareAnswerabilityModel =
    createQwenAnswerabilityJudgeV7FromEnvironment(
      environment,
      options.answerabilityFetchImplementation
        ? { fetchImplementation: options.answerabilityFetchImplementation }
        : {},
    );
  return createWorkOrderMainChainV2(database, embedder, {
    coordinatorModel,
    sourceAwareAnswerabilityModel,
  });
}
