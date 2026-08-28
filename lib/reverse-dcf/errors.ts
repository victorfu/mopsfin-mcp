import type { ReverseDcfErrorCode } from "./types";

export class ReverseDcfError extends Error {
  readonly code: ReverseDcfErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ReverseDcfErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReverseDcfError";
    this.code = code;
    this.details = details;
  }
}
