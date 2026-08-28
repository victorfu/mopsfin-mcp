/**
 * Dependency-free public deployment contract.
 *
 * Hashes are SHA-256 over the canonical JSON/string encoding defined here and
 * consumed by `scripts/test-client-contract.mjs`. A local in-memory MCP
 * contract test keeps these constants synchronized with the registry and
 * server instructions.
 */
export const PUBLIC_MCP_SERVER_NAME = "mopsfin-taiwan-equities" as const;
export const PUBLIC_RESULT_CONTRACT_VERSION = "mopsfin.result.v1" as const;
export const PUBLIC_MCP_ENDPOINT = "/api/mcp" as const;

export const PUBLIC_TOOL_NAMES = [
  "find_companies",
  "get_stock_ohlc",
  "get_stock_price_series",
  "get_daily_market_ohlc",
  "analyze_observed_price",
  "get_stock_reaction_signals",
  "get_company_catalyst_events",
  "get_company_catalyst_snapshots",
  "screen_taiwan_stock_candidates",
  "screen_taiwan_stock_candidates_with_catalyst_snapshots",
  "get_daily_market_valuation",
  "get_valuation_model_inputs",
  "run_reverse_dcf",
  "get_monthly_revenue",
  "get_monthly_revenue_trend",
  "list_companies",
  "list_catalog",
  "get_company_metric",
  "get_company_metrics_batch",
  "get_financial_statement",
  "get_financial_note",
  "get_industry_data",
  "get_financial_institution_metric",
] as const;

export type McpToolName = (typeof PUBLIC_TOOL_NAMES)[number];

export const TOOL_COUNT = PUBLIC_TOOL_NAMES.length;

export interface PublicToolContractLike {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalize(item),
    );
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        normalized[key] = canonicalize(source[key]);
      }
    }
    return normalized;
  }
  throw new TypeError(
    `Canonical JSON does not support values of type ${typeof value}.`,
  );
}

/** RFC-8259-compatible stable encoding: object keys sort; arrays retain order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Select only public tools/list fields, while retaining each tool identity. */
export function publicToolContractPayload(
  tools: readonly PublicToolContractLike[],
): readonly PublicToolContractLike[] {
  if (!Array.isArray(tools)) {
    throw new TypeError("tools/list did not return an array of tools.");
  }
  return tools.map((tool, index) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
      throw new TypeError(`tools/list item ${index} is not an object.`);
    }
    return {
      name: tool.name ?? null,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? null,
    };
  });
}

/**
 * Canonical tools/list hash. The payload binds every ordered tool name to its
 * title, description, inputSchema, outputSchema, and annotations.
 */
export const PUBLIC_TOOL_CONTRACT_SHA256 =
  "e5d2a47da7ff5ac6b26ad5f1b7ec666ec82ebe797fc3c2466a6988a6b37a3669" as const;

/** Exact UTF-8 SHA-256 of the MCP initialize instructions string. */
export const PUBLIC_SERVER_INSTRUCTIONS_SHA256 =
  "89d57033a0787ee34c52b32f6694936c02441f154f462ce1cff419c20fa3a51c" as const;
