import http from "node:http";
import client from "prom-client";
import type { NextFunction, Request, Response } from "express";

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: "a9t_mcp_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: "a9t_mcp_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const activeSessionsGauge = new client.Gauge({
  name: "a9t_mcp_active_sessions",
  help: "Number of active MCP HTTP sessions",
  registers: [register],
});

const toolCallsTotal = new client.Counter({
  name: "a9t_mcp_tool_calls_total",
  help: "MCP tool invocations (JSON-RPC tools/* over POST /mcp)",
  labelNames: ["tool", "outcome"],
  registers: [register],
});

const toolDurationSeconds = new client.Histogram({
  name: "a9t_mcp_tool_duration_seconds",
  help: "MCP tool handler duration in seconds",
  labelNames: ["tool"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Wrap an MCP tool handler to record call counts and latency in Prometheus.
 * Counts `outcome=error` when the handler returns `{ isError: true }` or throws.
 */
export async function withToolMetrics<T>(tool: string, run: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  try {
    const result = await run();
    const outcome =
      result &&
      typeof result === "object" &&
      "isError" in result &&
      (result as { isError?: boolean }).isError === true
        ? "error"
        : "success";
    toolCallsTotal.inc({ tool, outcome });
    toolDurationSeconds.observe(
      { tool },
      Number(process.hrtime.bigint() - start) / 1e9,
    );
    return result;
  } catch (err) {
    toolCallsTotal.inc({ tool, outcome: "error" });
    toolDurationSeconds.observe(
      { tool },
      Number(process.hrtime.bigint() - start) / 1e9,
    );
    throw err;
  }
}

function routeLabel(req: Request): string {
  const path = req.path || "/";
  if (path === "/mcp" || path.startsWith("/mcp")) return "/mcp";
  if (path === "/health") return "/health";
  return path;
}

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = routeLabel(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });
  next();
}

export function setActiveSessionCount(count: number): void {
  activeSessionsGauge.set(count);
}

export function startMetricsServer(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && path === "/metrics") {
      try {
        res.setHeader("Content-Type", register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        console.error("Metrics scrape error:", err);
        res.statusCode = 500;
        res.end();
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      console.error(
        `Prometheus metrics at http://0.0.0.0:${port}/metrics (scrape from Docker network; not exposed via Traefik)`,
      );
      resolve(server);
    });
    server.on("error", reject);
  });
}
