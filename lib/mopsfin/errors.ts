import { UpstreamReliabilityError } from "@/lib/upstream/reliability";

export type MopsfinErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "NO_DATA"
  | "INCOMPLETE_COVERAGE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_BAD_RESPONSE";

export type MopsfinErrorCategory =
  | "input"
  | "lookup"
  | "no_data"
  | "coverage"
  | "upstream"
  | "pagination";

export type MopsfinErrorAction =
  | "fix_input"
  | "change_query"
  | "retry"
  | "restart_pagination"
  | "none";

export class MopsfinError extends Error {
  readonly code: MopsfinErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;
  readonly reason?: string;
  readonly category?: MopsfinErrorCategory;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly action?: MopsfinErrorAction;

  constructor(
    code: MopsfinErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
      reason?: string;
      category?: MopsfinErrorCategory;
      retryable?: boolean;
      retryAfterMs?: number;
      action?: MopsfinErrorAction;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MopsfinError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
    this.reason = options.reason;
    this.category = options.category;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.action = options.action;
  }
}

export function asMopsfinError(error: unknown): MopsfinError {
  if (error instanceof MopsfinError) {
    return error;
  }

  // Orchestrators check the shared deadline between dependencies. Those checks
  // can escape a transport's own error adapter and must retain their meaning.
  if (error instanceof UpstreamReliabilityError &&
      (error.code === "DEADLINE_EXCEEDED" || error.code === "ABORTED")) {
    const aborted = error.code === "ABORTED";
    return new MopsfinError("UPSTREAM_TIMEOUT", aborted ? "查詢已取消。" : "查詢超過整體時間上限。", {
      cause: error,
      reason: aborted ? "UPSTREAM_OPERATION_ABORTED" : "UPSTREAM_DEADLINE_EXCEEDED",
      category: "upstream", retryable: !aborted, action: aborted ? "none" : "retry",
    });
  }

  return new MopsfinError(
    "UPSTREAM_BAD_RESPONSE",
    "Mopsfin 查詢發生未預期錯誤。",
    { cause: error },
  );
}
