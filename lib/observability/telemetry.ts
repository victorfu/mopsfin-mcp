import { AsyncLocalStorage } from "node:async_hooks";

type McpHandler = (request: Request) => Promise<Response>;

interface MethodMetrics {
  requests: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

interface TelemetryState {
  startedAt: string;
  requests: number;
  completed: number;
  errors: number;
  active: number;
  sdkErrors: number;
  toolErrors: number;
  errorCodes: Map<string, number>;
  totalDurationMs: number;
  maxDurationMs: number;
  methods: Map<string, MethodMetrics>;
  tools: Map<string, MethodMetrics>;
}

interface McpEventLike {
  type: "REQUEST_RECEIVED" | "REQUEST_COMPLETED" | "ERROR";
  method?: string;
  duration?: number;
  status?: "success" | "error";
  error?: Error | string;
  context?: string;
  source?: "request" | "system";
  severity?: "warning" | "error" | "fatal";
}

const TELEMETRY_KEY = Symbol.for("mopsfin.telemetry.v1");
const MAX_DIMENSION_KEYS = 64;
const TOOL_ERROR_CODES = new Set([
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "NO_DATA",
  "INCOMPLETE_COVERAGE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_BAD_RESPONSE",
]);
const requestTelemetryStorage = new AsyncLocalStorage<{
  tool: string | null;
  toolErrorRecorded: boolean;
}>();

function initialState(): TelemetryState {
  return {
    startedAt: new Date().toISOString(),
    requests: 0,
    completed: 0,
    errors: 0,
    active: 0,
    sdkErrors: 0,
    toolErrors: 0,
    errorCodes: new Map(),
    totalDurationMs: 0,
    maxDurationMs: 0,
    methods: new Map(),
    tools: new Map(),
  };
}

function state(): TelemetryState {
  const target = globalThis as typeof globalThis & {
    [TELEMETRY_KEY]?: TelemetryState;
  };
  target[TELEMETRY_KEY] ??= initialState();
  return target[TELEMETRY_KEY];
}

function safeDimension(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, 100);
  return /^[A-Za-z0-9_./:-]+$/.test(normalized) ? normalized : fallback;
}

function updateDimension(
  dimensions: Map<string, MethodMetrics>,
  rawKey: string,
  durationMs: number,
  failed: boolean,
): void {
  const key =
    dimensions.has(rawKey) || dimensions.size < MAX_DIMENSION_KEYS
      ? rawKey
      : "other";
  const current = dimensions.get(key) ?? {
    requests: 0,
    errors: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  current.requests += 1;
  if (failed) current.errors += 1;
  current.totalDurationMs += durationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
  dimensions.set(key, current);
}

function incrementDimensionError(
  dimensions: Map<string, MethodMetrics>,
  rawKey: string,
): void {
  const key =
    dimensions.has(rawKey) || dimensions.size < MAX_DIMENSION_KEYS
      ? rawKey
      : "other";
  const current = dimensions.get(key) ?? {
    requests: 0,
    errors: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  current.errors += 1;
  dimensions.set(key, current);
}

function errorType(value: unknown): string {
  return value instanceof Error
    ? safeDimension(value.name, "Error")
    : typeof value;
}

function emit(level: "info" | "error", payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({ service: "mopsfin-taiwan-equities", ...payload });
  if (level === "error") console.error(line);
  else console.info(line);
}

async function requestIdentity(request: Request): Promise<{
  method: string;
  tool: string | null;
}> {
  if (
    request.method !== "POST" ||
    !(request.headers.get("content-type") ?? "").includes("application/json")
  ) {
    return { method: request.method, tool: null };
  }
  try {
    const body = (await request.clone().json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { method: "POST", tool: null };
    }
    const record = body as Record<string, unknown>;
    const method = safeDimension(record.method, "POST");
    const params =
      record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : null;
    const tool =
      method === "tools/call" && params
        ? safeDimension(params.name, "unknown_tool")
        : null;
    return { method, tool };
  } catch {
    return { method: "POST", tool: null };
  }
}

export async function observeMcpRequest(
  request: Request,
  handler: McpHandler,
): Promise<Response> {
  const requestId = safeDimension(
    request.headers.get("x-request-id") ?? crypto.randomUUID(),
    crypto.randomUUID(),
  );
  const identity = await requestIdentity(request);
  const startedAt = Date.now();
  const telemetry = state();
  telemetry.requests += 1;
  telemetry.active += 1;
  const requestContext = {
    tool: identity.tool,
    toolErrorRecorded: false,
  };

  let failed = false;
  try {
    const response = await requestTelemetryStorage.run(
      requestContext,
      handler,
      request,
    );
    failed = !response.ok;
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    failed = true;
    emit("error", {
      event: "mcp_request_exception",
      requestId,
      method: identity.method,
      tool: identity.tool,
      errorType: errorType(error),
    });
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
    telemetry.active = Math.max(0, telemetry.active - 1);
    telemetry.completed += 1;
    if (failed) telemetry.errors += 1;
    telemetry.totalDurationMs += durationMs;
    telemetry.maxDurationMs = Math.max(telemetry.maxDurationMs, durationMs);
    updateDimension(telemetry.methods, identity.method, durationMs, failed);
    if (identity.tool) {
      updateDimension(
        telemetry.tools,
        identity.tool,
        durationMs,
        failed && !requestContext.toolErrorRecorded,
      );
    }
    emit(failed ? "error" : "info", {
      event: "mcp_request_completed",
      requestId,
      method: identity.method,
      tool: identity.tool,
      durationMs,
      status: failed ? "error" : "success",
    });
  }
}

export function recordMcpSdkEvent(event: McpEventLike): void {
  if (event.type !== "ERROR") return;
  const telemetry = state();
  telemetry.sdkErrors += 1;
  emit("error", {
    event: "mcp_sdk_error",
    source: event.source ?? "system",
    severity: event.severity ?? "error",
    hasContext: Boolean(event.context),
    errorType: errorType(event.error),
  });
}

export function recordMcpToolError(error: unknown): void {
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : null;
  const candidateCode =
    typeof record?.code === "string" ? record.code : "UNKNOWN_ERROR";
  const code = TOOL_ERROR_CODES.has(candidateCode)
    ? candidateCode
    : "UNKNOWN_ERROR";
  const telemetry = state();
  telemetry.toolErrors += 1;
  telemetry.errorCodes.set(code, (telemetry.errorCodes.get(code) ?? 0) + 1);
  const requestContext = requestTelemetryStorage.getStore();
  if (requestContext?.tool && !requestContext.toolErrorRecorded) {
    requestContext.toolErrorRecorded = true;
    incrementDimensionError(telemetry.tools, requestContext.tool);
  }
  emit("error", {
    event: "mcp_tool_error",
    code,
    retryable: record?.retryable === true,
  });
}

function serializeDimensions(dimensions: Map<string, MethodMetrics>) {
  return Object.fromEntries(
    [...dimensions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        {
          requests: value.requests,
          errors: value.errors,
          averageDurationMs:
            value.requests === 0
              ? 0
              : Math.round(value.totalDurationMs / value.requests),
          maxDurationMs: value.maxDurationMs,
        },
      ]),
  );
}

export function telemetrySnapshot() {
  const telemetry = state();
  return {
    startedAt: telemetry.startedAt,
    requests: telemetry.requests,
    completed: telemetry.completed,
    errors: telemetry.errors,
    active: telemetry.active,
    sdkErrors: telemetry.sdkErrors,
    toolErrors: telemetry.toolErrors,
    errorCodes: Object.fromEntries(
      [...telemetry.errorCodes.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    averageDurationMs:
      telemetry.completed === 0
        ? 0
        : Math.round(telemetry.totalDurationMs / telemetry.completed),
    maxDurationMs: telemetry.maxDurationMs,
    methods: serializeDimensions(telemetry.methods),
    tools: serializeDimensions(telemetry.tools),
  };
}

export function resetTelemetryForTests(): void {
  const target = globalThis as typeof globalThis & {
    [TELEMETRY_KEY]?: TelemetryState;
  };
  target[TELEMETRY_KEY] = initialState();
}
