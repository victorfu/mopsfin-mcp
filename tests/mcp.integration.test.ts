import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerMopsfinTools } from "@/lib/mcp/register-tools";
import { mopsfinClient } from "@/lib/mopsfin/client";
import type { Catalog } from "@/lib/mopsfin/types";

const source = {
  sourceName: "公開資訊觀測站－財務比較 E 點通",
  sourceUrl: "https://mopsfin.twse.com.tw/",
  retrievedAt: "2026-08-24T00:00:00.000Z",
  upstreamRoute: "/compare/data",
  freshnessNote: "原站每日更新一次，資料可能較最新申報落後約一日。",
};

const catalog: Catalog = {
  metrics: [
    {
      code: "ROE",
      name: "權益報酬率",
      unit: "%",
      category: "獲利能力",
      family: "data",
    },
  ],
  industries: [{ code: "24", name: "半導體業" }],
  financialInstitutions: [
    { code: "0040000", name: "臺銀", sector: "bank" },
  ],
  years: [2026],
  quarters: [1],
  discoveredAt: "2026-08-24T00:00:00.000Z",
};

const trend = {
  ...source,
  query: {
    metricCode: "ROE",
    metricName: "權益報酬率",
    companyCodes: ["2330"],
    companies: ["2330 台積電"],
    basis: "quarterly" as const,
    history: "recent_12" as const,
  },
  unit: "%",
  periods: ["2026Q1"],
  series: [
    {
      label: "2330 台積電",
      points: [{ period: "2026Q1", value: 20.5 }],
    },
  ],
  warnings: [],
};

const table = {
  ...source,
  upstreamRoute: "/compare/report",
  query: {
    statement: "balance_sheet" as const,
    companyCodes: ["2330"],
    companies: ["2330 台積電"],
    period: "2026Q1",
  },
  unit: "新台幣仟元",
  period: "2026Q1",
  reportNames: ["資產負債表"],
  tables: [
    {
      title: "資產負債表",
      headers: [["項目", "2330 台積電"]],
      rows: [["資產", "100"]],
    },
  ],
  pagination: {
    offset: 0,
    limit: 100,
    returnedRows: 1,
    totalRows: 1,
    nextOffset: null,
  },
  warnings: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP protocol integration", () => {
  it("initializes, lists seven tools and calls each tool with structured output", async () => {
    vi.spyOn(mopsfinClient, "findCompanies").mockResolvedValue([
      { code: "2330", name: "台積電", displayName: "2330 台積電" },
    ]);
    vi.spyOn(mopsfinClient, "getCatalog").mockResolvedValue(catalog);
    vi.spyOn(mopsfinClient, "getCompanyMetric").mockResolvedValue(trend);
    vi.spyOn(mopsfinClient, "getFinancialStatement").mockResolvedValue(table);
    vi.spyOn(mopsfinClient, "getFinancialNote").mockResolvedValue({
      ...table,
      upstreamRoute: "/compare/xb",
      query: {
        note: "loans_to_others",
        companyCodes: ["2330"],
        companies: ["2330 台積電"],
        period: "2026Q1",
      },
    });
    vi.spyOn(mopsfinClient, "getIndustryData").mockResolvedValue({
      ...source,
      upstreamRoute: "/compare/bcode",
      query: {
        mode: "trend",
        measure: "revenue",
        industryCodes: ["24"],
        industries: ["半導體業"],
        history: "recent_12",
      },
      unit: "新台幣仟元",
      periods: ["2026Q1"],
      series: [{ label: "半導體業", points: [{ period: "2026Q1", value: 100 }] }],
      warnings: [],
    });
    vi.spyOn(mopsfinClient, "getFinancialInstitutionMetric").mockResolvedValue({
      ...source,
      upstreamRoute: "/compare/adequacy",
      query: {
        metricCode: "BankCAR",
        metricName: "銀行業資本適足率",
        institutionCodes: ["0040000"],
        institutions: ["臺銀"],
        history: "recent_12",
      },
      unit: "%",
      periods: ["2026Q1"],
      series: [{ label: "臺銀", points: [{ period: "2026Q1", value: 14.2 }] }],
      warnings: [],
    });

    const server = new McpServer(
      { name: "mopsfin-test", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerMopsfinTools(server);
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe("mopsfin-test");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "find_companies",
      "list_catalog",
      "get_company_metric",
      "get_financial_statement",
      "get_financial_note",
      "get_industry_data",
      "get_financial_institution_metric",
    ]);
    expect(
      listed.tools.every(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          tool.annotations?.destructiveHint === false &&
          tool.annotations?.idempotentHint === true &&
          tool.annotations?.openWorldHint === false,
      ),
    ).toBe(true);

    const calls = [
      ["find_companies", { query: "2330" }],
      ["list_catalog", { kind: "all" }],
      [
        "get_company_metric",
        { metric_code: "ROE", company_codes: ["2330"] },
      ],
      [
        "get_financial_statement",
        { statement: "balance_sheet", company_codes: ["2330"] },
      ],
      [
        "get_financial_note",
        { note: "loans_to_others", company_codes: ["2330"] },
      ],
      [
        "get_industry_data",
        { mode: "trend", industry_codes: ["24"] },
      ],
      [
        "get_financial_institution_metric",
        { metric_code: "BankCAR", institution_codes: ["0040000"] },
      ],
    ] as const;

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      expect(result.content[0]).toMatchObject({ type: "text" });
    }

    await client.close();
    await server.close();
  });
});
