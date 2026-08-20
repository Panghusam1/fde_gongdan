import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

import {
  createMultilingualE5SmallEmbedder,
  MULTILINGUAL_E5_SMALL_MODEL_FILE,
  MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
} from "../src/retrieval/multilingual-e5-small.ts";
import { isKeywordRankingConfident } from "../src/retrieval/keyword-confidence.ts";
import {
  calculateRankingMetrics,
  calculateRetrievalOutcomeMetrics,
  fuseRankedIds,
  rankDocumentsByKeyword,
  rankDocumentsByVector,
  type EvaluationDocument,
} from "../src/retrieval/retrieval-evaluation.ts";
import { loadRetrievalEvaluationDataset } from "../src/retrieval/retrieval-evaluation-dataset.ts";
import { hasConflictingAtvProductFamily } from "../src/retrieval/product-scope.ts";

interface CandidateManifest {
  review_status: string;
  candidates: Array<{
    candidate_key: string;
    fault_code?: string;
    section_title: string;
    sources: Array<{ excerpt: string }>;
  }>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const manifestPath = "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
const datasetPath = "data/evaluation/ohf-retrieval-cases-v2.json";
const outputPath = "reports/ohf-retrieval-evaluation-v2.json";
const cacheDirectory = "tmp/huggingface-cache";

const manifestRaw = await readFile(manifestPath, "utf8");
const datasetRaw = await readFile(datasetPath, "utf8");
const manifest = JSON.parse(manifestRaw) as CandidateManifest;
const dataset = await loadRetrievalEvaluationDataset({
  datasetPath,
  candidateManifestPath: manifestPath,
});
if (manifest.review_status !== "unreviewed") {
  throw new Error("evaluation expects the source candidates to remain unreviewed");
}
if (dataset.changes_knowledge_approval_status !== false) {
  throw new Error("evaluation dataset must not change knowledge approval state");
}

const documents: EvaluationDocument[] = manifest.candidates.map((candidate) => ({
  id: candidate.candidate_key,
  faultCode: candidate.fault_code,
  sectionTitle: candidate.section_title,
  text: candidate.sources.map(({ excerpt }) => excerpt).join("\n"),
}));
const embedder = await createMultilingualE5SmallEmbedder({
  cacheDirectory,
  localFilesOnly: process.env.HF_LOCAL_ONLY === "1",
  remoteHost: process.env.HF_REMOTE_HOST,
});

const startedAt = performance.now();
const documentEmbeddings: Array<{ id: string; embedding: number[] }> = [];
for (const document of documents) {
  documentEmbeddings.push({
    id: document.id,
    embedding: await embedder.embedPassage(
      [document.sectionTitle, document.text].filter(Boolean).join("\n"),
    ),
  });
}

const results = [];
for (const evaluationCase of dataset.cases) {
  const productScopeConflict = hasConflictingAtvProductFamily(
    evaluationCase.query,
    dataset.product_family_code,
  );
  const keyword = productScopeConflict
    ? []
    : rankDocumentsByKeyword(evaluationCase.query, documents);
  const vector = productScopeConflict
    ? []
    : rankDocumentsByVector(
        await embedder.embedQuery(evaluationCase.query),
        documentEmbeddings,
      );
  const keywordParticipatedInHybrid = isKeywordRankingConfident(
    keyword.map(({ score }) => score),
  );
  const keywordAbstained =
    productScopeConflict || !keywordParticipatedInHybrid;
  const hybridIds = fuseRankedIds(
    keywordParticipatedInHybrid ? keyword.map(({ id }) => id) : [],
    vector.map(({ id }) => id),
  );
  results.push({
    caseId: evaluationCase.case_id,
    query: evaluationCase.query,
    languageStyle: evaluationCase.language_style,
    riskClass: evaluationCase.risk_class,
    scopeClass: evaluationCase.scope_class,
    expectedBehavior: evaluationCase.expected_behavior,
    productScopeConflict,
    expectedCandidateKey: evaluationCase.expected_candidate_key,
    keyword,
    keywordAbstained,
    vector,
    vectorAbstained: productScopeConflict,
    keywordParticipatedInHybrid,
    hybridIds,
    hybridAbstained: productScopeConflict,
  });
}
const elapsedMilliseconds = performance.now() - startedAt;

const modelPath = join(
  cacheDirectory,
  embedder.modelId,
  embedder.modelRevision,
  MULTILINGUAL_E5_SMALL_MODEL_FILE,
);
const localModelSha256 = await sha256File(modelPath);
if (localModelSha256 !== MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256) {
  throw new Error("cached model SHA-256 does not match the pinned official file");
}

const asCases = (channel: "keyword" | "vector" | "hybrid") =>
  results
    .filter((result) => result.expectedBehavior === "hit")
    .map((result) => ({
    expectedId: result.expectedCandidateKey,
    rankedIds:
      channel === "hybrid"
        ? result.hybridIds
        : result[channel].map(({ id }) => id),
    }));
const asOutcomeCases = (channel: "keyword" | "vector" | "hybrid") =>
  results.map((result) => ({
    expectedBehavior: result.expectedBehavior,
    expectedId: result.expectedCandidateKey,
    scopeClass: result.scopeClass,
    rankedIds:
      channel === "hybrid"
        ? result.hybridIds
        : result[channel].map(({ id }) => id),
    abstained:
      channel === "hybrid"
        ? result.hybridAbstained
        : result[`${channel}Abstained`],
  }));
const report = {
  reportVersion: 2,
  generatedAt: new Date().toISOString(),
  evaluationOnly: true,
  knowledgeReviewStatus: manifest.review_status,
  dataset: {
    id: dataset.dataset_id,
    purpose: dataset.purpose,
    sha256: createHash("sha256").update(datasetRaw).digest("hex"),
  },
  corpus: {
    candidateCount: documents.length,
    sourceManifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
  },
  model: {
    id: embedder.modelId,
    revision: embedder.modelRevision,
    dimensions: embedder.dimensions,
    poolingMethod: embedder.poolingMethod,
    normalized: embedder.isNormalized,
    modelFile: MULTILINGUAL_E5_SMALL_MODEL_FILE,
    officialSha256: MULTILINGUAL_E5_SMALL_MODEL_FILE_SHA256,
    localSha256: localModelSha256,
  },
  elapsedMilliseconds,
  decisionPolicy: {
    sharedScopeGuard: "问题出现与题库产品族不同的ATV产品族时拒答",
    keyword: "通过产品范围门后，关键词首位至少3分且领先第二名至少2分，否则拒答",
    vector: "通过产品范围门后强制返回首位，尚无资料无答案门",
    hybrid: "通过产品范围门后由向量兜底，尚无资料无答案门",
  },
  rankingOnlyMetrics: {
    keyword: calculateRankingMetrics(asCases("keyword")),
    vector: calculateRankingMetrics(asCases("vector")),
    hybrid: calculateRankingMetrics(asCases("hybrid")),
  },
  metrics: {
    keyword: calculateRetrievalOutcomeMetrics(asOutcomeCases("keyword")),
    vector: calculateRetrievalOutcomeMetrics(asOutcomeCases("vector")),
    hybrid: calculateRetrievalOutcomeMetrics(asOutcomeCases("hybrid")),
  },
  cases: results,
};

await mkdir("reports", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.metrics, null, 2));
console.log(`report: ${outputPath}`);
