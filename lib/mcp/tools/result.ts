import type { CallToolResult } from "@modelcontextprotocol/server";

import { asMopsfinError } from "@/lib/mopsfin/errors";
import { recordMcpToolError } from "@/lib/observability/telemetry";

import { structuredError } from "../result-contract";

export function failure(error: unknown): CallToolResult {
  const normalized = asMopsfinError(error);
  recordMcpToolError(normalized);
  const structuredContent = structuredError(normalized);
  const details = Object.keys(structuredContent.error.details as object).length
    ? ` ${JSON.stringify(structuredContent.error.details)}`
    : "";
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `${normalized.code}: ${normalized.message}${details}`,
      },
    ],
    structuredContent,
  };
}
