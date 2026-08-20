import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

test(
  "R196：真实千问二次排序把E5前三候选的可回答题首位命中提升到至少90%",
  { skip: process.env.RUN_QWEN_RERANK_EVAL !== "1", timeout: 600_000 },
  async () => {
    const { evaluateReranker } = await import(
      "../src/evaluation/reranker-evaluation.ts"
    );
    const { createQwenRerankerFromEnvironment } = await import(
      "../src/retrieval/qwen-reranker.ts"
    );
    const { loadRetrievalEvaluationDataset } = await import(
      "../src/retrieval/retrieval-evaluation-dataset.ts"
    );
    const datasetPath = "data/evaluation/ohf-retrieval-cases-v2.json";
    const manifestPath =
      "data/curated/schneider/atv320/ohf-knowledge-candidates-v1.json";
    const baselinePath = "reports/ohf-retrieval-evaluation-v2.json";
    const [datasetRaw, manifestRaw, baselineRaw] = await Promise.all([
      readFile(datasetPath, "utf8"),
      readFile(manifestPath, "utf8"),
      readFile(baselinePath, "utf8"),
    ]);
    const dataset = await loadRetrievalEvaluationDataset({
      datasetPath,
      candidateManifestPath: manifestPath,
    });
    const manifest = JSON.parse(manifestRaw) as {
      candidates: Array<{
        candidate_key: string;
        section_title: string;
        sources: Array<{ excerpt: string }>;
      }>;
    };
    const baseline = JSON.parse(baselineRaw) as {
      cases: Array<{
        caseId: string;
        vector: Array<{ id: string }>;
      }>;
    };
    const baselineByCase = new Map(
      baseline.cases.map((item) => [item.caseId, item]),
    );
    const documents = new Map(
      manifest.candidates.map((candidate) => [
        candidate.candidate_key,
        `${candidate.section_title}\n${candidate.sources
          .map((source) => source.excerpt)
          .join("\n")}`,
      ]),
    );
    const reranker = createQwenRerankerFromEnvironment(process.env);
    const evaluation = await evaluateReranker({
      reranker,
      documents,
      cases: dataset.cases
        .filter((item) => item.scope_class !== "out_of_scope")
        .map((item) => ({
        caseId: item.case_id,
        query: item.query,
        expectedId: item.expected_candidate_key,
        candidateIds: baselineByCase
          .get(item.case_id)!
          .vector.slice(0, 3)
          .map(({ id }) => id),
        })),
    });
    const report = {
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      dataset: {
        id: dataset.dataset_id,
        sha256: createHash("sha256").update(datasetRaw).digest("hex"),
      },
      candidateManifestSha256: createHash("sha256")
        .update(manifestRaw)
        .digest("hex"),
      candidateSource: "E5 vector top 3 from ohf-retrieval-evaluation-v2",
      thresholds: { validOutputRate: 1, answerableHitAt1: 0.9 },
      evaluation,
      passed:
        evaluation.validOutputRate === 1 && evaluation.answerableHitAt1 >= 0.9,
    };
    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/qwen-reranker-evaluation-v1.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    assert.equal(evaluation.caseCount, 35);
    assert.equal(evaluation.answerableCaseCount, 30);
    assert.equal(report.passed, true, JSON.stringify(evaluation));
  },
);
