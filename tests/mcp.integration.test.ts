import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { companyMasterClient } from "@/lib/company-master/client";
import { registerMopsfinTools } from "@/lib/mcp/register-tools";
import { companyMetricOutputSchema } from "@/lib/mcp/schemas";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { MOPSFIN_SERVER_INSTRUCTIONS } from "@/lib/mopsfin/guidance";
import type { Catalog } from "@/lib/mopsfin/types";
import { priceClient } from "@/lib/price/client";
import { monthlyRevenueClient } from "@/lib/revenue/client";
import { valuationClient } from "@/lib/valuation/client";

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
    includeIndustryAverage: false,
    includeCompanyAverage: false,
    history: "recent_12" as const,
  },
  unit: "%",
  periods: ["2026Q1"],
  series: [
    {
      label: "2330 台積電",
      seriesType: "company" as const,
      companyCode: "2330",
      companyName: "台積電",
      displayName: "2330 台積電",
      points: [
        { period: "2026Q1", value: 20.5, valueStatus: "reported" as const },
      ],
    },
  ],
  coverage: {
    selectionComplete: true,
    requestedCompanyCodes: ["2330"],
    returnedCompanyCodes: ["2330"],
    missingCompanyCodes: [],
    noValidDataCompanyCodes: [],
    commonThroughPeriod: "2026Q1",
    companies: [
      {
        companyCode: "2330",
        seriesReturned: true,
        nonNullPoints: 1,
        missingPoints: 0,
        invalidPoints: 0,
        firstReportedPeriod: "2026Q1",
        latestReportedPeriod: "2026Q1",
        missingPeriods: [],
      },
    ],
  },
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

const companyMaster = {
  query: {
    market: "all" as const,
    includeFinancial: true,
    includeKy: true,
  },
  generatedAt: "2026-08-25T00:00:00.000Z",
  snapshotId: "listed-2026-08-24+otc-2026-08-24",
  coverageComplete: true as const,
  sources: [
    {
      market: "listed" as const,
      exchange: "TWSE" as const,
      sourceName: "臺灣證券交易所－上市公司基本資料",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
      reportDate: "2026-08-24",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      rawCount: 2,
      excludedTdrCount: 1,
      companyCount: 1,
    },
    {
      market: "otc" as const,
      exchange: "TPEx" as const,
      sourceName: "證券櫃檯買賣中心－上櫃股票基本資料",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
      reportDate: "2026-08-24",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      rawCount: 1,
      excludedTdrCount: 0,
      companyCount: 1,
    },
  ],
  counts: {
    raw: 3,
    excludedTdr: 1,
    eligible: 2,
    excludedFinancial: 0,
    excludedKy: 0,
    listed: 1,
    otc: 1,
    returned: 2,
  },
  companies: [
    {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      shortName: "台積電",
      market: "listed" as const,
      exchange: "TWSE" as const,
      industryCode: "24",
      listingDate: "1994-09-05",
      domicileCode: "TW",
      isKy: false,
      isFinancial: false,
    },
    {
      code: "3105",
      name: "穩懋半導體股份有限公司",
      shortName: "穩懋",
      market: "otc" as const,
      exchange: "TPEx" as const,
      industryCode: "24",
      listingDate: "2002-01-02",
      domicileCode: "TW",
      isKy: false,
      isFinancial: false,
    },
  ],
  warnings: ["上市清單已排除 TDR。"],
};

const stockOhlc = {
  query: {
    companyCode: "2330",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
  },
  companyCode: "2330",
  observedNames: ["台積電"],
  currency: "TWD" as const,
  timezone: "Asia/Taipei" as const,
  interval: "1d" as const,
  priceBasis: "raw_unadjusted" as const,
  dataQualityComplete: true,
  bars: [
    {
      date: "2026-01-02",
      open: 1555,
      high: 1585,
      low: 1545,
      close: 1585,
      volumeShares: 25_000_000,
      turnoverTwd: 39_200_000_000,
      tradeCount: 50_000,
      change: 30,
      changeMarker: "+",
      market: "listed" as const,
      status: "traded" as const,
      qualityStatus: "complete" as const,
      missingFields: [],
    },
  ],
  coverage: {
    requestedStart: "2026-01-01",
    requestedEnd: "2026-01-31",
    coveredThrough: "2026-01-31",
    coverageComplete: true,
    nextCursor: null,
  },
  sources: [
    {
      market: "listed" as const,
      sourceName: "臺灣證券交易所－個股日成交資訊",
      sourceUrl:
        "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260101&stockNo=2330&response=json",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      normalization: {
        volumeShares: { sourceUnit: "share" as const, outputUnit: "share" as const, multiplier: 1 as const },
        turnoverTwd: { sourceUnit: "TWD" as const, outputUnit: "TWD" as const, multiplier: 1 as const },
        tradeCount: { sourceUnit: "trade" as const, outputUnit: "trade" as const, multiplier: 1 as const },
      },
    },
  ],
  warnings: [],
};

const dailyMarketOhlc = {
  query: {
    market: "all" as const,
    date: "2026-08-24",
    universePolicy: "compatible" as const,
  },
  dataDate: "2026-08-24",
  currency: "TWD" as const,
  timezone: "Asia/Taipei" as const,
  interval: "1d" as const,
  priceBasis: "raw_unadjusted" as const,
  classificationMethod: "historical_code_rule" as const,
  classificationPolicy: "historical_code_rule" as const,
  coverageComplete: true as const,
  universeCoverageVerified: false,
  dataQualityComplete: true,
  reconciliation: [],
  selectionComplete: true,
  missingCompanyCodes: [],
  counts: { listed: 1, otc: 1, returned: 2 },
  bars: [
    {
      code: "2330",
      name: "台積電",
      date: "2026-08-24",
      open: 2410,
      high: 2410,
      low: 2375,
      close: 2375,
      volumeShares: 18_000_000,
      turnoverTwd: 43_000_000_000,
      tradeCount: 65_000,
      change: -20,
      changeMarker: "-",
      market: "listed" as const,
      status: "traded" as const,
      qualityStatus: "complete" as const,
      missingFields: [],
    },
    {
      code: "3105",
      name: "穩懋",
      date: "2026-08-24",
      open: 370.5,
      high: 372.5,
      low: 355,
      close: 355,
      volumeShares: 9_000_000,
      turnoverTwd: 3_200_000_000,
      tradeCount: 12_000,
      change: -10,
      changeMarker: "-",
      market: "otc" as const,
      status: "traded" as const,
      qualityStatus: "complete" as const,
      missingFields: [],
    },
  ],
  sources: [
    {
      market: "listed" as const,
      sourceName: "臺灣證券交易所－每日收盤行情",
      sourceUrl:
        "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20260824&type=ALLBUT0999&response=json",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      dataDate: "2026-08-24",
      normalization: {
        volumeShares: { sourceUnit: "share" as const, outputUnit: "share" as const, multiplier: 1 as const },
        turnoverTwd: { sourceUnit: "TWD" as const, outputUnit: "TWD" as const, multiplier: 1 as const },
        tradeCount: { sourceUnit: "trade" as const, outputUnit: "trade" as const, multiplier: 1 as const },
      },
    },
    {
      market: "otc" as const,
      sourceName: "證券櫃檯買賣中心－上櫃股票行情",
      sourceUrl:
        "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2026%2F08%2F24&response=json",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      dataDate: "2026-08-24",
      normalization: {
        volumeShares: { sourceUnit: "share" as const, outputUnit: "share" as const, multiplier: 1 as const },
        turnoverTwd: { sourceUnit: "TWD" as const, outputUnit: "TWD" as const, multiplier: 1 as const },
        tradeCount: { sourceUnit: "trade" as const, outputUnit: "trade" as const, multiplier: 1 as const },
      },
    },
  ],
  warnings: [],
};

const latestMarketReconciliation = [
  {
    market: "listed" as const,
    masterCount: 1,
    sourceRowCount: 1,
    matchedCount: 1,
    marketOnlyCodes: [],
    masterMissingCodes: [],
    matchRatio: 1,
    coverageComplete: true,
  },
  {
    market: "otc" as const,
    masterCount: 1,
    sourceRowCount: 1,
    matchedCount: 1,
    marketOnlyCodes: [],
    masterMissingCodes: [],
    matchRatio: 1,
    coverageComplete: true,
  },
];

const dailyMarketValuation = {
  query: {
    market: "all" as const,
    date: "latest" as const,
    universePolicy: "compatible" as const,
  },
  dataDate: "2026-08-24",
  currency: "TWD" as const,
  classificationPolicy: "current_master_with_code_fallback" as const,
  coverageComplete: true,
  universeCoverageVerified: true,
  selectionComplete: true,
  missingCompanyCodes: [],
  reconciliation: latestMarketReconciliation,
  counts: {
    raw: 2,
    returned: 2,
    withPe: 2,
    withPb: 2,
    withDividendYield: 2,
  },
  rows: [
    {
      code: "2330",
      name: "台積電",
      market: "listed" as const,
      peRatio: 24.6,
      priceToBookRatio: 7.9,
      dividendYieldPercent: 1.8,
      valueStatus: {
        peRatio: "reported" as const,
        priceToBookRatio: "reported" as const,
        dividendYieldPercent: "reported" as const,
      },
    },
    {
      code: "3105",
      name: "穩懋",
      market: "otc" as const,
      peRatio: 31.2,
      priceToBookRatio: 4.1,
      dividendYieldPercent: 0.9,
      valueStatus: {
        peRatio: "reported" as const,
        priceToBookRatio: "reported" as const,
        dividendYieldPercent: "reported" as const,
      },
    },
  ],
  sources: [
    {
      market: "listed" as const,
      exchange: "TWSE" as const,
      sourceName: "臺灣證券交易所－上市股票本益比、殖利率及股價淨值比",
      sourceUrl: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      dataDate: "2026-08-24",
      rawCount: 1,
      eligibleRowCount: 1,
    },
    {
      market: "otc" as const,
      exchange: "TPEx" as const,
      sourceName: "證券櫃檯買賣中心－上櫃股票本益比分析",
      sourceUrl:
        "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      dataDate: "2026-08-24",
      rawCount: 1,
      eligibleRowCount: 1,
    },
  ],
  warnings: ["latest 不是盤中即時估值。"],
};

const reportedRevenueStatuses = {
  currentMonthRevenueTwd: "reported" as const,
  previousMonthRevenueTwd: "reported" as const,
  sameMonthLastYearRevenueTwd: "reported" as const,
  momPercent: "reported" as const,
  yoyPercent: "reported" as const,
  currentYearCumulativeRevenueTwd: "reported" as const,
  previousYearCumulativeRevenueTwd: "reported" as const,
  cumulativeYoyPercent: "reported" as const,
};

const monthlyRevenue = {
  query: {
    market: "all" as const,
    dataMonth: "latest" as const,
    universePolicy: "strict_current_master" as const,
  },
  dataMonth: "2026-07",
  currency: "TWD" as const,
  amountUnit: "TWD" as const,
  coverageComplete: true as const,
  selectionComplete: true,
  missingCompanyCodes: [],
  filingCoverage: {
    expectedCompanyCount: 2,
    reportedCompanyCount: 2,
    missingCompanyCodes: [],
    coverageRatio: 1,
    complete: true,
  },
  reconciliation: latestMarketReconciliation,
  counts: { listed: 1, otc: 1, returned: 2 },
  rows: [
    {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      market: "listed" as const,
      industryCode: "24",
      sourceReportDate: "2026-08-10",
      currentMonthRevenueTwd: 323_000_000_000,
      previousMonthRevenueTwd: 310_000_000_000,
      sameMonthLastYearRevenueTwd: 256_000_000_000,
      momPercent: 4.19,
      yoyPercent: 26.17,
      currentYearCumulativeRevenueTwd: 2_100_000_000_000,
      previousYearCumulativeRevenueTwd: 1_700_000_000_000,
      cumulativeYoyPercent: 23.53,
      note: null,
      valueStatus: reportedRevenueStatuses,
    },
    {
      code: "3105",
      name: "穩懋半導體股份有限公司",
      market: "otc" as const,
      industryCode: "24",
      sourceReportDate: "2026-08-10",
      currentMonthRevenueTwd: 2_500_000_000,
      previousMonthRevenueTwd: 2_400_000_000,
      sameMonthLastYearRevenueTwd: 2_000_000_000,
      momPercent: 4.17,
      yoyPercent: 25,
      currentYearCumulativeRevenueTwd: 16_000_000_000,
      previousYearCumulativeRevenueTwd: 13_000_000_000,
      cumulativeYoyPercent: 23.08,
      note: "",
      valueStatus: reportedRevenueStatuses,
    },
  ],
  sources: [
    {
      market: "listed" as const,
      exchange: "TWSE" as const,
      sourceName: "臺灣證券交易所－上市公司每月營業收入彙總表",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      rawCount: 1,
      eligibleRowCount: 1,
      dataMonth: "2026-07",
      sourceReportDate: "2026-08-10",
      sourceAmountUnit: "thousand_TWD" as const,
      outputAmountUnit: "TWD" as const,
      amountMultiplier: 1000 as const,
    },
    {
      market: "otc" as const,
      exchange: "TPEx" as const,
      sourceName: "證券櫃檯買賣中心－上櫃公司每月營業收入彙總表",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      rawCount: 1,
      eligibleRowCount: 1,
      dataMonth: "2026-07",
      sourceReportDate: "2026-08-10",
      sourceAmountUnit: "thousand_TWD" as const,
      outputAmountUnit: "TWD" as const,
      amountMultiplier: 1000 as const,
    },
  ],
  warnings: ["latest 月份仍應檢查 filingCoverage。"],
};

interface JsonSchemaNode {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
}

function missingPropertyDescriptions(
  schema: JsonSchemaNode | undefined,
  path: string,
): string[] {
  if (!schema) return [`${path}: schema missing`];
  const missing: string[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const propertyPath = `${path}.${name}`;
    if (!property.description?.trim()) missing.push(propertyPath);
    missing.push(...missingPropertyDescriptionsInChildren(property, propertyPath));
  }
  return missing;
}

function missingPropertyDescriptionsInChildren(
  schema: JsonSchemaNode,
  path: string,
): string[] {
  const missing = missingPropertyDescriptions(schema, path);
  if (schema.items) {
    missing.push(...missingPropertyDescriptions(schema.items, `${path}[]`));
    missing.push(
      ...missingPropertyDescriptionsInCompositions(schema.items, `${path}[]`),
    );
  }
  missing.push(...missingPropertyDescriptionsInCompositions(schema, path));
  return missing;
}

function missingPropertyDescriptionsInCompositions(
  schema: JsonSchemaNode,
  path: string,
): string[] {
  const branches = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  return branches.flatMap((branch, index) => [
    ...missingPropertyDescriptions(branch, `${path}<${index}>`),
    ...missingPropertyDescriptionsInChildren(branch, `${path}<${index}>`),
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP protocol integration", () => {
  it("enforces company-series identity as a discriminated output contract", () => {
    const baseSeries = {
      label: "2330 台積電",
      points: [
        { period: "2026Q1", value: 20.5, valueStatus: "reported" as const },
      ],
    };

    expect(
      companyMetricOutputSchema.safeParse({
        ...trend,
        series: [{ ...baseSeries, seriesType: "company" }],
      }).success,
    ).toBe(false);
    expect(
      companyMetricOutputSchema.safeParse({
        ...trend,
        series: [
          {
            ...baseSeries,
            seriesType: "industry_average",
            companyCode: "2330",
            companyName: "台積電",
            displayName: "2330 台積電",
          },
        ],
      }).success,
    ).toBe(false);
    expect(companyMetricOutputSchema.safeParse(trend).success).toBe(true);
  });

  it("initializes, lists twelve tools and calls each tool with structured output", async () => {
    vi.spyOn(companyMasterClient, "listCompanies").mockResolvedValue(companyMaster);
    vi.spyOn(priceClient, "getStockOhlc").mockResolvedValue(stockOhlc);
    vi.spyOn(priceClient, "getDailyMarketOhlc").mockResolvedValue(dailyMarketOhlc);
    vi.spyOn(valuationClient, "getDailyMarketValuation").mockResolvedValue(
      dailyMarketValuation,
    );
    vi.spyOn(monthlyRevenueClient, "getMonthlyRevenue").mockResolvedValue(
      monthlyRevenue,
    );
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
      series: [
        {
          label: "半導體業",
          points: [
            { period: "2026Q1", value: 100, valueStatus: "reported" },
          ],
        },
      ],
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
        includeIndustryAverage: true,
        includeInstitutionAverage: true,
        history: "recent_12",
      },
      unit: "%",
      periods: ["2026Q1"],
      series: [
        {
          label: "臺銀",
          points: [
            { period: "2026Q1", value: 14.2, valueStatus: "reported" },
          ],
        },
        {
          label: "公司平均數",
          points: [
            { period: "2026Q1", value: 14.2, valueStatus: "reported" },
          ],
        },
        {
          label: "銀行業資本適足性",
          points: [
            { period: "2026Q1", value: 15.1, valueStatus: "reported" },
          ],
        },
      ],
      warnings: [],
    });

    const server = new McpServer(
      { name: "mopsfin-test", version: "0.2.0" },
      {
        capabilities: { tools: {} },
        instructions: MOPSFIN_SERVER_INSTRUCTIONS,
      },
    );
    registerMopsfinTools(server);
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe("mopsfin-test");
    expect(client.getInstructions()).toContain("IFRSs");
    expect(client.getInstructions()).toContain("NO_DATA");
    expect(client.getInstructions()).toContain("cumulative_yoy");
    expect(client.getInstructions()).toContain("list_companies");
    expect(client.getInstructions()).toContain("TWSE");
    expect(client.getInstructions()).toContain("TPEx");
    expect(client.getInstructions()).toContain("get_stock_ohlc");
    expect(client.getInstructions()).toContain("raw_unadjusted");
    expect(client.getInstructions()).toContain("get_daily_market_valuation");
    expect(client.getInstructions()).toContain("get_monthly_revenue");
    expect(client.getInstructions()).toContain("filingCoverage");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "find_companies",
      "get_stock_ohlc",
      "get_daily_market_ohlc",
      "get_daily_market_valuation",
      "get_monthly_revenue",
      "list_companies",
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
    expect(
      listed.tools.every((tool) => (tool.description?.length ?? 0) >= 180),
    ).toBe(true);
    expect(
      listed.tools.every(
        (tool) => (tool.title?.trim().length ?? 0) > 0,
      ),
    ).toBe(true);
    const missingDescriptions = listed.tools.flatMap((tool) => [
      ...missingPropertyDescriptions(
        tool.inputSchema as JsonSchemaNode,
        `${tool.name}.input`,
      ),
      ...missingPropertyDescriptions(
        tool.outputSchema as JsonSchemaNode,
        `${tool.name}.output`,
      ),
    ]);
    expect(missingDescriptions).toEqual([]);
    for (const tool of listed.tools) {
      const properties = tool.inputSchema.properties ?? {};
      expect(Object.keys(properties).length).toBeGreaterThan(0);
      for (const property of Object.values(properties)) {
        expect(property).toHaveProperty("description");
      }
    }
    const companyListTool = listed.tools.find(
      (tool) => tool.name === "list_companies",
    );
    expect(companyListTool?.description).toContain("market=listed");
    expect(companyListTool?.description).toContain("market=otc");
    expect(companyListTool?.description).toContain("market=all");
    expect(companyListTool?.description).toContain("coverageComplete");
    expect(companyListTool?.description).toContain("TDR");
    expect(companyListTool?.inputSchema.properties?.market).toMatchObject({
      default: "all",
      description: expect.stringContaining("listed=只取 TWSE 上市"),
    });
    const companyListOutput = companyListTool?.outputSchema as
      | {
          properties?: Record<string, { description?: string }>;
        }
      | undefined;
    expect(companyListOutput?.properties?.coverageComplete?.description).toContain(
      "必要來源失敗時工具會整體報錯",
    );
    expect(companyListOutput?.properties?.companies?.description).toContain(
      "完整公司清單",
    );
    const stockOhlcTool = listed.tools.find(
      (tool) => tool.name === "get_stock_ohlc",
    );
    expect(stockOhlcTool?.description).toContain("coverageComplete=false");
    expect(stockOhlcTool?.description).toContain("raw_unadjusted");
    expect(stockOhlcTool?.inputSchema.properties?.cursor).toHaveProperty(
      "description",
    );
    const stockOutput = stockOhlcTool?.outputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    expect(stockOutput?.properties?.coverage?.description).toContain(
      "12 個日曆月份",
    );
    const dailyOhlcTool = listed.tools.find(
      (tool) => tool.name === "get_daily_market_ohlc",
    );
    expect(dailyOhlcTool?.description).toContain("latest 不是盤中即時價");
    expect(dailyOhlcTool?.description).toContain("selectionComplete=false");
    expect(dailyOhlcTool?.description).toContain("strict_current_master");
    expect(dailyOhlcTool?.description).toContain("成交量");
    expect(dailyOhlcTool?.inputSchema.properties?.universe_policy).toMatchObject({
      default: "compatible",
    });
    const valuationTool = listed.tools.find(
      (tool) => tool.name === "get_daily_market_valuation",
    );
    expect(valuationTool?.description).toContain("strict_current_master");
    expect(valuationTool?.description).toContain("valueStatus");
    expect(valuationTool?.inputSchema.properties?.date).toMatchObject({
      default: "latest",
    });
    expect(valuationTool?.inputSchema.properties?.universe_policy).toMatchObject({
      default: "compatible",
    });
    const revenueTool = listed.tools.find(
      (tool) => tool.name === "get_monthly_revenue",
    );
    expect(revenueTool?.description).toContain("filingCoverage");
    expect(revenueTool?.description).toContain("1,000");
    expect(revenueTool?.inputSchema.properties?.data_month).toMatchObject({
      default: "latest",
    });
    const financialTool = listed.tools.find(
      (tool) => tool.name === "get_financial_institution_metric",
    );
    expect(
      financialTool?.inputSchema.properties?.include_industry_average,
    ).toMatchObject({
      type: "boolean",
      default: false,
      description: expect.stringContaining("不是市值加權"),
    });
    expect(
      financialTool?.inputSchema.properties?.include_institution_average,
    ).toMatchObject({
      type: "boolean",
      default: false,
      description: expect.stringContaining("簡單平均"),
    });
    const financialOutput = financialTool?.outputSchema as
      | {
          properties?: {
            query?: {
              properties?: Record<string, unknown>;
            };
          };
        }
      | undefined;
    expect(
      financialOutput?.properties?.query?.properties
        ?.includeIndustryAverage,
    ).toHaveProperty("description");
    expect(
      financialOutput?.properties?.query?.properties
        ?.includeInstitutionAverage,
    ).toHaveProperty("description");

    const calls = [
      ["find_companies", { query: "2330" }],
      [
        "get_stock_ohlc",
        {
          company_code: "2330",
          start_date: "2026-01-01",
          end_date: "2026-01-31",
        },
      ],
      ["get_daily_market_ohlc", { market: "all", date: "2026-08-24" }],
      ["get_daily_market_valuation", { market: "all" }],
      ["get_monthly_revenue", { market: "all" }],
      ["list_companies", { market: "all" }],
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
        {
          metric_code: "BankCAR",
          institution_codes: ["0040000"],
          include_industry_average: true,
          include_institution_average: true,
        },
      ],
    ] as const;

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      expect(result.content[0]).toMatchObject({ type: "text" });
      if (name === "list_catalog") {
        const structured = result.structuredContent as {
          officialGuidance: {
            filingCadence: unknown[];
            updateCadence: string;
          };
          metrics: Array<{
            guidance: {
              calculation: string | null;
              applicability: string;
            };
          }>;
        };
        expect(structured.officialGuidance.filingCadence).toHaveLength(3);
        expect(structured.officialGuidance.updateCadence).toContain("每日更新一次");
        expect(structured.metrics[0].guidance.calculation).toContain("平均權益總額");
        expect(structured.metrics[0].guidance.applicability).toBeTruthy();
      }
      if (name === "list_companies") {
        const structured = result.structuredContent as {
          coverageComplete: boolean;
          counts: { listed: number; otc: number; returned: number };
          companies: Array<{ code: string; market: string }>;
        };
        expect(structured.coverageComplete).toBe(true);
        expect(structured.counts).toMatchObject({ listed: 1, otc: 1, returned: 2 });
        expect(structured.companies.map((company) => company.code)).toEqual([
          "2330",
          "3105",
        ]);
      }
      if (name === "get_stock_ohlc") {
        const structured = result.structuredContent as {
          priceBasis: string;
          coverage: { coverageComplete: boolean; nextCursor: string | null };
          bars: Array<{ date: string; close: number | null }>;
        };
        expect(structured.priceBasis).toBe("raw_unadjusted");
        expect(structured.coverage).toMatchObject({
          coverageComplete: true,
          nextCursor: null,
        });
        expect(structured.bars[0]).toMatchObject({
          date: "2026-01-02",
          close: 1585,
        });
      }
      if (name === "get_daily_market_ohlc") {
        const structured = result.structuredContent as {
          dataDate: string;
          coverageComplete: boolean;
          universeCoverageVerified: boolean;
          dataQualityComplete: boolean;
          selectionComplete: boolean;
          counts: { returned: number };
        };
        expect(structured).toMatchObject({
          dataDate: "2026-08-24",
          coverageComplete: true,
          universeCoverageVerified: false,
          dataQualityComplete: true,
          selectionComplete: true,
          counts: { returned: 2 },
        });
      }
      if (name === "get_daily_market_valuation") {
        const structured = result.structuredContent as {
          dataDate: string;
          universeCoverageVerified: boolean;
          counts: { returned: number };
          rows: Array<{
            code: string;
            peRatio: number | null;
            valueStatus: { peRatio: string };
          }>;
        };
        expect(structured).toMatchObject({
          dataDate: "2026-08-24",
          universeCoverageVerified: true,
          counts: { returned: 2 },
        });
        expect(structured.rows[0]).toMatchObject({
          code: "2330",
          peRatio: 24.6,
          valueStatus: { peRatio: "reported" },
        });
      }
      if (name === "get_monthly_revenue") {
        const structured = result.structuredContent as {
          dataMonth: string;
          amountUnit: string;
          filingCoverage: {
            reportedCompanyCount: number;
            expectedCompanyCount: number;
          };
          rows: Array<{ code: string; currentMonthRevenueTwd: number | null }>;
        };
        expect(structured).toMatchObject({
          dataMonth: "2026-07",
          amountUnit: "TWD",
          filingCoverage: {
            reportedCompanyCount: 2,
            expectedCompanyCount: 2,
          },
        });
        expect(structured.rows[0]).toMatchObject({
          code: "2330",
          currentMonthRevenueTwd: 323_000_000_000,
        });
      }
      if (name === "get_company_metric") {
        const structured = result.structuredContent as {
          coverage: {
            selectionComplete: boolean;
            commonThroughPeriod: string | null;
          };
          series: Array<{ companyCode?: string; seriesType: string }>;
        };
        expect(structured.coverage).toMatchObject({
          selectionComplete: true,
          commonThroughPeriod: "2026Q1",
        });
        expect(structured.series[0]).toMatchObject({
          companyCode: "2330",
          seriesType: "company",
        });
      }
      if (name === "get_financial_institution_metric") {
        const structured = result.structuredContent as {
          query: {
            includeIndustryAverage: boolean;
            includeInstitutionAverage: boolean;
          };
          series: Array<{ label: string }>;
        };
        expect(structured.query).toMatchObject({
          includeIndustryAverage: true,
          includeInstitutionAverage: true,
        });
        expect(structured.series.map((series) => series.label)).toEqual([
          "臺銀",
          "公司平均數",
          "銀行業資本適足性",
        ]);
      }
    }

    await client.close();
    await server.close();
  });
});
