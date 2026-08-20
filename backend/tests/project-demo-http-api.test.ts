import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectDemoHttpApi,
  type ProjectDemoHttpApiResponse,
} from "../src/service/project-demo-http-api.ts";
import type { ProjectDemoResult } from "../src/demo/run-project-demo.ts";

const allowedOrigin = "https://portfolio.example";

const demoResult: ProjectDemoResult = {
  executionMode: "controlled_offline_real_database",
  normalPath: {
    scenario: "confirmed_source_normal_resolution",
    requestedSource: "NVE41300/05/zh-CN",
    evidenceVerdicts: ["directly_answerable"],
    finalStatus: "resolved",
    handoffReason: null,
    contentModelCallCount: 1,
    databaseCounts: {
      work_orders: 1,
      knowledge_search_runs: 1,
      evidence_assessments: 1,
      risk_assessments: 1,
      resolution_proposals: 1,
      proposal_user_feedback: 1,
      human_handoffs: 0,
    },
  },
  sourceMismatchPath: {
    scenario: "confirmed_source_missing_handoff",
    requestedSource: "NVE41300/04/zh-CN",
    evidenceVerdicts: ["not_answerable"],
    finalStatus: "awaiting_human",
    handoffReason: "insufficient_evidence",
    contentModelCallCount: 0,
    databaseCounts: {
      work_orders: 1,
      knowledge_search_runs: 1,
      evidence_assessments: 1,
      risk_assessments: 1,
      resolution_proposals: 0,
      proposal_user_feedback: 0,
      human_handoffs: 1,
    },
  },
};

const queueCatalog = {
  datasetId: "work-order-end-to-end-holdout-v3",
  dataRole: "project_evaluation_cases_not_production_records",
  manualSource: "NVE41300/05/zh-CN",
  items: Array.from({ length: 13 }, (_, index) => ({
    workOrderNo: `WO-DEMO-${String(index + 1).padStart(3, "0")}`,
    stage: (index % 6) + 1,
    demoScenario:
      index < 5
        ? ([
            "normal",
            "high_risk",
            "insufficient_evidence",
            "unauthorized_factory",
            "source_mismatch",
          ] as const)[index]
        : null,
  })),
};

function createApi() {
  let runCount = 0;
  let catalogLoadCount = 0;
  const api = createProjectDemoHttpApi({
    allowedOrigins: [allowedOrigin],
    async runProjectDemo() {
      runCount += 1;
      return demoResult;
    },
    async runProjectDemoScenario(scenario: string) {
      runCount += 1;
      if (scenario === "normal") return demoResult.normalPath;
      if (scenario === "source_mismatch") return demoResult.sourceMismatchPath;
      return {
        ...demoResult.sourceMismatchPath,
        scenario,
        finalStatus:
          scenario === "unauthorized_factory" ? "investigating" : "awaiting_human",
        handoffReason:
          scenario === "high_risk"
            ? "high_risk"
            : scenario === "unauthorized_factory"
              ? null
              : "insufficient_evidence",
      };
    },
    async loadWorkOrderCatalog() {
      catalogLoadCount += 1;
      return queueCatalog;
    },
  } as never);
  return {
    api,
    getRunCount: () => runCount,
    getCatalogLoadCount: () => catalogLoadCount,
  };
}

test("R322：演示服务健康检查必须说明它是受控离线数据库模式", async () => {
  const { api, getRunCount } = createApi();
  const response = await api.handle(
    new Request("http://service.local/health", {
      headers: { origin: allowedOrigin },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    service: "atv320-workorder-demo",
    status: "ok",
    executionMode: "controlled_offline_real_database",
  });
  assert.equal(getRunCount(), 0);
});

test("R323：网页每次只能运行并返回用户选择的一条演示分支", async () => {
  const { api, getRunCount } = createApi();
  const response = await api.handle(
    new Request("http://service.local/api/demo", {
      method: "POST",
      headers: {
        origin: allowedOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scenario: "source_mismatch" }),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as ProjectDemoHttpApiResponse;
  assert.equal(body.service, "atv320-workorder-demo");
  assert.equal(body.executionMode, "controlled_offline_real_database");
  assert.equal(body.scenario, "source_mismatch");
  assert.deepEqual(body.result, demoResult.sourceMismatchPath);
  assert.equal(getRunCount(), 1);
  assert.equal("normalPath" in body, false);
  assert.equal("sourceMismatchPath" in body, false);
});

test("R324：演示服务必须拒绝未知分支和未授权网页来源", async () => {
  const { api, getRunCount } = createApi();
  const invalidScenario = await api.handle(
    new Request("http://service.local/api/demo", {
      method: "POST",
      headers: {
        origin: allowedOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scenario: "invented" }),
    }),
  );
  const forbiddenOrigin = await api.handle(
    new Request("http://service.local/api/demo", {
      method: "POST",
      headers: {
        origin: "https://untrusted.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scenario: "normal" }),
    }),
  );

  assert.equal(invalidScenario.status, 400);
  assert.match(JSON.stringify(await invalidScenario.json()), /normal.*source_mismatch/);
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal(forbiddenOrigin.headers.get("access-control-allow-origin"), null);
  assert.equal(getRunCount(), 0);
});

test("R325：浏览器预检只能向授权来源开放演示接口", async () => {
  const { api } = createApi();
  const response = await api.handle(
    new Request("http://service.local/api/demo", {
      method: "OPTIONS",
      headers: { origin: allowedOrigin },
    }),
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
});

test("R327：工单队列接口必须返回冻结评测数据、六个阶段和至少五条可演示记录", async () => {
  const { api, getRunCount, getCatalogLoadCount } = createApi();
  const response = await api.handle(
    new Request("http://service.local/api/work-orders", {
      headers: { origin: allowedOrigin },
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as typeof queueCatalog;
  assert.equal(body.datasetId, "work-order-end-to-end-holdout-v3");
  assert.equal(body.dataRole, "project_evaluation_cases_not_production_records");
  assert.ok(body.items.length >= 12);
  assert.deepEqual(
    [...new Set(body.items.map(({ stage }) => stage))].sort(),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(body.items.filter(({ demoScenario }) => demoScenario !== null).length >= 5);
  assert.equal(getCatalogLoadCount(), 1);
  assert.equal(getRunCount(), 0);
});

test("R328：演示接口必须接受高危、证据不足和越权隔离场景", async () => {
  const { api, getRunCount } = createApi();
  for (const scenario of [
    "high_risk",
    "insufficient_evidence",
    "unauthorized_factory",
  ]) {
    const response = await api.handle(
      new Request("http://service.local/api/demo", {
        method: "POST",
        headers: {
          origin: allowedOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scenario }),
      }),
    );
    assert.equal(response.status, 200, scenario);
  }
  assert.equal(getRunCount(), 3);
});
