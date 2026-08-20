import type { PGliteInterface } from "@electric-sql/pglite";

import {
  QWEN_ANSWERABILITY_PROMPT_VERSION_V6,
  createQwenAnswerabilityJudgeV6FromEnvironment,
  type QwenAnswerabilityJudgeV6,
} from "../evaluation/qwen-answerability-judge-v6.ts";
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

export const WORK_ORDER_SOURCE_IDENTITY_BINDING_VERSION =
  "database-source-chain-v1" as const;

export interface WorkOrderMainChainOptions {
  answerabilityFetchImplementation?: typeof fetch;
  coordinatorFetchImplementation?: typeof fetch;
}

export interface WorkOrderMainChainDependencies {
  coordinatorModel: QwenCoordinatorModelV3;
  sourceAwareAnswerabilityModel: SourceAwareAnswerabilityJudge;
}

export interface WorkOrderMainChain {
  versions: {
    coordinatorPrompt: QwenCoordinatorModelV3["promptVersion"];
    answerabilityPrompt: QwenAnswerabilityJudgeV6["promptVersion"];
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

export function createWorkOrderMainChain(
  database: PGliteInterface,
  embedder: QueryEmbedder,
  dependencies: WorkOrderMainChainDependencies,
): WorkOrderMainChain {
  if (
    dependencies.sourceAwareAnswerabilityModel.promptVersion !==
    QWEN_ANSWERABILITY_PROMPT_VERSION_V6
  ) {
    throw new Error(
      "formal work-order main chain requires answerability v6",
    );
  }
  const coordinatorModel = dependencies.coordinatorModel;
  const answerabilityJudge = createSourceAwareWorkOrderJudge(
    database,
    dependencies.sourceAwareAnswerabilityModel,
  );

  return {
    versions: {
      coordinatorPrompt: coordinatorModel.promptVersion,
      answerabilityPrompt: QWEN_ANSWERABILITY_PROMPT_VERSION_V6,
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

export function createWorkOrderMainChainFromEnvironment(
  database: PGliteInterface,
  embedder: QueryEmbedder,
  environment: QwenCoordinatorV3Environment = process.env,
  options: WorkOrderMainChainOptions = {},
): WorkOrderMainChain {
  const coordinatorModel = createQwenCoordinatorModelV3FromEnvironment(
    environment,
    options.coordinatorFetchImplementation
      ? { fetchImplementation: options.coordinatorFetchImplementation }
      : {},
  );
  const sourceAwareModel = createQwenAnswerabilityJudgeV6FromEnvironment(
    environment,
    options.answerabilityFetchImplementation
      ? { fetchImplementation: options.answerabilityFetchImplementation }
      : {},
  );
  return createWorkOrderMainChain(database, embedder, {
    coordinatorModel,
    sourceAwareAnswerabilityModel: sourceAwareModel,
  });
}
