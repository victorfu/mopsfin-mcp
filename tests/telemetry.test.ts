import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeMcpRequest,
  recordMcpSdkEvent,
  recordMcpToolError,
  resetTelemetryForTests,
  telemetrySnapshot,
} from "@/lib/observability/telemetry";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetTelemetryForTests();
});

describe("MCP telemetry", () => {
  it("records method and tool latency without retaining tool arguments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    const request = new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_stock_ohlc",
          arguments: { company_code: "2330", secret: "do-not-store" },
        },
      }),
    });
    const handler = vi.fn(async () => {
      vi.advanceTimersByTime(25);
      return Response.json({ ok: true });
    });

    const response = await observeMcpRequest(request, handler);
    const snapshot = telemetrySnapshot();

    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(snapshot).toMatchObject({
      requests: 1,
      completed: 1,
      errors: 0,
      active: 0,
      methods: {
        "tools/call": { requests: 1, errors: 0, averageDurationMs: 25 },
      },
      tools: {
        get_stock_ohlc: { requests: 1, errors: 0, averageDurationMs: 25 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("2330");
    expect(JSON.stringify(snapshot)).not.toContain("do-not-store");
  });

  it("records HTTP failures and classifies SDK errors without messages", async () => {
    const request = new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize" }),
    });

    await observeMcpRequest(request, async () => new Response("bad", { status: 503 }));
    recordMcpSdkEvent({
      type: "ERROR",
      error: new Error("authorization=private"),
      source: "request",
      severity: "error",
    });
    recordMcpToolError({
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_DEADLINE_EXCEEDED",
      retryable: true,
      details: { authorization: "must-not-be-recorded" },
    });

    expect(telemetrySnapshot()).toMatchObject({
      requests: 1,
      completed: 1,
      errors: 1,
      sdkErrors: 1,
      toolErrors: 1,
      errorCodes: { UPSTREAM_TIMEOUT: 1 },
      methods: { initialize: { requests: 1, errors: 1 } },
    });
    expect(JSON.stringify(telemetrySnapshot())).not.toContain("must-not-be-recorded");
  });

  it("never emits raw SDK or tool error/context query-bearing strings", () => {
    vi.stubEnv("NODE_ENV", "production");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    recordMcpSdkEvent({
      type: "ERROR",
      error: new Error("company_code=2330 private-query"),
      context: "arguments={secret-query-value}",
      source: "request",
      severity: "error",
    });
    recordMcpToolError({
      code: "company_code:2330",
      reason: "arguments=private-query",
      retryable: false,
      details: { context: "secret-query-value" },
    });

    const output = errorLog.mock.calls.flat().join(" ");
    expect(output).toContain('"errorType":"Error"');
    expect(output).toContain('"hasContext":true');
    expect(output).toContain('"code":"UNKNOWN_ERROR"');
    expect(output).not.toContain("2330");
    expect(output).not.toContain("private-query");
    expect(output).not.toContain("secret-query-value");
  });

  it("attributes a structured MCP tool error without retaining its details", async () => {
    const request = new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_company_metrics_batch",
          arguments: { company_codes: ["2330"] },
        },
      }),
    });

    await observeMcpRequest(request, async () => {
      recordMcpToolError({
        code: "UPSTREAM_TIMEOUT",
        details: { companyCodes: ["2330"] },
      });
      return Response.json({ jsonrpc: "2.0", id: 2, error: {} });
    });

    const snapshot = telemetrySnapshot();
    expect(snapshot).toMatchObject({
      requests: 1,
      errors: 0,
      toolErrors: 1,
      tools: {
        get_company_metrics_batch: { requests: 1, errors: 1 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("2330");
  });
});
