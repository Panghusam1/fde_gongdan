import { readdir, readFile } from "node:fs/promises";

import {
  assertSourceIdentityQuestionsAreNovel,
  validateSourceIdentityUnseenDataset,
  type SourceIdentityUnseenDataset,
} from "./source-identity-unseen-dataset.ts";

export interface SourceIdentityUnseenV2Dataset
  extends Omit<SourceIdentityUnseenDataset, "dataset_id" | "strategy"> {
  dataset_id: "source-identity-unseen-v2";
  strategy: Omit<SourceIdentityUnseenDataset["strategy"], "judge_prompt_version"> & {
    judge_prompt_version: "answerability-v7-source-policy";
  };
}

function collectQuestions(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectQuestions(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      ["question", "query", "query_text", "user_message", "userMessage"].includes(key)
    ) {
      output.push(child);
    } else if (key === "search_queries" && Array.isArray(child)) {
      output.push(...child.filter((item): item is string => typeof item === "string"));
    } else {
      collectQuestions(child, output);
    }
  }
}

export function validateSourceIdentityUnseenV2Dataset(
  raw: unknown,
): SourceIdentityUnseenV2Dataset {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("source identity unseen v2 dataset must be an object");
  }
  const dataset = raw as SourceIdentityUnseenV2Dataset;
  if (
    dataset.dataset_id !== "source-identity-unseen-v2" ||
    dataset.strategy?.judge_prompt_version !== "answerability-v7-source-policy"
  ) {
    throw new Error("source identity unseen v2 identity is invalid");
  }
  validateSourceIdentityUnseenDataset({
    ...dataset,
    dataset_id: "source-identity-unseen-v1",
    strategy: {
      ...dataset.strategy,
      judge_prompt_version: "answerability-v6-source-aware",
    },
  });
  const mismatchCases = dataset.cases.filter(
    ({ source_expectation }) => source_expectation === "mismatch",
  );
  if (
    mismatchCases.length !== 6 ||
    mismatchCases.some(
      ({ mismatch_dimensions }) =>
        !mismatch_dimensions.includes("instruction_override"),
    )
  ) {
    throw new Error("source identity unseen v2 must isolate six instruction override cases");
  }
  return dataset;
}

export async function loadSourceIdentityUnseenV2Dataset(
  path = "data/evaluation/source-identity-unseen-v2.json",
): Promise<SourceIdentityUnseenV2Dataset> {
  const dataset = validateSourceIdentityUnseenV2Dataset(
    JSON.parse(await readFile(path, "utf8")),
  );
  const earlierQuestions: string[] = [];
  const names = (await readdir("data/evaluation"))
    .filter((name) => name.endsWith(".json") && name !== "source-identity-unseen-v2.json")
    .sort();
  for (const name of names) {
    collectQuestions(
      JSON.parse(await readFile(`data/evaluation/${name}`, "utf8")),
      earlierQuestions,
    );
  }
  assertSourceIdentityQuestionsAreNovel(
    dataset as unknown as SourceIdentityUnseenDataset,
    earlierQuestions,
  );
  return dataset;
}
