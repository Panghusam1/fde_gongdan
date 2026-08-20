import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AutoModel,
  AutoTokenizer,
  env,
  FeatureExtractionPipeline,
  XLMRobertaTokenizer,
} from "@huggingface/transformers";

import type { QueryEmbedder } from "./search-approved-knowledge.ts";

export const MULTILINGUAL_E5_SMALL_MODEL_ID =
  "Xenova/multilingual-e5-small";
export const MULTILINGUAL_E5_SMALL_MODEL_REVISION =
  "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const MULTILINGUAL_E5_SMALL_DIMENSIONS = 384;
export const MULTILINGUAL_E5_SMALL_MODEL_FILE = "onnx/model_quantized.onnx";
export const MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256 =
  "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193";

async function loadPinnedLocalTokenizer(cacheDirectory: string) {
  const modelDirectory = join(
    cacheDirectory,
    MULTILINGUAL_E5_SMALL_MODEL_ID,
    MULTILINGUAL_E5_SMALL_MODEL_REVISION,
  );
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile(join(modelDirectory, "tokenizer.json"), "utf8"),
    readFile(join(modelDirectory, "tokenizer_config.json"), "utf8"),
  ]);
  return new XLMRobertaTokenizer(
    JSON.parse(tokenizerJson),
    JSON.parse(tokenizerConfig),
  );
}

export async function createMultilingualE5SmallEmbedder(options?: {
  cacheDirectory?: string;
  localFilesOnly?: boolean;
  remoteHost?: string;
}): Promise<QueryEmbedder> {
  const previousRemoteHost = env.remoteHost;
  if (options?.remoteHost) env.remoteHost = options.remoteHost;

  let extractor: FeatureExtractionPipeline;
  try {
    const pretrainedOptions = {
      revision: MULTILINGUAL_E5_SMALL_MODEL_REVISION,
      cache_dir: options?.cacheDirectory,
      local_files_only: options?.localFilesOnly ?? false,
    };
    const [tokenizer, model] = await Promise.all([
      options?.localFilesOnly
        ? options.cacheDirectory
          ? loadPinnedLocalTokenizer(options.cacheDirectory)
          : Promise.reject(
              new Error("local E5 loading requires an explicit cache directory"),
            )
        : AutoTokenizer.from_pretrained(
            MULTILINGUAL_E5_SMALL_MODEL_ID,
            pretrainedOptions,
          ),
      AutoModel.from_pretrained(MULTILINGUAL_E5_SMALL_MODEL_ID, {
        ...pretrainedOptions,
        dtype: "q8",
        device: "cpu",
      }),
    ]);
    extractor = new FeatureExtractionPipeline({
      task: "feature-extraction",
      tokenizer,
      model,
    });
  } finally {
    env.remoteHost = previousRemoteHost;
  }

  const embed = async (prefix: "query: " | "passage: ", text: string) => {
    const normalizedText = text.trim();
    if (normalizedText === "") throw new Error("E5 input text must not be blank");
    const output = await extractor(`${prefix}${normalizedText}`, {
      pooling: "mean",
      normalize: true,
    });
    const embedding = Array.from(output.data, (value) => Number(value));
    if (embedding.length !== MULTILINGUAL_E5_SMALL_DIMENSIONS) {
      throw new Error(
        `E5 returned ${embedding.length} dimensions instead of ${MULTILINGUAL_E5_SMALL_DIMENSIONS}`,
      );
    }
    return embedding;
  };

  return {
    modelId: MULTILINGUAL_E5_SMALL_MODEL_ID,
    modelRevision: MULTILINGUAL_E5_SMALL_MODEL_REVISION,
    dimensions: MULTILINGUAL_E5_SMALL_DIMENSIONS,
    poolingMethod: "mean",
    isNormalized: true,
    embedPassage: (text: string) => embed("passage: ", text),
    embedQuery: (text: string) => embed("query: ", text),
  };
}
