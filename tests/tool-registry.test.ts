import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineTool } from "@/lib/mcp/tools/definition";
import {
  TOOL_REGISTRY,
  registerToolRegistry,
} from "@/lib/mcp/tool-registry";
import {
  canonicalJson,
  PUBLIC_MCP_ENDPOINT,
  PUBLIC_MCP_SERVER_NAME,
  PUBLIC_RESULT_CONTRACT_VERSION,
  PUBLIC_SERVER_INSTRUCTIONS_SHA256,
  PUBLIC_TOOL_CONTRACT_SHA256,
  PUBLIC_TOOL_NAMES,
  publicToolContractPayload,
  TOOL_COUNT,
  type McpToolName,
} from "@/lib/mcp/tool-manifest";
import { MOPSFIN_SERVER_INSTRUCTIONS } from "@/lib/mopsfin/guidance";
import { MopsfinError } from "@/lib/mopsfin/errors";
import {
  MCP_ENDPOINT,
  RESULT_CONTRACT_VERSION,
  SERVER_NAME,
} from "@/lib/server/identity";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface JsonSchemaNode {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
}

function descriptionGaps(
  schema: JsonSchemaNode | undefined,
  path: string,
): string[] {
  if (!schema) return [`${path}:schema_missing`];
  const gaps: string[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const propertyPath = `${path}.${name}`;
    if (!property.description?.trim()) {
      gaps.push(`${propertyPath}:description_missing`);
    }
    gaps.push(...descriptionGaps(property, propertyPath));
  }
  if (schema.items) {
    gaps.push(...descriptionGaps(schema.items, `${path}[]`));
  }
  const variants = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  for (const [index, variant] of variants.entries()) {
    // Null/primitive union branches inherit the named property's description;
    // nested user-facing fields and items must still be described.
    gaps.push(...descriptionGaps(variant, `${path}<${index}>`));
  }
  return gaps;
}

const TOOL_DESCRIPTION_REQUIREMENTS = {
  find_companies: ["company_codes", "不要臆測", "不含 TDR"],
  get_stock_ohlc: ["raw_unadjusted", "coverageComplete=false", "unverified_empty"],
  get_stock_price_series: [
    "price_index_compatible_corporate_action_adjusted",
    "絕不回退 raw",
    "include_event_ledger",
  ],
  get_daily_market_ohlc: [
    "latest 不是盤中即時價",
    "selectionComplete=false",
    "strict_current_master",
  ],
  analyze_observed_price: [
    "caller-supplied",
    "expectedAsOf",
    "兩市場各自的 master freshness",
    "不是外部盤中 quote provider",
  ],
  get_stock_reaction_signals: [
    "exact benchmark sessions",
    "authoritative completed-session resolver",
    "stockDataFailure",
    "v3 cursor",
    "不是錯價證明",
  ],
  get_company_catalyst_events: [
    "重大訊息",
    "法人說明會",
    "不是 point-in-time snapshot",
    "failures",
  ],
  get_company_catalyst_snapshots: [
    "current official snapshot evidence",
    "not_disclosed_in_snapshot",
    "pointInTimeHistoryAvailable",
    "不是分析師 consensus",
  ],
  screen_taiwan_stock_candidates: [
    "balanced_non_financial_v2",
    "hard gates",
    "CATALOG_CONTRACT_MISMATCH",
    "不是投資建議",
  ],
  screen_taiwan_stock_candidates_with_catalyst_snapshots: [
    "ordered screen.candidates",
    "affectsScreenScore=false",
    "不是第五柱",
    "沒有 candidates 時不呼叫",
  ],
  get_daily_market_valuation: [
    "exact-date",
    "strict_current_master",
    "valueStatus",
    "不重算財報分母",
  ],
  get_valuation_model_inputs: [
    "authoritative completed-session resolver",
    "data_gap/null",
    "point-in-time filing vintage",
    "不執行 DCF",
  ],
  run_reverse_dcf: [
    "一次只反解",
    "不提供隱藏預設",
    "不二次 resolve",
    "不是 intrinsic value",
  ],
  get_monthly_revenue: [
    "filingCoverage",
    "乘以 1,000",
    "point-in-time vintage",
    "sourceReportDate",
  ],
  get_monthly_revenue_trend: [
    "3–24",
    "rolling 3／6",
    "comparability=needs_review",
    "point-in-time vintage",
  ],
  list_companies: [
    "market=listed",
    "coverageVerification.status=heuristic",
    "TDR",
    "meta.asOf.snapshotId",
  ],
  list_catalog: ["metric_code", "officialGuidance", "IFRSs", "五分鐘"],
  get_company_metric: [
    "family=data",
    "valueStatus",
    "selectionComplete=false",
    "不是市值加權",
  ],
  get_company_metrics_batch: [
    "1–100",
    "availability=unavailable",
    "failureIsolationComplete=false",
    "meta.page.next",
  ],
  get_financial_statement: ["資產負債表", "各季累計", "nextOffset", "unit"],
  get_financial_note: ["五類", "rowspan/colspan", "NO_DATA", "nextOffset"],
  get_industry_data: ["statistics", "trend", "industry_codes", "不能把產業平均"],
  get_financial_institution_metric: [
    "family=fin",
    "include_industry_average",
    "不是市值加權",
    "NO_DATA",
  ],
  screen_taiwan_financial_candidates: [
    "balanced_financial_v1",
    "exact-code",
    "cross-model",
    "不是投資建議",
  ],
  screen_taiwan_market_candidates: [
    "balanced_market_v1",
    "crossModelScoreComparable=false",
    "不自動補額",
    "不是投資建議",
  ],
  screen_taiwan_market_universe_page: [
    "full_universe_cursor_v1",
    "STATELESS_PAGE_VALUES_NOT_PINNED",
    "SNAPSHOT_CHANGED",
    "不是投資建議",
  ],
} as const satisfies Record<McpToolName, readonly string[]>;

describe("canonical MCP tool registry", () => {
  it("matches the ordered dependency-free public manifest one-to-one", () => {
    const names = TOOL_REGISTRY.map((definition) => definition.name);

    expect(TOOL_COUNT).toBe(26);
    expect(names).toEqual(PUBLIC_TOOL_NAMES);
    expect(new Set(names).size).toBe(TOOL_COUNT);
  });

  it("keeps every public contract component on its canonical definition", () => {
    for (const definition of TOOL_REGISTRY) {
      expect(definition.config.title?.length).toBeGreaterThan(0);
      expect(definition.config.description?.length).toBeGreaterThanOrEqual(180);
      expect(definition.config.inputSchema).toBeDefined();
      expect(definition.config.outputSchema).toBeDefined();
      expect(definition.config.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("registers the same definitions in manifest order", () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;

    registerToolRegistry(server);

    expect(registerTool).toHaveBeenCalledTimes(TOOL_COUNT);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(
      PUBLIC_TOOL_NAMES,
    );
    for (const [index, definition] of TOOL_REGISTRY.entries()) {
      expect(registerTool.mock.calls[index]?.[1]).toBe(definition.config);
      expect(registerTool.mock.calls[index]?.[2]).toBe(
        (definition as typeof definition & { handler: unknown }).handler,
      );
    }
  });

  it("memoizes JSON Schema conversion by schema identity and input/output role", async () => {
    const sharedSchema = z.object({ value: z.string() });
    const definition = defineTool(
      "find_companies",
      {
        inputSchema: sharedSchema,
        outputSchema: sharedSchema,
      },
      async () => {
        throw new MopsfinError("NO_DATA", "fixture failure");
      },
    );
    const options = { target: "draft-2020-12" as const };
    const standard = sharedSchema["~standard"];

    const firstInput = standard.jsonSchema.input(options);
    const secondInput = standard.jsonSchema.input(options);
    const firstOutput = standard.jsonSchema.output(options);
    const secondOutput = standard.jsonSchema.output(options);

    expect(secondInput).toBe(firstInput);
    expect(secondOutput).toBe(firstOutput);
    expect(firstOutput).not.toBe(firstInput);
    await expect(definition.handler({ value: "x" }, {} as never)).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "NO_DATA" },
      },
    });
  });

  it("keeps every tools/list schema surface and LLM routing description complete", async () => {
    const server = new McpServer(
      { name: PUBLIC_MCP_SERVER_NAME, version: "description-audit" },
      { capabilities: { tools: {} }, instructions: MOPSFIN_SERVER_INSTRUCTIONS },
    );
    registerToolRegistry(server);
    const client = new Client({ name: "description-audit", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(PUBLIC_TOOL_NAMES);

      const gaps = tools.flatMap((tool) => [
        ...descriptionGaps(
          tool.inputSchema as JsonSchemaNode,
          `${tool.name}.input`,
        ),
        ...descriptionGaps(
          tool.outputSchema as JsonSchemaNode,
          `${tool.name}.output`,
        ),
      ]);
      expect(gaps).toEqual([]);

      const reaction = tools.find((tool) => tool.name === "get_stock_reaction_signals")!;
      const reactionInput = reaction.inputSchema as JsonSchemaNode;
      expect(reactionInput.properties?.as_of?.description).toContain("authoritative completed-session resolver");
      expect(reactionInput.properties?.cursor?.description).toContain("v3 reaction cursor");
      expect(reactionInput.properties?.cursor?.description).toContain("completed-session evidence");
      expect(JSON.stringify(reaction)).not.toMatch(/v2 reaction cursor|v2 cursor|最近共同可形成視窗/);
      expect(MOPSFIN_SERVER_INSTRUCTIONS).not.toContain("reaction cursor v2");

      for (const tool of tools) {
        const required =
          TOOL_DESCRIPTION_REQUIREMENTS[tool.name as McpToolName];
        expect(required, `${tool.name}:requirements_missing`).toBeDefined();
        for (const phrase of required) {
          expect(tool.description, `${tool.name}:${phrase}`).toContain(phrase);
        }
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps dependency-free deployment identity constants synchronized", () => {
    expect(PUBLIC_MCP_SERVER_NAME).toBe(SERVER_NAME);
    expect(PUBLIC_RESULT_CONTRACT_VERSION).toBe(RESULT_CONTRACT_VERSION);
    expect(PUBLIC_MCP_ENDPOINT).toBe(MCP_ENDPOINT);
  });

  it("matches canonical tools/list and initialize-instructions SHA-256 values", async () => {
    const server = new McpServer(
      { name: PUBLIC_MCP_SERVER_NAME, version: "contract-test" },
      {
        capabilities: { tools: {} },
        instructions: MOPSFIN_SERVER_INSTRUCTIONS,
      },
    );
    registerToolRegistry(server);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();

      expect.soft(sha256(canonicalJson(publicToolContractPayload(tools)))).toBe(
        PUBLIC_TOOL_CONTRACT_SHA256,
      );
      expect.soft(sha256(client.getInstructions() ?? "")).toBe(
        PUBLIC_SERVER_INSTRUCTIONS_SHA256,
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
