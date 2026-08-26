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

  return new MopsfinError(
    "UPSTREAM_BAD_RESPONSE",
    "Mopsfin 查詢發生未預期錯誤。",
    { cause: error },
  );
}
