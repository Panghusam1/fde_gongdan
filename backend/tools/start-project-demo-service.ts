import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadDemoWorkOrderCatalog } from "../src/demo/load-demo-work-order-catalog.ts";
import { runProjectDemoScenario } from "../src/demo/run-project-demo.ts";
import { createProjectDemoHttpApi } from "../src/service/project-demo-http-api.ts";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ATV320_DEMO_PORT 必须是 1 到 65535 之间的整数");
  }
  return port;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const configured = value
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured && configured.length > 0
    ? configured
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const body = await readRequestBody(request);
  return new Request(url, {
    method: request.method,
    headers: request.headers as HeadersInit,
    body,
  });
}

async function writeWebResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  const headers = Object.fromEntries(response.headers.entries());
  target.writeHead(response.status, headers);
  target.end(Buffer.from(await response.arrayBuffer()));
}

const port = parsePort(process.env.ATV320_DEMO_PORT);
const api = createProjectDemoHttpApi({
  allowedOrigins: parseAllowedOrigins(process.env.ATV320_ALLOWED_ORIGINS),
  runProjectDemoScenario,
  loadWorkOrderCatalog: loadDemoWorkOrderCatalog,
});

const server = createServer(async (request, response) => {
  try {
    await writeWebResponse(await api.handle(await toWebRequest(request)), response);
  } catch {
    response.writeHead(500, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        error: "request_failed",
        message: "演示服务无法处理本次请求。",
      }),
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(
    `ATV320 demo service listening on http://127.0.0.1:${port}\n`,
  );
});
