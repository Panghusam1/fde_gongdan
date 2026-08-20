import type { DemoWorkOrderCatalog } from "../demo/load-demo-work-order-catalog.ts";
import type {
  ProjectDemoBranchResult,
  ProjectDemoScenario,
} from "../demo/run-project-demo.ts";

export type { ProjectDemoScenario } from "../demo/run-project-demo.ts";

export interface ProjectDemoHttpApiResponse {
  service: "atv320-workorder-demo";
  executionMode: "controlled_offline_real_database";
  scenario: ProjectDemoScenario;
  result: ProjectDemoBranchResult;
}

export interface ProjectDemoHttpApi {
  handle(request: Request): Promise<Response>;
}

interface ProjectDemoHttpApiDependencies {
  allowedOrigins: readonly string[];
  runProjectDemoScenario(
    scenario: ProjectDemoScenario,
  ): Promise<ProjectDemoBranchResult>;
  loadWorkOrderCatalog(): Promise<DemoWorkOrderCatalog>;
}

const serviceName = "atv320-workorder-demo" as const;
const executionMode = "controlled_offline_real_database" as const;
const allowedMethods = "GET,POST,OPTIONS";

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", allowedMethods);
    headers.set("access-control-allow-headers", "content-type");
    headers.set("vary", "Origin");
  }
  return Response.json(body, { status, headers });
}

function preflightResponse(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": allowedMethods,
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
      vary: "Origin",
    },
  });
}

function isScenario(value: unknown): value is ProjectDemoScenario {
  return (
    value === "normal" ||
    value === "high_risk" ||
    value === "insufficient_evidence" ||
    value === "unauthorized_factory" ||
    value === "source_mismatch"
  );
}

export function createProjectDemoHttpApi(
  dependencies: ProjectDemoHttpApiDependencies,
): ProjectDemoHttpApi {
  const allowedOrigins = new Set(
    dependencies.allowedOrigins.map((origin) => origin.trim()).filter(Boolean),
  );

  return {
    async handle(request) {
      const origin = request.headers.get("origin");
      if (origin && !allowedOrigins.has(origin)) {
        return jsonResponse(
          { error: "origin_not_allowed", message: "该网页来源没有演示权限。" },
          403,
          null,
        );
      }

      if (request.method === "OPTIONS") {
        if (!origin) {
          return jsonResponse(
            { error: "origin_required", message: "浏览器预检缺少来源。" },
            400,
            null,
          );
        }
        return preflightResponse(origin);
      }

      const pathname = new URL(request.url).pathname.replace(/\/$/u, "") || "/";
      if (request.method === "GET" && pathname === "/health") {
        return jsonResponse(
          { service: serviceName, status: "ok", executionMode },
          200,
          origin,
        );
      }

      if (request.method === "GET" && pathname === "/api/work-orders") {
        try {
          return jsonResponse(
            await dependencies.loadWorkOrderCatalog(),
            200,
            origin,
          );
        } catch {
          return jsonResponse(
            {
              error: "work_order_catalog_failed",
              message: "演示工单目录暂时无法读取。",
            },
            500,
            origin,
          );
        }
      }

      if (request.method !== "POST" || pathname !== "/api/demo") {
        return jsonResponse(
          { error: "route_not_found", message: "演示服务没有这个接口。" },
          404,
          origin,
        );
      }

      let requestBody: unknown;
      try {
        requestBody = await request.json();
      } catch {
        return jsonResponse(
          { error: "invalid_json", message: "请求内容必须是合法 JSON。" },
          400,
          origin,
        );
      }

      const scenario =
        typeof requestBody === "object" && requestBody !== null
          ? (requestBody as { scenario?: unknown }).scenario
          : undefined;
      if (!isScenario(scenario)) {
        return jsonResponse(
          {
            error: "invalid_scenario",
            message:
              "scenario 只能是 normal、high_risk、insufficient_evidence、unauthorized_factory 或 source_mismatch。",
          },
          400,
          origin,
        );
      }

      try {
        const result = await dependencies.runProjectDemoScenario(scenario);
        const response: ProjectDemoHttpApiResponse = {
          service: serviceName,
          executionMode,
          scenario,
          result,
        };
        return jsonResponse(response, 200, origin);
      } catch {
        return jsonResponse(
          {
            error: "demo_execution_failed",
            message: "后端没有完成本次工单演示，请稍后重试。",
          },
          500,
          origin,
        );
      }
    },
  };
}
