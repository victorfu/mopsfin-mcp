export type MopsfinErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "NO_DATA"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_BAD_RESPONSE";

export class MopsfinError extends Error {
  readonly code: MopsfinErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: MopsfinErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MopsfinError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
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
