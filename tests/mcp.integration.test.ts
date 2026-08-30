import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalystClient } from "@/lib/catalyst/client";
import { companyCatalystSnapshotClient } from "@/lib/catalyst/snapshot-client";
import type { CompanyCatalystSnapshotsResult } from "@/lib/catalyst/snapshot-types";
import type { CompanyCatalystEventsResult } from "@/lib/catalyst/types";
import { authoritativeCompletedCloseClient } from "@/lib/completed-close/client";
import { companyMasterClient } from "@/lib/company-master/client";
import { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import {
  companyMetricsBatchClient,
  type CompanyMetricsBatchResult,
} from "@/lib/mopsfin/batch";
import { registerMopsfinTools } from "@/lib/mcp/register-tools";
import {
  companyMetricsBatchInputSchema,
  companyMetricOutputSchema,
  dailyMarketOhlcInputSchema,
  dailyMarketValuationInputSchema,
  listCompaniesInputSchema,
  monthlyRevenueInputSchema,
  monthlyRevenueTrendInputSchema,
  screenTaiwanStockCandidatesInputSchema,
  stockOhlcOutputSchema,
  stockPriceSeriesInputSchema,
  stockPriceSeriesOutputSchema,
  stockReactionSignalsInputSchema,
  stockReactionSignalsOutputSchema,
  valuationModelInputsInputSchema,
} from "@/lib/mcp/schemas";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import { PUBLIC_TOOL_NAMES, TOOL_COUNT } from "@/lib/mcp/tool-manifest";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { MOPSFIN_SERVER_INSTRUCTIONS } from "@/lib/mopsfin/guidance";
import type { Catalog } from "@/lib/mopsfin/types";
import { priceClient } from "@/lib/price/client";
import { stockPriceSeriesClient } from "@/lib/price-series/client";
import type { StockPriceSeriesResult } from "@/lib/price-series/types";
import { reactionClient } from "@/lib/reaction/client";
import type { StockReactionSignalsResult } from "@/lib/reaction/types";
import { monthlyRevenueClient } from "@/lib/revenue/client";
import type { MonthlyRevenueTrendResult } from "@/lib/revenue/types";
import { SERVER_VERSION } from "@/lib/server/identity";
import { valuationClient } from "@/lib/valuation/client";
import { valuationModelInputsClient } from "@/lib/valuation-model/client";
import type {
  ValuationModelFieldId,
  ValuationModelInputFields,
  ValuationModelInputsResult,
  ValuationModelUnit,
} from "@/lib/valuation-model/types";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";
import {
  completedCloseBar,
  exactCurrentCompanyOhlcFixture,
} from "@/tests/fixtures/completed-close";

const source = {
  sourceName: "公開資訊觀測站－財務比較 E 點通",
  sourceUrl: "https://mopsfin.twse.com.tw/",
  retrievedAt: "2026-08-24T00:00:00.000Z",
  upstreamRoute: "/compare/data",
  freshnessNote: "原站每日更新一次，資料可能較最新申報落後約一日。",
};

const valuationModelFieldIds = [
  "ttmRevenue",
  "ttmOperatingIncomeEbitProxy",
  "cashTaxRatePercent",
  "ttmDepreciationAndAmortization",
  "ttmCapitalExpenditure",
  "ttmDeltaNetWorkingCapital",
  "normalizedFcff",
  "cashAndCashEquivalents",
  "interestBearingDebt",
  "netDebt",
  "issuedShares",
  "latestOfficialClose",
  "marketCapitalization",
  "enterpriseValue",
] as const satisfies readonly ValuationModelFieldId[];

function valuationModelUnit(id: ValuationModelFieldId): ValuationModelUnit {
  if (id === "cashTaxRatePercent") return "percent";
  if (id === "issuedShares") return "share";
  if (id === "latestOfficialClose") return "TWD_per_share";
  return "TWD";
}

const valuationModelDataGapFields = Object.fromEntries(
  valuationModelFieldIds.map((id) => [
    id,
    {
      id,
      value: null,
      unit: valuationModelUnit(id),
      status: "data_gap" as const,
      evidenceClass: "UNAVAILABLE" as const,
      formula: null,
      inputFieldIds: [],
      inputLineageIds: ["lineage:001"],
      dataGapReason: "SOURCE_DEPENDENCY_FAILED" as const,
      notes: ["fixture dependency gap; value remains null and is not zero-filled"],
    },
  ]),
) as unknown as ValuationModelInputFields;

const valuationModelInputs: ValuationModelInputsResult = {
  query: {
    companyCode: "2330",
    financialPeriod: "latest",
    priceDate: "latest_completed_official_session",
  },
  generatedAt: "2026-08-28T02:00:00.000Z",
  timezone: "Asia/Taipei",
  currency: "TWD",
  scope: "normalized_valuation_model_inputs",
  posture: "research_model_input_evidence_only",
  applicability: { status: "applicable", reason: null },
  company: {
    code: "2330",
    name: "台灣積體電路製造股份有限公司",
    shortName: "台積電",
    market: "listed",
    exchange: "TWSE",
    industryCode: "24",
    isFinancial: false,
  },
  periods: {
    latestReportedPeriod: "2026Q2",
    ttmMethod: "current_ytd_plus_prior_fy_minus_prior_year_ytd",
    currentYtdPeriod: "2026Q2",
    priorFiscalYearPeriod: "2025Q4",
    priorYearYtdPeriod: "2025Q2",
    fiscalYearBasis: "mopsfin_calendar_year_quarters",
    consolidationScope: "consolidated",
  },
  fields: valuationModelDataGapFields,
  lineage: [
    {
      lineageId: "lineage:001",
      role: "fixture_dependency_attempt",
      status: "missing",
      sourceId: "statement:income_statement:2026Q2",
      statement: "income_statement",
      period: "2026Q2",
      rowLabel: null,
      rawValue: null,
      normalizedValue: null,
      unit: "TWD",
      candidateRowLabels: [],
      notes: ["fixture search attempt"],
    },
    {
      lineageId: "lineage:002",
      role: "latest_completed_official_close",
      status: "missing",
      sourceId: null,
      statement: null,
      period: null,
      rowLabel: "close",
      rawValue: null,
      normalizedValue: null,
      unit: "TWD_per_share",
      candidateRowLabels: [],
      notes: ["fixture authoritative completed-close dependency unavailable"],
    },
  ],
  sources: [
    {
      sourceId: "company_master:listed:2026-08-28",
      stage: "company_master",
      market: "listed",
      exchange: "TWSE",
      sourceName: "TWSE company master fixture",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
      reportDate: "2026-08-28",
      asOf: "2026-08-28",
      asOfGranularity: "date",
      retrievedAt: "2026-08-28T01:00:00.000Z",
    },
    {
      sourceId: "statement:income_statement:2026Q2",
      stage: "statement",
      sourceName: "Mopsfin statement fixture",
      sourceUrl: "https://mopsfin.twse.com.tw/",
      retrievedAt: "2026-08-28T01:02:03.000Z",
      upstreamRoute: "/compare/report",
      statement: "income_statement",
      period: "2026Q2",
      asOf: "2026Q2",
      asOfGranularity: "quarter",
      reportName: "2330 台積電 (上市半導體業)",
      rawUnit: "新台幣仟元",
      unitSource: "response_html",
      normalizedUnit: "TWD",
      amountMultiplier: 1000,
      consolidationScope: "consolidated",
    },
  ],
  quality: {
    calculationComplete: false,
    dataGapFields: [...valuationModelFieldIds],
    notApplicableFields: [],
  },
  workBudget: {
    requestedCompanies: 1,
    orchestrationCompanyMasterCalls: 1,
    statementCalls: { actual: 3, maximum: 7, rowsPerCallMaximum: 500 },
    authoritativeCompletedCloseCalls: {
      actual: 1,
      maximum: 1,
      completedSessionResolver: {
        actualLogicalLoads: null,
        maximumLogicalLoads: 2,
      },
      exactStockOhlcAttempts: {
        actual: null,
        maximum: 2,
        cacheRefreshPerformed: null,
      },
    },
  },
  warnings: ["fixture contains deliberate data gaps"],
};

const valuationModelNotApplicableFields = Object.fromEntries(
  valuationModelFieldIds.map((id) => [
    id,
    {
      id,
      value: null,
      unit: valuationModelUnit(id),
      status: "not_applicable" as const,
      evidenceClass: "UNAVAILABLE" as const,
      formula: null,
      inputFieldIds: [],
      inputLineageIds: [],
      dataGapReason: "NOT_APPLICABLE_FINANCIAL_COMPANY" as const,
      notes: ["financial company requires a dedicated model"],
    },
  ]),
) as unknown as ValuationModelInputFields;

const financialValuationModelInputs: ValuationModelInputsResult = {
  ...valuationModelInputs,
  applicability: {
    status: "not_applicable",
    reason: "financial_company_requires_residual_income_or_dividend_model",
  },
  company: {
    ...valuationModelInputs.company,
    industryCode: "17",
    isFinancial: true,
  },
  periods: {
    latestReportedPeriod: null,
    ttmMethod: "unavailable",
    currentYtdPeriod: null,
    priorFiscalYearPeriod: null,
    priorYearYtdPeriod: null,
    fiscalYearBasis: "mopsfin_calendar_year_quarters",
    consolidationScope: null,
  },
  fields: valuationModelNotApplicableFields,
  lineage: [],
  sources: [valuationModelInputs.sources[0]],
  quality: {
    calculationComplete: false,
    dataGapFields: [],
    notApplicableFields: [...valuationModelFieldIds],
  },
  workBudget: {
    ...valuationModelInputs.workBudget,
    statementCalls: { actual: 0, maximum: 7, rowsPerCallMaximum: 500 },
    authoritativeCompletedCloseCalls: {
      actual: 0,
      maximum: 1,
      completedSessionResolver: {
        actualLogicalLoads: 0,
        maximumLogicalLoads: 2,
      },
      exactStockOhlcAttempts: {
        actual: 0,
        maximum: 2,
        cacheRefreshPerformed: false,
      },
    },
  },
  warnings: ["financial company is not applicable to FCFF DCF"],
};

const catalystEvents: CompanyCatalystEventsResult = {
  query: {
    companyCodes: ["2330"],
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    eventTypes: ["material_information", "investor_conference"],
    offset: 0,
    limit: 50,
  },
  generatedAt: "2026-08-24T00:00:00.000Z",
  timezone: "Asia/Taipei",
  scope: "official_disclosure_events",
  isConsensus: false,
  events: [
    {
      eventId: "fixture-material-event",
      eventType: "material_information",
      companyCode: "2330",
      companyName: "台積電",
      market: "listed",
      title: "公告本公司董事會決議",
      description: "官方重大訊息說明",
      clause: "第31款",
      publishedAt: "2026-01-15T13:30:00+08:00",
      factDate: "2026-01-15",
      scheduledAt: null,
      effectiveAt: null,
      timezone: "Asia/Taipei",
      status: "announced",
      statusBasis: "announcement_publication",
      dateConfidence: "confirmed",
      dateBasis: "publication",
      datePrecision: "minute",
      isConsensus: false,
      sourceKey: "mops_material_information_history",
      sourceUrl: "https://mopsov.twse.com.tw/mops/web/ajax_t05st01",
      sourceReportDate: null,
      sourceRecordKey: "fixture-record",
      eventDetails: null,
    },
  ],
  sources: [
    {
      eventType: "material_information",
      market: null,
      exchange: "MOPS",
      sourceKey: "mops_material_information_history",
      sourceName: "公開資訊觀測站－歷史重大訊息",
      sourceUrl: "https://mopsov.twse.com.tw/mops/web/ajax_t05st01",
      retrievedAt: "2026-08-24T00:00:00.000Z",
      scope: "selected_company_historical_months",
      queryStart: "2026-01-01",
      queryEnd: "2026-01-31",
      sourceReportDate: null,
      rawRowCount: 1,
      acceptedEventCount: 1,
      snapshotIdentity: "fixture-source-snapshot",
    },
  ],
  coverage: {
    sourceComplete: true,
    failureIsolation: "per_company_event_type_calendar_month",
    currentSnapshots: [],
    families: [
      {
        eventType: "material_information",
        scope: "current_and_selected_company_history",
        status: "complete",
        requestedStart: "2026-01-01",
        requestedEnd: "2026-01-31",
        failedCompanyCodes: [],
      },
      {
        eventType: "investor_conference",
        scope: "selected_company_history",
        status: "complete",
        requestedStart: "2026-01-01",
        requestedEnd: "2026-01-31",
        failedCompanyCodes: [],
      },
    ],
  },
  familyCoverage: [
    ...(["material_information", "investor_conference"] as const).map(
      (eventType) => ({
        companyCode: "2330",
        eventType,
        status: "complete" as const,
        queryStart: "2026-01-01",
        queryEnd: "2026-01-31",
        requestCount: 1,
        completedRequestCount: 1,
        verifiedEmptyRequestCount: eventType === "investor_conference" ? 1 : 0,
        nonemptyRequestCount: eventType === "material_information" ? 1 : 0,
        eventCount: eventType === "material_information" ? 1 : 0,
        snapshotIdentity: `fixture-${eventType}`,
        failures: [],
      }),
    ),
  ],
  companies: [
    { companyCode: "2330", status: "complete", eventCount: 1, failures: [] },
  ],
  failures: [],
  counts: {
    requestedCompanies: 1,
    requestedEventTypes: 2,
    totalEvents: 1,
    returnedEvents: 1,
    completeCompanies: 1,
    partialCompanies: 0,
    failedCompanies: 0,
  },
  workBudget: {
    companyCount: 1,
    distinctCalendarMonths: 1,
    eventTypeCount: 2,
    historicalLogicalUnits: 2,
    historicalUpstreamRequests: 3,
    currentSnapshotRequests: 0,
    plannedUpstreamRequests: 3,
    upstreamRequestLimit: 40,
  },
  pagination: {
    offset: 0,
    limit: 50,
    totalRows: 1,
    returnedRows: 1,
    hasMore: false,
    nextOffset: null,
  },
  fingerprint: "fixture-catalyst-fingerprint",
  warnings: ["官方揭露事件不是分析師 consensus。"],
};

const catalystSnapshots: CompanyCatalystSnapshotsResult = {
  query: {
    companyCodes: ["3105"],
    snapshotTypes: [
      "forecast_achievement",
      "forecast_material_variance",
      "shareholder_meeting",
      "dividend_decision",
    ],
    companyMarkets: [{ companyCode: "3105", market: "otc" }],
    asOf: "latest",
    offset: 0,
    limit: 50,
  },
  generatedAt: "2026-08-28T00:00:00.000Z",
  timezone: "Asia/Taipei",
  scope: "current_official_company_snapshots",
  isConsensus: false,
  records: [
    {
      recordId: "fixture-stale-forecast-achievement",
      snapshotType: "forecast_achievement",
      companyCode: "3105",
      companyName: "穩懋",
      market: "otc",
      sourceMode: "current_official_snapshot",
      sourceSnapshotDate: "2021-04-16",
      freshness: "stale",
      sourceSnapshotAgeDays: 1960,
      pointInTimeHistoryAvailable: false,
      firstKnownAt: null,
      isConsensus: false,
      upcomingEligible: false,
      sourceKey: "tpex_forecast_achievement_current",
      sourceUrl:
        "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O",
      sourceRecordKey: "3105:110:1:0",
      details: {
        kind: "forecast_achievement",
        fiscalYear: 2021,
        fiscalYearRaw: "110",
        quarter: 1,
        forecastSequence: "0",
        coveragePeriod: "一、二、三、四",
        actualCumulative: 100,
        actualCumulativeRaw: "100",
        valueUnit: "source_not_declared",
        forecastCumulative: {
          raw: "90~110",
          lower: 90,
          upper: 110,
          unit: "source_not_declared",
        },
      },
    },
    {
      recordId: "fixture-upcoming-shareholder-meeting",
      snapshotType: "shareholder_meeting",
      companyCode: "3105",
      companyName: "穩懋",
      market: "otc",
      sourceMode: "current_official_snapshot",
      sourceSnapshotDate: "2026-08-27",
      freshness: "within_expected_window",
      sourceSnapshotAgeDays: 1,
      pointInTimeHistoryAvailable: false,
      firstKnownAt: null,
      isConsensus: false,
      upcomingEligible: true,
      sourceKey: "tpex_shareholder_meeting_current",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/t187ap41_O",
      sourceRecordKey: "3105:2026-09-30:股東臨時會",
      details: {
        kind: "shareholder_meeting",
        companyAddress: "桃園市",
        meetingType: "股東臨時會",
        meetingDate: "2026-09-30",
        meetingLocation: "桃園市",
        directorSupervisorElection: "否",
        electronicVoting: "是",
        contactPhone: "03-0000000",
        stockTransferAgent: "測試股務代理",
        stockTransferAgentPhone: "02-0000000",
      },
    },
  ],
  sources: [
    {
      snapshotType: "forecast_achievement",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_forecast_achievement_current",
      sourceName: "證券櫃檯買賣中心－上櫃公司財務預測達成情形",
      sourceUrl:
        "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O",
      sourceMode: "current_official_snapshot",
      pointInTimeHistoryAvailable: false,
      isConsensus: false,
      requestedCompanyCodes: ["3105"],
      status: "nonempty",
      freshness: "stale",
      retrievedAt: "2026-08-28T00:00:00.000Z",
      sourceSnapshotDate: "2021-04-16",
      sourceSnapshotAgeDays: 1960,
      rawRowCount: 1,
      eligibleRecordCount: 1,
      duplicateRecordCount: 0,
      selectedRecordCount: 1,
      emptyVerification: "not_applicable",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "unverified_no_official_declared_count",
      snapshotIdentity: "fixture-stale-forecast-snapshot",
      failureId: null,
    },
    {
      snapshotType: "forecast_material_variance",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_forecast_material_variance_current",
      sourceName: "證券櫃檯買賣中心－上櫃公司財務預測重大差異",
      sourceUrl:
        "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap16_O",
      sourceMode: "current_official_snapshot",
      pointInTimeHistoryAvailable: false,
      isConsensus: false,
      requestedCompanyCodes: ["3105"],
      status: "failed",
      freshness: "not_applicable",
      retrievedAt: null,
      sourceSnapshotDate: null,
      sourceSnapshotAgeDays: null,
      rawRowCount: 0,
      eligibleRecordCount: 0,
      duplicateRecordCount: 0,
      selectedRecordCount: 0,
      emptyVerification: "not_applicable",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "not_applicable",
      snapshotIdentity: null,
      failureId: "fixture-forecast-variance-failure",
    },
    {
      snapshotType: "shareholder_meeting",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_shareholder_meeting_current",
      sourceName: "證券櫃檯買賣中心－上櫃公司股東會日期",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/t187ap41_O",
      sourceMode: "current_official_snapshot",
      pointInTimeHistoryAvailable: false,
      isConsensus: false,
      requestedCompanyCodes: ["3105"],
      status: "nonempty",
      freshness: "within_expected_window",
      retrievedAt: "2026-08-28T00:00:00.000Z",
      sourceSnapshotDate: "2026-08-27",
      sourceSnapshotAgeDays: 1,
      rawRowCount: 1,
      eligibleRecordCount: 1,
      duplicateRecordCount: 0,
      selectedRecordCount: 1,
      emptyVerification: "not_applicable",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "unverified_no_official_declared_count",
      snapshotIdentity: "fixture-current-meeting-snapshot",
      failureId: null,
    },
    {
      snapshotType: "dividend_decision",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_dividend_decision_current_unsupported",
      sourceName:
        "證券櫃檯買賣中心－上櫃公司股利決議 current snapshot（官方端點未提供）",
      sourceUrl: null,
      sourceMode: "current_official_snapshot",
      pointInTimeHistoryAvailable: false,
      isConsensus: false,
      requestedCompanyCodes: ["3105"],
      status: "unsupported",
      freshness: "not_applicable",
      retrievedAt: null,
      sourceSnapshotDate: null,
      sourceSnapshotAgeDays: null,
      rawRowCount: 0,
      eligibleRecordCount: 0,
      duplicateRecordCount: 0,
      selectedRecordCount: 0,
      emptyVerification: "not_applicable",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "not_applicable",
      snapshotIdentity: null,
      failureId: null,
    },
  ],
  coverage: {
    sourceComplete: false,
    selection: "partial",
    failureIsolation: "per_snapshot_type_market",
    snapshots: [
      {
        companyCode: "3105",
        snapshotType: "forecast_achievement",
        routedMarkets: ["otc"],
        status: "partial",
        disclosureStatus: "disclosed",
        identityStatus: "verified_current_master_hint",
        resolvedMarket: "otc",
        freshness: "stale",
        recordCount: 1,
        sourceKeys: ["tpex_forecast_achievement_current"],
        failureIds: [],
      },
      {
        companyCode: "3105",
        snapshotType: "forecast_material_variance",
        routedMarkets: ["otc"],
        status: "failed",
        disclosureStatus: "unknown_source_failure",
        identityStatus: "verified_current_master_hint",
        resolvedMarket: "otc",
        freshness: "not_applicable",
        recordCount: 0,
        sourceKeys: ["tpex_forecast_material_variance_current"],
        failureIds: ["fixture-forecast-variance-failure"],
      },
      {
        companyCode: "3105",
        snapshotType: "shareholder_meeting",
        routedMarkets: ["otc"],
        status: "complete",
        disclosureStatus: "disclosed",
        identityStatus: "verified_current_master_hint",
        resolvedMarket: "otc",
        freshness: "within_expected_window",
        recordCount: 1,
        sourceKeys: ["tpex_shareholder_meeting_current"],
        failureIds: [],
      },
      {
        companyCode: "3105",
        snapshotType: "dividend_decision",
        routedMarkets: ["otc"],
        status: "unsupported",
        disclosureStatus: "unsupported",
        identityStatus: "verified_current_master_hint",
        resolvedMarket: "otc",
        freshness: "not_applicable",
        recordCount: 0,
        sourceKeys: ["tpex_dividend_decision_current_unsupported"],
        failureIds: [],
      },
    ],
  },
  companies: [
    {
      companyCode: "3105",
      status: "partial",
      identityStatus: "verified_current_master_hint",
      resolvedMarket: "otc",
      recordCount: 2,
      disclosedSnapshotTypes: [
        "forecast_achievement",
        "shareholder_meeting",
      ],
      notDisclosedSnapshotTypes: [],
      staleSnapshotTypes: ["forecast_achievement"],
      unsupportedSnapshotTypes: ["dividend_decision"],
      failedSnapshotTypes: ["forecast_material_variance"],
    },
  ],
  failures: [
    {
      failureId: "fixture-forecast-variance-failure",
      snapshotType: "forecast_material_variance",
      market: "otc",
      sourceKey: "tpex_forecast_material_variance_current",
      affectedCompanyCodes: ["3105"],
      code: "UPSTREAM_TIMEOUT",
      message: "TPEx forecast variance fixture timeout",
      reason: "UPSTREAM_TIMEOUT",
      retryable: true,
      retryAfterMs: 1000,
      action: "retry",
    },
  ],
  counts: {
    requestedCompanies: 1,
    requestedSnapshotTypes: 4,
    totalRecords: 2,
    returnedRecords: 2,
    completeCompanies: 0,
    partialCompanies: 1,
    failedCompanies: 0,
    nonemptySources: 2,
    verifiedEmptySources: 0,
    staleSources: 1,
    failedSources: 1,
    unsupportedSources: 1,
  },
  workBudget: {
    companyCount: 1,
    snapshotTypeCount: 4,
    plannedSourceRoutes: 4,
    supportedSourceQueries: 3,
    unsupportedSourceRoutes: 1,
    sourceQueryLimit: 8,
  },
  pagination: {
    offset: 0,
    limit: 50,
    totalRows: 2,
    returnedRows: 2,
    hasMore: false,
    nextOffset: null,
  },
  fingerprint: "fixture-catalyst-snapshot-fingerprint",
  warnings: [
    "Current official snapshots 不是 point-in-time 歷史資料。",
    "TPEx current dividend route unsupported。",
  ],
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
    {
      code: "NetProfit",
      name: "稅後純益",
      unit: "新台幣仟元",
      category: "一般公司指標",
      family: "data",
    },
    {
      code: "OperatingCashflow",
      name: "營業活動現金流量",
      unit: "新台幣仟元",
      category: "一般公司指標",
      family: "data",
    },
    {
      code: "DebtRatio",
      name: "負債佔資產比率",
      unit: "%",
      category: "財務結構",
      family: "data",
    },
    {
      code: "GrossMargin",
      name: "毛利率",
      unit: "%",
      category: "獲利能力",
      family: "data",
    },
    {
      code: "OperatingMargin",
      name: "營業利益率",
      unit: "%",
      category: "獲利能力",
      family: "data",
    },
    {
      code: "EPS",
      name: "每股盈餘",
      unit: "元",
      category: "一般公司指標",
      family: "data",
    },
    ...[
      ["Fin01", "放款業務逾放比率", "fin"],
      ["Fin02", "放款備抵呆帳覆蓋率", "fin"],
      ["Fin03", "信用卡逾期帳款比率", "fin"],
      ["Fin04", "信用卡備抵呆帳覆蓋率", "fin"],
      ["Fin05", "應收帳款承購逾期比率", "fin"],
      ["Fin06", "應收帳款承購覆蓋率", "fin"],
      ["HoldingCAR", "金控業集團資本適足率", "adequacy"],
      ["BankCAR", "銀行業資本適足率", "adequacy"],
      ["BillsCAR", "票券業資本適足率", "adequacy"],
    ].map(([code, name, family]) => ({
      code: code as string,
      name: name as string,
      unit: "%",
      category: family === "fin" ? "金融業資產品質" : "資本適足性",
      family: family as "fin" | "adequacy",
    })),
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
  unitSource: "response_html" as const,
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
  coverageVerification: {
    status: "heuristic" as const,
    method: "required_sources_schema_single_report_date_minimum_count" as const,
    officialDeclaredRowCountAvailable: false as const,
  },
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
      minimumExpectedCount: 1,
      cache: {
        status: "bypass" as const,
        observedAt: "2026-08-25T00:00:00.000Z",
        storedAt: null,
        ageMs: null,
        ttlMs: 0,
      },
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
      minimumExpectedCount: 1,
      cache: {
        status: "bypass" as const,
        observedAt: "2026-08-25T00:00:00.000Z",
        storedAt: null,
        ageMs: null,
        ttlMs: 0,
      },
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
  profileCoverage: {
    incorporationDate: { reported: 2, missing: 0, invalid: 0 },
    paidInCapitalTwd: { reported: 2, missing: 0, invalid: 0 },
    issuedCommonShares: { reported: 2, missing: 0, invalid: 0 },
    parValueText: { reported: 2, missing: 0, invalid: 0 },
    financialReportTypeCode: { reported: 2, missing: 0, invalid: 0 },
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
      incorporationDate: "1987-02-21",
      paidInCapitalTwd: 280_500_000_000,
      issuedCommonShares: 25_932_070_000,
      parValueText: "新台幣 10 元",
      financialReportTypeCode: "1",
      profileValueStatus: {
        incorporationDate: "reported" as const,
        paidInCapitalTwd: "reported" as const,
        issuedCommonShares: "reported" as const,
        parValueText: "reported" as const,
        financialReportTypeCode: "reported" as const,
      },
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
      incorporationDate: "1999-10-16",
      paidInCapitalTwd: 22_000_000_000,
      issuedCommonShares: 600_000_000,
      parValueText: "新台幣 10 元",
      financialReportTypeCode: "1",
      profileValueStatus: {
        incorporationDate: "reported" as const,
        paidInCapitalTwd: "reported" as const,
        issuedCommonShares: "reported" as const,
        parValueText: "reported" as const,
        financialReportTypeCode: "reported" as const,
      },
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
      dataMonth: "2026-01",
      normalization: {
        volumeShares: { sourceUnit: "share" as const, outputUnit: "share" as const, multiplier: 1 as const },
        turnoverTwd: { sourceUnit: "TWD" as const, outputUnit: "TWD" as const, multiplier: 1 as const },
        tradeCount: { sourceUnit: "trade" as const, outputUnit: "trade" as const, multiplier: 1 as const },
      },
    },
  ],
  warnings: [],
};

const stockPriceSeries = {
  query: {
    companyCode: "2330",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    priceBasis:
      "price_index_compatible_corporate_action_adjusted" as const,
    includeEventLedger: true,
  },
  generatedAt: "2026-08-25T00:00:00.000Z",
  timezone: "Asia/Taipei" as const,
  currency: "TWD" as const,
  interval: "1d" as const,
  requestedPriceBasis:
    "price_index_compatible_corporate_action_adjusted" as const,
  rawPriceBasis: "raw_unadjusted" as const,
  adjustedPriceBasis:
    "price_index_compatible_corporate_action_adjusted" as const,
  coverageComplete: true,
  dataQualityComplete: true,
  identity: {
    status: "verified_current_master" as const,
    companyCode: "2330",
    companyName: "台積電",
    resolvedMarket: "listed" as const,
    currentMasterMarket: "listed" as const,
    currentMasterName: "台積電",
    masterSnapshotId: "listed-2026-08-24+otc-2026-08-24",
    observedNames: ["台積電"],
    observedMarkets: ["listed" as const],
    reasons: [],
  },
  adjustment: {
    status: "complete" as const,
    adjustmentDirection: "backward" as const,
    anchorDate: "2026-01-05",
    factorAtWindowStart: 0.5,
    cashDividendTreatment: "retained" as const,
    isAdjustedClose: false as const,
    isTotalReturn: false as const,
    volumeAdjusted: false as const,
    volumeBasis: "raw_shares" as const,
    unknownReasons: [],
    officialChangeMarkers: [{ date: "2026-01-05", marker: "X" }],
    unmatchedOfficialChangeMarkers: [],
    marketTransitionDetected: false,
  },
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
      changeMarker: null,
      market: "listed" as const,
      status: "traded" as const,
      qualityStatus: "complete" as const,
      missingFields: [],
      cumulativeFactor: 0.5,
      adjusted: {
        open: 777.5,
        high: 792.5,
        low: 772.5,
        close: 792.5,
      },
      adjustmentStatus: "complete" as const,
      adjustmentUnknownReasons: [],
      volumeBasis: "raw_shares" as const,
    },
    {
      date: "2026-01-05",
      open: 790,
      high: 805,
      low: 785,
      close: 800,
      volumeShares: 30_000_000,
      turnoverTwd: 24_000_000_000,
      tradeCount: 60_000,
      change: 7.5,
      changeMarker: "X",
      market: "listed" as const,
      status: "traded" as const,
      qualityStatus: "complete" as const,
      missingFields: [],
      cumulativeFactor: 1,
      adjusted: {
        open: 790,
        high: 805,
        low: 785,
        close: 800,
      },
      adjustmentStatus: "complete" as const,
      adjustmentUnknownReasons: [],
      volumeBasis: "raw_shares" as const,
    },
  ],
  eventLedgerIncluded: true,
  eventLedger: [
    {
      event: {
        companyCode: "2330",
        name: "台積電",
        market: "listed" as const,
        effectiveDate: "2026-01-05",
        kind: "stock_rights" as const,
        priorCloseTwd: 1585,
        referencePriceTwd: 792.5,
        cashDividendPerShareTwd: null,
        priceIndexAdjustmentFactor: 0.5,
        shareCountChanged: true,
        adjustmentStatus: "available" as const,
        adjustmentReason:
          "official_reference_price_divided_by_prior_close" as const,
        sourceFamily: "ex_right_dividend" as const,
        sourceUrl: "https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail",
        rawType: "除權",
      },
      status: "applied" as const,
      factor: 0.5,
      priorCloseCheck: {
        status: "matched" as const,
        officialPriorCloseTwd: 1585,
        observedPriorCloseDate: "2026-01-02",
        observedPriorCloseTwd: 1585,
        toleranceTwd: 0.00001585,
      },
      markerReconciliation: {
        status: "matched" as const,
        marker: "X",
      },
      unknownReasons: [],
    },
  ],
  coverage: {
    requestedStart: "2026-01-01",
    requestedEnd: "2026-01-31",
    rawPrice: {
      status: "complete" as const,
      coverageComplete: true as const,
      coveredThrough: "2026-01-31",
      pageCount: 1,
      barCount: 2,
      dataQualityComplete: true,
    },
    corporateActions: {
      status: "complete" as const,
      coverage: {
        status: "complete" as const,
        coverageComplete: true,
        requestedStart: "2026-01-01",
        requestedEnd: "2026-01-31",
        gaps: [],
      },
      failure: null,
    },
    adjustment: {
      status: "complete" as const,
      completeBarCount: 2,
      unknownBarCount: 0,
    },
  },
  sources: [
    {
      stage: "company_master" as const,
      market: "listed" as const,
      exchange: "TWSE" as const,
      sourceName: "臺灣證券交易所－上市公司基本資料",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
      reportDate: "2026-08-24",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      rawCount: 2,
      excludedTdrCount: 1,
      companyCount: 1,
      minimumExpectedCount: 1,
    },
    {
      stage: "raw_price" as const,
      market: "listed" as const,
      sourceName: "臺灣證券交易所－個股日成交資訊",
      sourceUrl:
        "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260101&stockNo=2330&response=json",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      snapshotIdentity: "verified" as const,
      dataMonth: "2026-01",
      normalization: {
        volumeShares: {
          sourceUnit: "share" as const,
          outputUnit: "share" as const,
          multiplier: 1 as const,
        },
        turnoverTwd: {
          sourceUnit: "TWD" as const,
          outputUnit: "TWD" as const,
          multiplier: 1 as const,
        },
        tradeCount: {
          sourceUnit: "trade" as const,
          outputUnit: "trade" as const,
          multiplier: 1 as const,
        },
      },
    },
    {
      stage: "corporate_actions" as const,
      market: "listed" as const,
      exchange: "TWSE" as const,
      family: "ex_right_dividend" as const,
      scope: "range_summary" as const,
      sourceName: "臺灣證券交易所－除權除息計算結果表",
      sourceUrl: "https://www.twse.com.tw/rwd/zh/exRight/TWT49U",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      supportedFrom: "2003-05-05",
      queryStart: "2026-01-01",
      queryEnd: "2026-01-31",
      responseStart: "2026-01-01",
      responseEnd: "2026-01-31",
      rawRowCount: 1,
      companyEventCount: 1,
      officialDeclaredRowCount: 1,
      officialDeclaredRowCountAvailable: true,
    },
  ],
  workBudget: {
    orchestrationCompanyMasterCalls: 1 as const,
    rawPriceDependencyMasterLookupPolicy:
      "dependency_managed_per_cursor_page_not_counted_as_orchestration_call" as const,
    rawPricePageLimit: 3 as const,
    rawPricePageCount: 1,
    rawPricePageUnitDefinition: "one_get_stock_ohlc_cursor_page" as const,
    corporateActionHistoryCalls: 1 as const,
    corporateActionOfficialRequestCount: 2,
    corporateActionRequestUnitDefinition:
      "one_official_range_or_selected_event_detail_request" as const,
  },
  fingerprint: "f".repeat(64),
  fingerprintBasis:
    "query_identity_raw_bars_without_retrieved_at_or_cache_plus_corporate_action_history_and_adjustment_evidence" as const,
  warnings: [
    "raw OHLC 與成交量永遠保留官方未還原值；null 不會改寫成 0。",
    "backward price-index-compatible 調整不是 adjusted close 或 total return。",
  ],
} satisfies StockPriceSeriesResult;

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

const observedPriceDailyMarketOhlc = {
  ...dailyMarketOhlc,
  query: {
    market: "listed" as const,
    date: "latest" as const,
    companyCodes: ["2330"],
    universePolicy: "compatible" as const,
  },
  classificationMethod: "current_master" as const,
  classificationPolicy: "current_master_with_code_fallback" as const,
  universeCoverageVerified: true,
  reconciliation: [
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
  ],
  counts: { listed: 1, otc: 0, returned: 1 },
  bars: [dailyMarketOhlc.bars[0]],
  sources: [
    {
      ...dailyMarketOhlc.sources[0],
      sourceName: "臺灣證券交易所－上市個股日成交資訊",
      sourceUrl:
        "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
      snapshotIdentity: "verified" as const,
      cache: {
        status: "bypass" as const,
        observedAt: "2026-08-25T00:00:00.000Z",
        storedAt: null,
        ageMs: null,
        ttlMs: 0,
      },
    },
  ],
  warnings: [
    "compatible current-master reconciliation passed for the selected fixture",
  ],
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
    withClosePrice: 1,
    withDividendPerShare: 1,
    withDividendFiscalYear: 1,
    withReferenceFiscalPeriod: 2,
  },
  rows: [
    {
      code: "2330",
      name: "台積電",
      market: "listed" as const,
      peRatio: 24.6,
      priceToBookRatio: 7.9,
      dividendYieldPercent: 1.8,
      closePriceTwd: 2375,
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: "2026Q2",
      valueStatus: {
        peRatio: "reported" as const,
        priceToBookRatio: "reported" as const,
        dividendYieldPercent: "reported" as const,
        closePriceTwd: "reported" as const,
        dividendPerShareTwd: "not_provided_by_source" as const,
        dividendFiscalYear: "not_provided_by_source" as const,
        referenceFiscalPeriod: "reported" as const,
      },
      rawValue: {
        peRatio: "24.6",
        priceToBookRatio: "7.9",
        dividendYieldPercent: "1.8",
        closePriceTwd: "2375",
        dividendPerShareTwd: null,
        dividendFiscalYear: null,
        referenceFiscalPeriod: "2026Q2",
      },
    },
    {
      code: "3105",
      name: "穩懋",
      market: "otc" as const,
      peRatio: 31.2,
      priceToBookRatio: 4.1,
      dividendYieldPercent: 0.9,
      closePriceTwd: null,
      dividendPerShareTwd: 4.5,
      dividendFiscalYear: 2025,
      referenceFiscalPeriod: "2026Q2",
      valueStatus: {
        peRatio: "reported" as const,
        priceToBookRatio: "reported" as const,
        dividendYieldPercent: "reported" as const,
        closePriceTwd: "not_provided_by_source" as const,
        dividendPerShareTwd: "reported" as const,
        dividendFiscalYear: "reported" as const,
        referenceFiscalPeriod: "reported" as const,
      },
      rawValue: {
        peRatio: "31.2",
        priceToBookRatio: "4.1",
        dividendYieldPercent: "0.9",
        closePriceTwd: null,
        dividendPerShareTwd: "4.5",
        dividendFiscalYear: "114",
        referenceFiscalPeriod: "115年第2季",
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

const revenueSourceIntegrity = {
  format: "json_array" as const,
  structure: "verified" as const,
  snapshotIdentity: "verified" as const,
  eligibleCompanyCodesUnique: "verified" as const,
  officialDeclaredRowCount: null,
  rowsetCompleteness: "unverified_no_official_declared_count" as const,
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
  sourceCoverage: {
    status: "verified" as const,
    method: "current_master_exact_match" as const,
    complete: true,
  },
  selectionComplete: true,
  missingCompanyCodes: [],
  filingCoverage: {
    expectedCompanyCount: 2,
    reportedCompanyCount: 2,
    missingCompanyCodes: [],
    coverageRatio: 1,
    complete: true,
    status: "complete" as const,
  },
  reconciliation: latestMarketReconciliation,
  counts: { listed: 1, otc: 1, returned: 2 },
  rows: [
    {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      market: "listed" as const,
      industryCode: "24",
      sourceIndustryName: "半導體業",
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
      sourceIndustryName: "半導體業",
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
      integrity: revenueSourceIntegrity,
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
      integrity: revenueSourceIntegrity,
    },
  ],
  warnings: ["latest 月份仍應檢查 filingCoverage。"],
};

const companyMetricsBatch = {
  query: {
    companyCodes: ["2330"],
    metricCodes: ["ROE"],
    basis: "quarterly" as const,
    history: "recent_12" as const,
  },
  retrievedAt: "2026-08-25T00:00:00.000Z",
  snapshotId: "batch-fixture",
  metricDefinitions: [
    { code: "ROE", name: "權益報酬率", unit: "%", category: "獲利能力" },
  ],
  companies: [
    {
      companyCode: "2330",
      companyName: "台積電",
      displayName: "2330 台積電",
      evaluationStatus: "complete" as const,
      metrics: [
        {
          metricCode: "ROE",
          metricName: "權益報酬率",
          unit: "%",
          availability: "available" as const,
          periods: ["2026Q1"],
          points: [
            { period: "2026Q1", value: 20.5, valueStatus: "reported" as const },
          ],
          coverage: {
            seriesReturned: true,
            nonNullPoints: 1,
            missingPoints: 0,
            invalidPoints: 0,
            firstReportedPeriod: "2026Q1",
            latestReportedPeriod: "2026Q1",
            missingPeriods: [],
          },
          failure: null,
        },
      ],
    },
  ],
  failures: [],
  coverage: {
    selectionComplete: true,
    requestedCompanyCodes: ["2330"],
    returnedCompanyCodes: ["2330"],
    missingCompanyCodes: [],
    noValidDataCompanyCodes: [],
    unavailableCompanyCodes: [],
    sourceComplete: true,
    failureIsolationComplete: true,
    identityFailedCompanyCodes: [],
    metrics: [
      {
        metricCode: "ROE",
        returnedCompanyCodes: ["2330"],
        missingCompanyCodes: [],
        noValidDataCompanyCodes: [],
        unavailableCompanyCodes: [],
      },
    ],
  },
  workBudget: {
    comparisonPlanUnits: 1,
    comparisonExecutedUnits: 1,
    isolationRetryUnits: 0,
    comparisonUnitLimit: 24 as const,
    identityLookupUpperBound: 1,
    unitDefinition: "one_metric_by_up_to_ten_companies_request" as const,
  },
  sources: [source],
  warnings: [],
} satisfies CompanyMetricsBatchResult;

const screenMetricDefinitions = catalog.metrics
  .filter((metric) => metric.family === "data")
  .map(({ code, name, unit, category }) => ({ code, name, unit, category }));
const screenMetricValues: Record<string, number> = {
  ROE: 20.5,
  NetProfit: 100,
  OperatingCashflow: 120,
  DebtRatio: 35,
  GrossMargin: 55,
  OperatingMargin: 45,
  EPS: 10,
};
const screenCompanyMetricsBatch = {
  ...companyMetricsBatch,
  query: {
    ...companyMetricsBatch.query,
    metricCodes: screenMetricDefinitions.map((metric) => metric.code),
  },
  snapshotId: "screen-batch-fixture",
  metricDefinitions: screenMetricDefinitions,
  companies: companyMetricsBatch.companies.map((company) => ({
    ...company,
    metrics: screenMetricDefinitions.map((definition) => ({
      metricCode: definition.code,
      metricName: definition.name,
      unit: definition.unit,
      availability: "available" as const,
      periods: ["2026Q1"],
      points: [
        {
          period: "2026Q1",
          value: screenMetricValues[definition.code] as number,
          valueStatus: "reported" as const,
        },
      ],
      coverage: {
        seriesReturned: true,
        nonNullPoints: 1,
        missingPoints: 0,
        invalidPoints: 0,
        firstReportedPeriod: "2026Q1",
        latestReportedPeriod: "2026Q1",
        missingPeriods: [],
      },
      failure: null,
    })),
  })),
  coverage: {
    ...companyMetricsBatch.coverage,
    metrics: screenMetricDefinitions.map((metric) => ({
      metricCode: metric.code,
      returnedCompanyCodes: ["2330"],
      missingCompanyCodes: [],
      noValidDataCompanyCodes: [],
      unavailableCompanyCodes: [],
    })),
  },
  workBudget: {
    ...companyMetricsBatch.workBudget,
    comparisonPlanUnits: 7,
    comparisonExecutedUnits: 7,
  },
} satisfies CompanyMetricsBatchResult;

const unavailableMetricFailure = {
  code: "UPSTREAM_TIMEOUT" as const,
  reason: "UPSTREAM_ATTEMPT_TIMEOUT",
  message: "fixture metric timeout",
  retryable: true,
  retryAfterMs: 1000,
  action: "retry" as const,
};

const partialCompanyMetricsBatch = {
  query: {
    companyCodes: ["2330", "9999"],
    metricCodes: ["ROE", "MARGIN"],
    basis: "quarterly" as const,
    history: "recent_12" as const,
  },
  retrievedAt: "2026-08-25T00:00:00.000Z",
  snapshotId: "partial-batch-fixture",
  metricDefinitions: [
    { code: "ROE", name: "權益報酬率", unit: "%", category: "獲利能力" },
    { code: "MARGIN", name: "毛利率", unit: "%", category: "獲利能力" },
  ],
  companies: [
    {
      companyCode: "2330",
      companyName: "台積電",
      displayName: "2330 台積電",
      evaluationStatus: "partial" as const,
      metrics: [
        companyMetricsBatch.companies[0].metrics[0],
        {
          metricCode: "MARGIN",
          metricName: "毛利率",
          unit: "%",
          availability: "unavailable" as const,
          periods: [],
          points: [],
          coverage: {
            seriesReturned: false,
            nonNullPoints: 0,
            missingPoints: 0,
            invalidPoints: 0,
            firstReportedPeriod: null,
            latestReportedPeriod: null,
            missingPeriods: [],
          },
          failure: unavailableMetricFailure,
        },
      ],
    },
  ],
  failures: [
    {
      companyCode: "9999",
      stage: "identity" as const,
      metricCode: null,
      attribution: "company" as const,
      code: "NOT_FOUND" as const,
      reason: null,
      message: "fixture identity not found",
      retryable: false,
      retryAfterMs: null,
      action: "change_query" as const,
    },
    {
      companyCode: "2330",
      stage: "metric" as const,
      metricCode: "MARGIN",
      attribution: "chunk" as const,
      ...unavailableMetricFailure,
    },
  ],
  coverage: {
    selectionComplete: false,
    requestedCompanyCodes: ["2330", "9999"],
    returnedCompanyCodes: [],
    missingCompanyCodes: ["9999", "2330"],
    noValidDataCompanyCodes: ["9999"],
    unavailableCompanyCodes: ["9999", "2330"],
    sourceComplete: false,
    failureIsolationComplete: false,
    identityFailedCompanyCodes: ["9999"],
    metrics: [
      {
        metricCode: "ROE",
        returnedCompanyCodes: ["2330"],
        missingCompanyCodes: ["9999"],
        noValidDataCompanyCodes: ["9999"],
        unavailableCompanyCodes: ["9999"],
      },
      {
        metricCode: "MARGIN",
        returnedCompanyCodes: [],
        missingCompanyCodes: ["9999", "2330"],
        noValidDataCompanyCodes: ["9999", "2330"],
        unavailableCompanyCodes: ["9999", "2330"],
      },
    ],
  },
  workBudget: {
    comparisonPlanUnits: 2,
    comparisonExecutedUnits: 2,
    isolationRetryUnits: 0,
    comparisonUnitLimit: 24 as const,
    identityLookupUpperBound: 2,
    unitDefinition: "one_metric_by_up_to_ten_companies_request" as const,
  },
  sources: [source],
  warnings: ["fixture partial success"],
} satisfies CompanyMetricsBatchResult;

const monthlyRevenueTrend = {
  query: {
    market: "listed" as const,
    companyCodes: ["2330"],
    endMonth: "latest",
    lookbackMonths: 6,
    universePolicy: "compatible" as const,
  },
  startMonth: "2026-02",
  endMonth: "2026-07",
  currency: "TWD" as const,
  amountUnit: "TWD" as const,
  coverageComplete: false,
  sourceCoverage: {
    status: "unverified" as const,
    method: "structure_only_no_official_declared_count" as const,
    complete: false,
  },
  selectionComplete: true,
  missingCompanyCodes: [],
  counts: {
    requestedCompanies: 1,
    returnedCompanies: 1,
    requestedMonths: 6,
  },
  companies: [
    {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      market: "listed" as const,
      industryCode: "24",
      sourceIndustryName: "半導體業",
      observedNames: ["台灣積體電路製造股份有限公司"],
      observedMarkets: ["listed" as const],
      comparability: {
        status: "comparable" as const,
        reasons: [],
        transitions: [],
      },
      missingMonths: [],
      points: [
        ["2026-02", 20],
        ["2026-03", 22],
        ["2026-04", 24],
        ["2026-05", 26],
        ["2026-06", 28],
        ["2026-07", 30],
      ].map(([dataMonth, yoyPercent]) => ({
        dataMonth: dataMonth as string,
        name: "台灣積體電路製造股份有限公司",
        market: "listed" as const,
        sourceReportDate: "2026-08-10",
        sourceIndustryName: "半導體業",
        currentMonthRevenueTwd: 120_000_000_000,
        sameMonthLastYearRevenueTwd: 100_000_000_000,
        momPercent: 2,
        yoyPercent: yoyPercent as number,
        valueStatus: {
          currentMonthRevenueTwd: "reported" as const,
          sameMonthLastYearRevenueTwd: "reported" as const,
          momPercent: "reported" as const,
          yoyPercent: "reported" as const,
        },
      })),
      derived: {
        latestYoyPercent: 30,
        rolling3MonthYoyPercent: 20,
        rolling6MonthYoyPercent: 20,
        yoyAccelerationVs3MonthsAgoPp: 6,
        positiveYoyMonthsInWindow: 6,
        reportedYoyMonthsInWindow: 6,
        consecutivePositiveYoyMonths: 6,
        valueStatus: {
          latestYoyPercent: "reported" as const,
          rolling3MonthYoyPercent: "reported" as const,
          rolling6MonthYoyPercent: "reported" as const,
          yoyAccelerationVs3MonthsAgoPp: "reported" as const,
          positiveYoyMonthsInWindow: "reported" as const,
          reportedYoyMonthsInWindow: "reported" as const,
          consecutivePositiveYoyMonths: "reported" as const,
        },
      },
    },
  ],
  sources: [monthlyRevenue.sources[0]],
  warnings: [],
} satisfies MonthlyRevenueTrendResult;

const stockReactionSignals = {
  query: {
    companyCodes: ["2330"],
    asOf: "latest" as const,
    horizons: [5] as const,
    pageSize: 1,
  },
  timezone: "Asia/Taipei" as const,
  currency: "TWD" as const,
  priceBasis: "raw_unadjusted" as const,
  returnBasis: "price_index_compatible_corporate_action_adjusted" as const,
  benchmarkBasis: "price_index" as const,
  asOf: {
    requested: "latest" as const,
    resolvedByMarket: [{ market: "listed" as const, date: "2026-08-24" }],
  },
  coverage: {
    selectionComplete: true as const,
    benchmarkHistoryComplete: true as const,
    corporateActionHistoryComplete: true,
    dataQualityComplete: true,
    missingCompanyCodes: [] as [],
  },
  pagination: {
    snapshotId: "reaction-scope-fixture",
    requestedCompanyCount: 1,
    requestedPageSize: 1,
    pageStartIndex: 0,
    returnedCompanyCount: 1,
    nextCompanyIndex: 1,
    hasMore: false,
    nextCursor: null,
  },
  workBudget: {
    limit: 48 as const,
    consumed: 4,
    benchmarkUnits: 2,
    stockUnits: 2,
    unitDefinition: "one_official_market_month_request" as const,
    corporateActionRequests: 3,
    corporateActionRequestDefinition:
      "one_official_range_or_detail_request" as const,
  },
  companies: [
    {
      companyCode: "2330",
      companyName: "台積電",
      market: "listed" as const,
      benchmarkCode: "TAIEX" as const,
      requestedAsOf: "latest" as const,
      resolvedAsOf: "2026-08-24",
      stockDataStatus: "available" as const,
      stockDataFailure: null,
      returns: [
        {
          horizonSessions: 5 as const,
          startDate: "2026-08-18",
          endDate: "2026-08-24",
          stockReturnPercent: 3,
          priceIndexCompatibleStockReturnPercent: 3,
          corporateActionAdjustmentFactor: 1,
          benchmarkReturnPercent: 1,
          excessReturnPercentagePoints: 2,
          status: "available" as const,
          excessReturnStatus: "available" as const,
          excessReturnReasons: [],
        },
      ],
      liquidity: {
        averageVolume5SessionsShares: {
          windowSessions: 5 as const,
          startDate: "2026-08-18",
          endDate: "2026-08-24",
          expectedObservationCount: 5,
          observationCount: 5,
          value: 20_000_000,
          status: "available" as const,
        },
        averageVolume20SessionsShares: {
          windowSessions: 20 as const,
          startDate: "2026-07-28",
          endDate: "2026-08-24",
          expectedObservationCount: 20,
          observationCount: 20,
          value: 18_000_000,
          status: "available" as const,
        },
        volume5To20Ratio: {
          numeratorWindowSessions: 5 as const,
          denominatorWindowSessions: 20 as const,
          value: 1.111111,
          status: "available" as const,
        },
        averageTurnover20SessionsTwd: {
          windowSessions: 20 as const,
          startDate: "2026-07-28",
          endDate: "2026-08-24",
          expectedObservationCount: 20,
          observationCount: 20,
          value: 40_000_000_000,
          status: "available" as const,
        },
        averageTurnover60SessionsTwd: {
          windowSessions: 60 as const,
          startDate: "2026-06-01",
          endDate: "2026-08-24",
          expectedObservationCount: 60,
          observationCount: 60,
          value: 35_000_000_000,
          status: "available" as const,
        },
        turnover20To60Ratio: {
          numeratorWindowSessions: 20 as const,
          denominatorWindowSessions: 60 as const,
          value: 1.142857,
          status: "available" as const,
        },
      },
      pricePath: {
        horizonSessions: 5 as const,
        startDate: "2026-08-18",
        endDate: "2026-08-24",
        expectedObservationCount: 6,
        observationCount: 6,
        maximumDrawdownPercent: -1.5,
        distanceBelowWindowHighPercent: 0.5,
        priceBasis:
          "price_index_compatible_corporate_action_adjusted" as const,
        status: "available" as const,
      },
      comparability: {
        status: "price_index_compatible" as const,
        rawPriceBasis: "raw_unadjusted" as const,
        returnBasis:
          "price_index_compatible_corporate_action_adjusted" as const,
        corporateActionAdjustment: "not_required" as const,
        corporateActionEvidence:
          "official_history_verified_no_event" as const,
        corporateActionCoverageComplete: true,
        marketTransitionDetected: false,
        observedMarkets: ["listed" as const],
        corporateActions: [],
        officialChangeMarkers: [],
        unmatchedOfficialChangeMarkers: [],
        reasons: [],
      },
      dataQualityComplete: true,
      warnings: [],
    },
  ],
  benchmarkSources: [
    {
      market: "listed" as const,
      exchange: "TWSE" as const,
      benchmarkCode: "TAIEX" as const,
      benchmarkName: "發行量加權股價指數" as const,
      sourceName: "臺灣證券交易所－發行量加權股價指數",
      sourceUrl: "https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST",
      dataMonth: "2026-08",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      rowCount: 20,
    },
  ],
  stockSources: stockOhlc.sources,
  corporateActionSources: [
    {
      market: "listed" as const,
      exchange: "TWSE" as const,
      family: "ex_right_dividend" as const,
      scope: "range_summary" as const,
      sourceName: "臺灣證券交易所－除權除息計算結果表",
      sourceUrl: "https://www.twse.com.tw/rwd/zh/exRight/TWT49U",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      supportedFrom: "2003-05-05",
      queryStart: "2026-01-01",
      queryEnd: "2026-08-24",
      responseStart: "2026-01-01",
      responseEnd: "2026-08-24",
      rawRowCount: 0,
      companyEventCount: 0,
      officialDeclaredRowCount: 0,
      officialDeclaredRowCountAvailable: true,
    },
  ],
  warnings: [],
} satisfies StockReactionSignalsResult;

function stockUnavailableReactionSignals(): StockReactionSignalsResult {
  const company = stockReactionSignals.companies[0];
  const unavailableAverage = <T extends { observationCount: number; value: number | null }>(
    signal: T,
  ) => ({
    ...signal,
    observationCount: 0,
    value: null,
    status: "stock_data_unavailable" as const,
  });
  return {
    ...stockReactionSignals,
    coverage: {
      ...stockReactionSignals.coverage,
      dataQualityComplete: false,
    },
    companies: [
      {
        ...company,
        stockDataStatus: "unavailable",
        stockDataFailure: {
          code: "UPSTREAM_TIMEOUT",
          reason: "UPSTREAM_REQUEST_TIMEOUT",
          message: "fixture stock timeout",
          retryable: true,
          retryAfterMs: 250,
          action: "retry",
        },
        returns: company.returns.map((signal) => ({
          ...signal,
          stockReturnPercent: null,
          priceIndexCompatibleStockReturnPercent: null,
          corporateActionAdjustmentFactor: null,
          excessReturnPercentagePoints: null,
          status: "stock_data_unavailable" as const,
          excessReturnStatus: "stock_data_unavailable" as const,
          excessReturnReasons: [],
        })),
        liquidity: {
          averageVolume5SessionsShares: unavailableAverage(
            company.liquidity.averageVolume5SessionsShares,
          ),
          averageVolume20SessionsShares: unavailableAverage(
            company.liquidity.averageVolume20SessionsShares,
          ),
          volume5To20Ratio: {
            ...company.liquidity.volume5To20Ratio,
            value: null,
            status: "stock_data_unavailable",
          },
          averageTurnover20SessionsTwd: unavailableAverage(
            company.liquidity.averageTurnover20SessionsTwd,
          ),
          averageTurnover60SessionsTwd: unavailableAverage(
            company.liquidity.averageTurnover60SessionsTwd,
          ),
          turnover20To60Ratio: {
            ...company.liquidity.turnover20To60Ratio,
            value: null,
            status: "stock_data_unavailable",
          },
        },
        pricePath: {
          ...company.pricePath,
          observationCount: 0,
          maximumDrawdownPercent: null,
          distanceBelowWindowHighPercent: null,
          status: "stock_data_unavailable",
        },
        comparability: {
          ...company.comparability,
          status: "unavailable",
          reasons: ["stock_data_unavailable"],
        },
        dataQualityComplete: false,
        warnings: ["fixture OHLC dependency unavailable"],
      },
    ],
  };
}

function unavailableCorporateActionReactionSignals(): StockReactionSignalsResult {
  const company = stockReactionSignals.companies[0];
  return {
    ...stockReactionSignals,
    coverage: {
      ...stockReactionSignals.coverage,
      corporateActionHistoryComplete: false,
      dataQualityComplete: false,
    },
    companies: [
      {
        ...company,
        returns: company.returns.map((signal) => ({
          ...signal,
          priceIndexCompatibleStockReturnPercent: null,
          corporateActionAdjustmentFactor: null,
          excessReturnPercentagePoints: null,
          excessReturnStatus: "not_comparable" as const,
          excessReturnReasons: [
            "corporate_action_adjustment_unavailable" as const,
          ],
        })),
        pricePath: {
          ...company.pricePath,
          maximumDrawdownPercent: null,
          distanceBelowWindowHighPercent: null,
          status: "not_comparable_corporate_action",
        },
        comparability: {
          ...company.comparability,
          status: "not_comparable",
          corporateActionAdjustment: "incomplete",
          corporateActionEvidence: "official_history_verified_events",
          corporateActions: [
            {
              companyCode: "2330",
              name: "台積電",
              market: "listed",
              effectiveDate: "2026-08-20",
              kind: "rights_and_dividend",
              priorCloseTwd: null,
              referencePriceTwd: null,
              cashDividendPerShareTwd: null,
              priceIndexAdjustmentFactor: null,
              shareCountChanged: true,
              adjustmentStatus: "unavailable",
              adjustmentReason: "twse_combined_event_detail_failed",
              sourceFamily: "ex_right_dividend",
              sourceUrl: "https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail",
              rawType: "權息",
            },
          ],
          reasons: ["corporate_action_adjustment_unavailable"],
        },
        dataQualityComplete: false,
      },
    ],
    warnings: ["fixture selected corporate action factor unavailable"],
  };
}

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

function successEnvelope<T extends object>(data: T) {
  return {
    ok: true as const,
    meta: buildResultMeta(data as unknown as Record<string, unknown>),
    ...data,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP protocol integration", () => {
  it("enforces every documented company and page-size boundary", () => {
    const codes = (count: number) =>
      Array.from({ length: count }, (_, index) => String(1000 + index));

    expect(
      valuationModelInputsInputSchema.safeParse({ company_code: "2330" })
        .success,
    ).toBe(true);
    expect(
      valuationModelInputsInputSchema.safeParse({ company_code: "TSMC" })
        .success,
    ).toBe(false);
    expect(
      valuationModelInputsInputSchema.safeParse({
        company_code: "2330",
        wacc: 9,
      }).success,
    ).toBe(false);

    expect(
      companyMetricsBatchInputSchema.safeParse({
        company_codes: codes(100),
        metric_codes: Array.from({ length: 8 }, (_, index) => `M${index}`),
        page_size: 20,
      }).success,
    ).toBe(true);
    expect(
      companyMetricsBatchInputSchema.safeParse({
        company_codes: codes(101),
        metric_codes: ["ROE"],
      }).success,
    ).toBe(false);
    expect(
      companyMetricsBatchInputSchema.safeParse({
        company_codes: ["2330"],
        metric_codes: ["ROE"],
        page_size: 21,
      }).success,
    ).toBe(false);

    expect(
      monthlyRevenueTrendInputSchema.safeParse({
        company_codes: codes(100),
        lookback_months: 24,
        page_size: 20,
      }).success,
    ).toBe(true);
    expect(
      monthlyRevenueTrendInputSchema.safeParse({
        company_codes: codes(101),
        lookback_months: 25,
      }).success,
    ).toBe(false);

    expect(
      stockReactionSignalsInputSchema.safeParse({
        company_codes: codes(50),
        page_size: 10,
      }).success,
    ).toBe(true);
    expect(
      stockReactionSignalsInputSchema.safeParse({
        company_codes: codes(51),
        page_size: 11,
      }).success,
    ).toBe(false);

    const priceSeriesInput = {
      company_code: "2330",
      start_date: "2023-01-01",
      end_date: "2025-12-31",
      price_basis:
        "price_index_compatible_corporate_action_adjusted" as const,
      include_event_ledger: true,
    };
    expect(stockPriceSeriesInputSchema.safeParse(priceSeriesInput).success).toBe(
      true,
    );
    expect(
      stockPriceSeriesInputSchema.safeParse({
        ...priceSeriesInput,
        end_date: "2026-01-01",
      }).success,
    ).toBe(false);
    expect(
      stockPriceSeriesInputSchema.safeParse({
        ...priceSeriesInput,
        start_date: "2025-12-31",
        end_date: "2025-01-01",
      }).success,
    ).toBe(false);
    expect(
      stockPriceSeriesInputSchema.safeParse({
        ...priceSeriesInput,
        unexpected: true,
      }).success,
    ).toBe(false);

    expect(screenTaiwanStockCandidatesInputSchema.parse({})).toEqual({
      market: "all",
      include_ky: true,
      candidate_limit: 5,
      preset: "balanced_non_financial_v2",
    });
    expect(
      screenTaiwanStockCandidatesInputSchema.safeParse({
        company_codes: codes(100),
        candidate_limit: 1,
      }).success,
    ).toBe(true);
    expect(
      screenTaiwanStockCandidatesInputSchema.safeParse({
        company_codes: codes(101),
        candidate_limit: 6,
      }).success,
    ).toBe(false);
    expect(
      screenTaiwanStockCandidatesInputSchema.safeParse({
        company_codes: ["2330", "2330"],
      }).success,
    ).toBe(false);

    for (const schema of [
      listCompaniesInputSchema,
      dailyMarketOhlcInputSchema,
      dailyMarketValuationInputSchema,
      monthlyRevenueInputSchema,
    ]) {
      expect(schema.safeParse({ page_size: 500 }).success).toBe(true);
      expect(schema.safeParse({ page_size: 501 }).success).toBe(false);
    }
  });

  it("enforces company-series identity as a discriminated output contract", () => {
    const baseSeries = {
      label: "2330 台積電",
      points: [
        { period: "2026Q1", value: 20.5, valueStatus: "reported" as const },
      ],
    };

    expect(
      companyMetricOutputSchema.safeParse(
        successEnvelope({
          ...trend,
          series: [{ ...baseSeries, seriesType: "company" }],
        }),
      ).success,
    ).toBe(false);
    expect(
      companyMetricOutputSchema.safeParse(
        successEnvelope({
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
        }),
      ).success,
    ).toBe(false);
    expect(companyMetricOutputSchema.safeParse(successEnvelope(trend)).success).toBe(
      true,
    );
  });

  it("keeps the stock price-series success contract strict", () => {
    const envelope = successEnvelope(stockPriceSeries);
    expect(stockPriceSeriesOutputSchema.safeParse(envelope).success).toBe(true);
    expect(
      stockPriceSeriesOutputSchema.safeParse({
        ...envelope,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      stockPriceSeriesOutputSchema.safeParse({
        ...envelope,
        bars: [
          {
            ...stockPriceSeries.bars[0],
            unexpected: true,
          },
          stockPriceSeries.bars[1],
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts the explicit no-stock-data reaction comparability reason", () => {
    const company = stockReactionSignals.companies[0];
    const result = {
      ...stockReactionSignals,
      coverage: {
        ...stockReactionSignals.coverage,
        dataQualityComplete: false,
      },
      companies: [
        {
          ...company,
          stockDataStatus: "no_data" as const,
          comparability: {
            ...company.comparability,
            status: "unavailable" as const,
            reasons: ["no_stock_data"] as const,
          },
          dataQualityComplete: false,
        },
      ],
    };

    expect(
      stockReactionSignalsOutputSchema.safeParse(successEnvelope(result)).success,
    ).toBe(true);
  });

  it("requires a structured failure only for upstream-unavailable stock data", () => {
    const unavailable = stockUnavailableReactionSignals();
    expect(
      stockReactionSignalsOutputSchema.safeParse(successEnvelope(unavailable)).success,
    ).toBe(true);

    expect(
      stockReactionSignalsOutputSchema.safeParse(
        successEnvelope({
          ...unavailable,
          companies: unavailable.companies.map((company) => ({
            ...company,
            stockDataFailure: null,
          })),
        }),
      ).success,
    ).toBe(false);

    const noDataWithFailure = {
      ...unavailable,
      companies: unavailable.companies.map((company) => ({
        ...company,
        stockDataStatus: "no_data" as const,
      })),
    };
    expect(
      stockReactionSignalsOutputSchema.safeParse(
        successEnvelope(noDataWithFailure),
      ).success,
    ).toBe(false);
  });

  it("accepts official pre-2013 OHLC source months", () => {
    const historical = {
      ...stockOhlc,
      query: {
        ...stockOhlc.query,
        startDate: "2012-12-01",
        endDate: "2012-12-31",
      },
      bars: [
        {
          ...stockOhlc.bars[0],
          date: "2012-12-03",
        },
      ],
      coverage: {
        ...stockOhlc.coverage,
        requestedStart: "2012-12-01",
        requestedEnd: "2012-12-31",
        coveredThrough: "2012-12-31",
      },
      sources: [
        {
          ...stockOhlc.sources[0],
          sourceUrl:
            "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20121201&stockNo=2330&response=json",
          dataMonth: "2012-12",
        },
      ],
    };

    expect(
      stockOhlcOutputSchema.safeParse(successEnvelope(historical)).success,
    ).toBe(true);
  });

  it("initializes, lists all tools and calls each tool with structured output", async () => {
    const completedSessionSpy = vi
      .spyOn(completedSessionResolver, "resolve")
      .mockImplementation(async ({ market, evaluatedAt }) => {
        if (evaluatedAt === undefined) {
          return completedSessionEvidenceFixture({
            market,
            status: "unresolved",
          });
        }
        const canonicalEvaluatedAt =
          evaluatedAt instanceof Date
            ? evaluatedAt.toISOString()
            : typeof evaluatedAt === "string"
              ? new Date(evaluatedAt).toISOString()
              : "2026-08-25T00:00:00.000Z";
        const evidence = completedSessionEvidenceFixture({
          market,
          status: "resolved",
          expectedAsOf: "2026-08-24",
        });
        evidence.evaluatedAt = canonicalEvaluatedAt;
        for (const source of evidence.marketResolutions.flatMap(
          (resolution) => resolution.sources,
        )) {
          source.retrievedAt = canonicalEvaluatedAt;
          source.cache = {
            status: "miss",
            observedAt: canonicalEvaluatedAt,
            storedAt: canonicalEvaluatedAt,
            ageMs: 0,
            ttlMs: 300_000,
          };
        }
        return evidence;
      });
    const catalystSpy = vi
      .spyOn(catalystClient, "getCompanyCatalystEvents")
      .mockResolvedValue(catalystEvents);
    const catalystSnapshotSpy = vi
      .spyOn(
        companyCatalystSnapshotClient,
        "getCompanyCatalystSnapshots",
      )
      .mockResolvedValue(catalystSnapshots);
    const companyMasterSpy = vi
      .spyOn(companyMasterClient, "listCompanies")
      .mockResolvedValue(companyMaster);
    vi.spyOn(priceClient, "getStockOhlc").mockResolvedValue(stockOhlc);
    const priceSeriesSpy = vi
      .spyOn(stockPriceSeriesClient, "getStockPriceSeries")
      .mockResolvedValue(stockPriceSeries);
    vi.spyOn(priceClient, "getDailyMarketOhlc").mockImplementation(
      async () => dailyMarketOhlc,
    );
    const exactCompletedCloseSpy = vi
      .spyOn(priceClient, "getExactCurrentCompanyOhlc")
      .mockImplementation(async (query) => {
        const { code: _code, name: _name, ...bar } =
          observedPriceDailyMarketOhlc.bars[0];
        const exact = exactCurrentCompanyOhlcFixture({
          date: query.date,
          bars: [
            {
              ...completedCloseBar(),
              ...bar,
              date: query.date,
            },
          ],
        });
        exact.source.retrievedAt = "2026-08-25T00:00:00.000Z";
        exact.source.cache = {
          status: "bypass",
          observedAt: "2026-08-25T00:00:00.000Z",
          storedAt: null,
          ageMs: null,
          ttlMs: 0,
        };
        return exact;
      });
    const authoritativeCompletedCloseSpy = vi.spyOn(
      authoritativeCompletedCloseClient,
      "getLatestCompletedClose",
    );
    vi.spyOn(valuationClient, "getDailyMarketValuation").mockResolvedValue(
      dailyMarketValuation,
    );
    const valuationModelInputsSpy = vi.spyOn(
      valuationModelInputsClient,
      "getValuationModelInputsWithContext",
    ).mockResolvedValue({
      data: valuationModelInputs,
      completedClose: null,
      completedCloseError: null,
    });
    vi.spyOn(monthlyRevenueClient, "getMonthlyRevenue").mockResolvedValue(
      monthlyRevenue,
    );
    vi.spyOn(
      monthlyRevenueClient,
      "getMonthlyRevenueTrend",
    ).mockResolvedValue(monthlyRevenueTrend);
    const reactionSpy = vi
      .spyOn(reactionClient, "getStockReactionSignals")
      .mockResolvedValue(stockReactionSignals);
    vi.spyOn(mopsfinClient, "findCompanies").mockResolvedValue([
      { code: "2330", name: "台積電", displayName: "2330 台積電" },
    ]);
    vi.spyOn(mopsfinClient, "findCompaniesWithSource").mockResolvedValue({
      companies: [
        { code: "2330", name: "台積電", displayName: "2330 台積電" },
      ],
      retrievedAt: "2026-08-24T00:00:00.000Z",
      cache: {
        status: "bypass",
        observedAt: "2026-08-24T00:00:00.000Z",
        storedAt: null,
        ageMs: null,
        ttlMs: 0,
      },
    });
    vi.spyOn(mopsfinClient, "getCatalog").mockResolvedValue(catalog);
    const companyMetricSpy = vi
      .spyOn(mopsfinClient, "getCompanyMetric")
      .mockResolvedValue(trend);
    const companyMetricsBatchSpy = vi.spyOn(
      companyMetricsBatchClient,
      "getCompanyMetricsBatch",
    ).mockImplementation(async (query) =>
      query.metricCodes.length === 7
        ? screenCompanyMetricsBatch
        : companyMetricsBatch,
    );
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
          seriesType: "institution",
          institutionCode: "0040000",
          institutionName: "臺銀",
          institutionSector: "bank",
          points: [
            { period: "2026Q1", value: 14.2, valueStatus: "reported" },
          ],
        },
        {
          label: "公司平均數",
          seriesType: "selection_average",
          points: [
            { period: "2026Q1", value: 14.2, valueStatus: "reported" },
          ],
        },
        {
          label: "銀行業資本適足性",
          seriesType: "industry_average",
          points: [
            { period: "2026Q1", value: 15.1, valueStatus: "reported" },
          ],
        },
      ],
      coverage: {
        selectionComplete: true,
        requestedInstitutionCodes: ["0040000"],
        returnedInstitutionCodes: ["0040000"],
        missingInstitutionCodes: [],
        noValidDataInstitutionCodes: [],
        commonThroughPeriod: "2026Q1",
        institutions: [
          {
            institutionCode: "0040000",
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
    });

    const server = new McpServer(
      { name: "mopsfin-test", version: SERVER_VERSION },
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
    expect(client.getServerVersion()?.version).toBe(SERVER_VERSION);
    expect(client.getInstructions()).toContain("IFRSs");
    expect(client.getInstructions()).toContain("NO_DATA");
    expect(client.getInstructions()).toContain("cumulative_yoy");
    expect(client.getInstructions()).toContain("list_companies");
    expect(client.getInstructions()).toContain("TWSE");
    expect(client.getInstructions()).toContain("TPEx");
    expect(client.getInstructions()).toContain("get_stock_ohlc");
    expect(client.getInstructions()).toContain("get_stock_price_series");
    expect(client.getInstructions()).toContain("raw_unadjusted");
    expect(client.getInstructions()).toContain("get_daily_market_valuation");
    expect(client.getInstructions()).toContain("get_valuation_model_inputs");
    expect(client.getInstructions()).toContain("run_reverse_dcf");
    expect(client.getInstructions()).toContain("analyze_observed_price");
    expect(client.getInstructions()).toContain("CALLER_SUPPLIED");
    expect(client.getInstructions()).toContain("get_monthly_revenue");
    expect(client.getInstructions()).toContain("get_monthly_revenue_trend");
    expect(client.getInstructions()).toContain("get_stock_reaction_signals");
    expect(client.getInstructions()).toContain(
      "get_company_catalyst_snapshots",
    );
    expect(client.getInstructions()).toContain(
      "current official catalyst snapshots",
    );
    expect(client.getInstructions()).toContain("point-in-time");
    expect(client.getInstructions()).toContain("screen_taiwan_stock_candidates");
    expect(client.getInstructions()).toContain("get_company_metrics_batch");
    expect(client.getInstructions()).toContain("filingCoverage");
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(TOOL_COUNT);
    expect(listed.tools.map((tool) => tool.name)).toEqual(PUBLIC_TOOL_NAMES);
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
      "符合條件的公司清單",
    );
    expect(
      companyListOutput?.properties?.coverageVerification?.description,
    ).toContain("heuristic gate");
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
    const stockPriceSeriesTool = listed.tools.find(
      (tool) => tool.name === "get_stock_price_series",
    );
    expect(stockPriceSeriesTool?.title).toEqual(expect.stringContaining("價格"));
    expect(stockPriceSeriesTool?.description).toContain("36");
    expect(stockPriceSeriesTool?.description).toContain("raw_unadjusted");
    expect(stockPriceSeriesTool?.description).toContain(
      "price_index_compatible_corporate_action_adjusted",
    );
    expect(stockPriceSeriesTool?.description).toContain("backward");
    expect(stockPriceSeriesTool?.description).toContain("total return");
    expect(stockPriceSeriesTool?.description).toContain("raw shares");
    expect(stockPriceSeriesTool?.description).toContain("include_event_ledger");
    expect(stockPriceSeriesTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "company_code",
        "start_date",
        "end_date",
        "price_basis",
        "include_event_ledger",
      ]),
    });
    expect(
      stockPriceSeriesTool?.inputSchema.properties?.price_basis,
    ).toMatchObject({
      enum: [
        "raw_unadjusted",
        "price_index_compatible_corporate_action_adjusted",
      ],
    });
    expect(
      stockPriceSeriesTool?.inputSchema.properties?.include_event_ledger,
    ).toMatchObject({ type: "boolean" });
    expect(stockPriceSeriesTool?.inputSchema.properties).not.toHaveProperty(
      "cursor",
    );
    const stockPriceSeriesOutput = stockPriceSeriesTool?.outputSchema as
      | {
          additionalProperties?: boolean;
          properties?: Record<
            string,
            {
              description?: string;
              items?: {
                properties?: Record<string, { description?: string }>;
              };
            }
          >;
        }
      | undefined;
    expect(stockPriceSeriesOutput?.additionalProperties).toBe(false);
    expect(
      stockPriceSeriesOutput?.properties?.adjustedPriceBasis?.description,
    ).toContain("null");
    expect(stockPriceSeriesOutput?.properties?.bars?.description).toContain(
      "raw",
    );
    expect(
      stockPriceSeriesOutput?.properties?.bars?.items?.properties?.adjusted
        ?.description,
    ).toContain("null");
    expect(
      stockPriceSeriesOutput?.properties?.eventLedger?.description,
    ).toContain("ledger");
    expect(stockPriceSeriesOutput?.properties?.sources?.description).toContain(
      "stage",
    );
    expect(
      stockPriceSeriesOutput?.properties?.workBudget?.description,
    ).toContain("工作量");
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
    const valuationModelTool = listed.tools.find(
      (tool) => tool.name === "get_valuation_model_inputs",
    );
    expect(valuationModelTool?.description).toContain("data_gap/null");
    expect(valuationModelTool?.description).toContain("point-in-time filing vintage");
    expect(valuationModelTool?.description).toContain("fully diluted shares");
    expect(valuationModelTool?.description).toContain(
      "authoritative completed-session resolver",
    );
    expect(valuationModelTool?.description).toContain(
      "exact single-stock OHLC",
    );
    expect(valuationModelTool?.description).toContain(
      "不使用或回退全市場 latest",
    );
    expect(valuationModelTool?.description).toContain("不執行 DCF");
    expect(valuationModelTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["company_code"],
    });
    const reverseDcfTool = listed.tools.find(
      (tool) => tool.name === "run_reverse_dcf",
    );
    expect(reverseDcfTool?.description).toContain("一次只反解");
    expect(reverseDcfTool?.description).toContain("不提供隱藏預設");
    expect(reverseDcfTool?.description).toContain("不二次 resolve");
    expect(reverseDcfTool?.description).toContain("exact 單股 OHLC");
    expect(reverseDcfTool?.description).toContain("不是 intrinsic value");
    expect(reverseDcfTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(reverseDcfTool?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    const observedPriceTool = listed.tools.find(
      (tool) => tool.name === "analyze_observed_price",
    );
    expect(observedPriceTool?.description).toContain("caller-supplied");
    expect(observedPriceTool?.description).toContain("13:33");
    expect(observedPriceTool?.description).toContain("CALLER_SUPPLIED");
    expect(observedPriceTool?.description).toContain("不是 fair value");
    expect(observedPriceTool?.description).toContain("不是外部盤中 quote provider");
    expect(observedPriceTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "company_code",
        "observed_price_twd",
        "observed_at",
        "source_label",
      ],
    });
    expect(observedPriceTool?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    const revenueTool = listed.tools.find(
      (tool) => tool.name === "get_monthly_revenue",
    );
    expect(revenueTool?.description).toContain("filingCoverage");
    expect(revenueTool?.description).toContain("1,000");
    expect(revenueTool?.inputSchema.properties?.data_month).toMatchObject({
      default: "latest",
    });
    const revenueTrendTool = listed.tools.find(
      (tool) => tool.name === "get_monthly_revenue_trend",
    );
    expect(revenueTrendTool?.description).toContain("3");
    expect(revenueTrendTool?.description).toContain("YoY");
    expect(revenueTrendTool?.inputSchema.properties?.lookback_months).toHaveProperty(
      "description",
    );
    const reactionTool = listed.tools.find(
      (tool) => tool.name === "get_stock_reaction_signals",
    );
    expect(reactionTool?.description).toContain("raw_unadjusted");
    expect(reactionTool?.description).toContain("actual-result");
    expect(reactionTool?.description).toContain("total return");
    expect(reactionTool?.description).toContain("benchmark");
    expect(reactionTool?.inputSchema.properties?.horizons).toHaveProperty(
      "description",
    );
    const catalystTool = listed.tools.find(
      (tool) => tool.name === "get_company_catalyst_events",
    );
    expect(catalystTool?.description).toContain("重大訊息");
    expect(catalystTool?.description).toContain("法人說明會");
    expect(catalystTool?.description).toContain("publishedAt");
    expect(catalystTool?.description).toContain("consensus");
    expect(catalystTool?.description).toContain("不是 point-in-time snapshot");
    expect(catalystTool?.inputSchema.properties?.company_codes).toMatchObject({
      minItems: 1,
      maxItems: 20,
    });
    expect(catalystTool?.inputSchema.properties?.limit).toMatchObject({
      default: 50,
      maximum: 100,
    });
    const catalystSnapshotTool = listed.tools.find(
      (tool) => tool.name === "get_company_catalyst_snapshots",
    );
    expect(catalystSnapshotTool?.description).toContain(
      "current official snapshot evidence",
    );
    expect(catalystSnapshotTool?.description).toContain("sourceSnapshotDate");
    expect(catalystSnapshotTool?.description).toContain(
      "pointInTimeHistoryAvailable",
    );
    expect(catalystSnapshotTool?.description).toContain("upcomingEligible");
    expect(catalystSnapshotTool?.description).toContain("consensus");
    expect(catalystSnapshotTool?.description).toContain("t187ap39_O");
    expect(catalystSnapshotTool?.description).toContain(
      "TPEx 沒有可用 current dividend endpoint",
    );
    expect(
      catalystSnapshotTool?.inputSchema.properties?.company_codes,
    ).toMatchObject({ minItems: 1, maxItems: 20 });
    expect(
      catalystSnapshotTool?.inputSchema.properties?.snapshot_types,
    ).toMatchObject({
      minItems: 1,
      maxItems: 4,
      default: [
        "forecast_achievement",
        "forecast_material_variance",
        "shareholder_meeting",
        "dividend_decision",
      ],
    });
    expect(catalystSnapshotTool?.inputSchema.properties?.as_of).toMatchObject({
      const: "latest",
      default: "latest",
    });
    expect(catalystSnapshotTool?.inputSchema.properties?.offset).toMatchObject({
      default: 0,
      minimum: 0,
    });
    expect(catalystSnapshotTool?.inputSchema.properties?.limit).toMatchObject({
      default: 50,
      maximum: 100,
    });
    const catalystSnapshotOutput = catalystSnapshotTool?.outputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    expect(catalystSnapshotOutput?.properties?.records?.description).toContain(
      "snapshot records",
    );
    expect(catalystSnapshotOutput?.properties?.sources?.description).toContain(
      "stale",
    );
    expect(catalystSnapshotOutput?.properties?.isConsensus?.description).toContain(
      "不是分析師 consensus",
    );
    const screenTool = listed.tools.find(
      (tool) => tool.name === "screen_taiwan_stock_candidates",
    );
    expect(screenTool?.description).toContain("latest");
    expect(screenTool?.description).toContain("前 10 家");
    expect(screenTool?.description).toContain("最多 5 家");
    expect(screenTool?.description).toContain("hard gates");
    expect(screenTool?.description).toContain("unknown 也不等於 0");
    expect(screenTool?.description).toContain("24 comparison units");
    expect(screenTool?.description).toContain("company_metrics_unavailable");
    expect(screenTool?.description).toContain("semantic roles");
    expect(screenTool?.description).toContain("CATALOG_CONTRACT_MISMATCH");
    expect(screenTool?.description).toContain("generic metric tools");
    expect(screenTool?.description).toContain("notReactionScored");
    expect(screenTool?.description).toContain("price-index-compatible");
    expect(screenTool?.description).toContain("mixed as-of");
    expect(screenTool?.description).toContain("不是投資建議");
    expect(screenTool?.inputSchema.properties?.market).toMatchObject({
      default: "all",
    });
    expect(screenTool?.inputSchema.properties?.include_ky).toMatchObject({
      default: true,
    });
    expect(screenTool?.inputSchema.properties?.candidate_limit).toMatchObject({
      default: 5,
      minimum: 1,
      maximum: 5,
    });
    expect(screenTool?.inputSchema.properties?.preset).toMatchObject({
      default: "balanced_non_financial_v2",
      const: "balanced_non_financial_v2",
    });
    const financialScreenTool = listed.tools.find(
      (tool) => tool.name === "screen_taiwan_financial_candidates",
    );
    expect(financialScreenTool?.description).toContain("balanced_financial_v1");
    expect(financialScreenTool?.description).toContain("exact-code");
    expect(financialScreenTool?.description).toContain("cross-model");
    expect(financialScreenTool?.description).toContain("不是投資建議");
    expect(financialScreenTool?.inputSchema.properties?.market).toMatchObject({
      default: "all",
    });
    expect(
      financialScreenTool?.inputSchema.properties?.candidate_limit,
    ).toMatchObject({ default: 5, minimum: 1, maximum: 5 });
    expect(financialScreenTool?.inputSchema.properties?.preset).toMatchObject({
      default: "balanced_financial_v1",
      const: "balanced_financial_v1",
    });
    const marketScreenTool = listed.tools.find(
      (tool) => tool.name === "screen_taiwan_market_candidates",
    );
    expect(marketScreenTool?.description).toContain("balanced_market_v1");
    expect(marketScreenTool?.description).toContain(
      "crossModelScoreComparable=false",
    );
    expect(marketScreenTool?.description).toContain("不自動補額");
    expect(marketScreenTool?.description).toContain("不是投資建議");
    expect(
      marketScreenTool?.inputSchema.properties?.non_financial_limit,
    ).toMatchObject({ default: 4, minimum: 1, maximum: 5 });
    expect(
      marketScreenTool?.inputSchema.properties?.financial_limit,
    ).toMatchObject({ default: 1, minimum: 1, maximum: 5 });
    expect(marketScreenTool?.inputSchema.properties?.preset).toMatchObject({
      default: "balanced_market_v1",
      const: "balanced_market_v1",
    });
    const fullUniverseTool = listed.tools.find(
      (tool) => tool.name === "screen_taiwan_market_universe_page",
    );
    expect(fullUniverseTool?.description).toContain("full_universe_cursor_v1");
    expect(fullUniverseTool?.description).toContain(
      "STATELESS_PAGE_VALUES_NOT_PINNED",
    );
    expect(fullUniverseTool?.description).toContain("SNAPSHOT_CHANGED");
    expect(fullUniverseTool?.description).toContain("不是投資建議");
    expect(fullUniverseTool?.inputSchema.properties?.page_size).toMatchObject({
      default: 5,
      minimum: 1,
      maximum: 5,
    });
    expect(fullUniverseTool?.inputSchema.properties?.preset).toMatchObject({
      default: "full_universe_cursor_v1",
      const: "full_universe_cursor_v1",
    });
    const researchTool = listed.tools.find(
      (tool) =>
        tool.name ===
        "screen_taiwan_stock_candidates_with_catalyst_snapshots",
    );
    expect(researchTool?.description).toContain("ordered screen.candidates");
    expect(researchTool?.description).toContain("affectsScreenScore=false");
    expect(researchTool?.description).toContain("不是分析師 consensus");
    expect(researchTool?.description).toContain("not_disclosed_in_snapshot");
    expect(researchTool?.description).toContain("沒有 candidates 時不呼叫");
    expect(researchTool?.inputSchema.properties?.screen).toHaveProperty(
      "description",
    );
    expect(
      researchTool?.inputSchema.properties?.catalyst_snapshots,
    ).toHaveProperty("description");
    const batchTool = listed.tools.find(
      (tool) => tool.name === "get_company_metrics_batch",
    );
    expect(batchTool?.description).toContain("1–100");
    expect(batchTool?.description).toContain("availability=unavailable");
    expect(batchTool?.description).toContain("failureIsolationComplete=false");
    expect(batchTool?.description).toContain("Partial success");
    expect(batchTool?.description).toContain("meta.page.next");
    expect(batchTool?.inputSchema.properties?.metric_codes).toHaveProperty(
      "description",
    );
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
      [
        "get_stock_price_series",
        {
          company_code: "2330",
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          price_basis:
            "price_index_compatible_corporate_action_adjusted",
          include_event_ledger: true,
        },
      ],
      ["get_daily_market_ohlc", { market: "all", date: "latest" }],
      [
        "analyze_observed_price",
        {
          company_code: "2330",
          observed_price_twd: 2400,
          observed_at: "2026-08-25T09:32:00+08:00",
          source_label: "caller supplied integration fixture",
        },
      ],
      [
        "get_stock_reaction_signals",
        {
          company_codes: ["2330"],
          as_of: "latest",
          horizons: [5],
          page_size: 1,
        },
      ],
      [
        "get_company_catalyst_events",
        {
          company_codes: ["2330"],
          start_date: "2026-01-01",
          end_date: "2026-01-31",
        },
      ],
      [
        "get_company_catalyst_snapshots",
        {
          company_codes: ["3105"],
        },
      ],
      [
        "screen_taiwan_stock_candidates",
        {
          market: "listed",
          company_codes: ["2330"],
          candidate_limit: 1,
        },
      ],
      [
        "screen_taiwan_stock_candidates_with_catalyst_snapshots",
        {
          screen: {
            market: "listed",
            company_codes: ["2330"],
            candidate_limit: 1,
          },
          catalyst_snapshots: {
            snapshot_types: ["shareholder_meeting"],
            record_preview_limit: 10,
          },
        },
      ],
      ["get_daily_market_valuation", { market: "all" }],
      ["get_valuation_model_inputs", { company_code: "2330" }],
      ["get_monthly_revenue", { market: "all" }],
      [
        "get_monthly_revenue_trend",
        {
          market: "listed",
          company_codes: ["2330"],
          end_month: "latest",
          lookback_months: 6,
        },
      ],
      ["list_companies", { market: "all" }],
      ["list_catalog", { kind: "all" }],
      [
        "get_company_metric",
        { metric_code: "ROE", company_codes: ["2330"] },
      ],
      [
        "get_company_metrics_batch",
        { metric_codes: ["ROE"], company_codes: ["2330"] },
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
      [
        "screen_taiwan_financial_candidates",
        {
          market: "listed",
          company_codes: ["2330"],
          candidate_limit: 1,
        },
      ],
      [
        "screen_taiwan_market_candidates",
        {
          market: "listed",
          non_financial_limit: 1,
          financial_limit: 1,
        },
      ],
      [
        "screen_taiwan_market_universe_page",
        {
          market: "all",
          page_size: 2,
        },
      ],
    ] as const;

    for (const [name, args] of calls) {
      const resolverCallsBeforeTool = completedSessionSpy.mock.calls.length;
      const result = await client.callTool({ name, arguments: args });
      const resultContext = `${name}: ${JSON.stringify(result)}`;
      expect(result.isError, resultContext).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.structuredContent, resultContext).toMatchObject({
        ok: true,
        meta: {
          contractVersion: "mopsfin.result.v1",
          asOf: {
            timezone: "Asia/Taipei",
            servedAt: expect.any(String),
            assembledAt: expect.any(String),
            sourceCutoffs: expect.any(Array),
          },
          quality: {
            status: expect.stringMatching(/^(complete|partial)$/),
            freshness: expect.stringMatching(
              /^(within_expected_window|stale|unknown|not_applicable)$/,
            ),
            freshnessDetails: expect.arrayContaining([
              expect.objectContaining({
                policyId: expect.any(String),
                reasonCode: expect.any(String),
              }),
            ]),
          },
          page: {
            mode: expect.stringMatching(/^(none|offset|cursor)$/),
          },
        },
      });
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
          meta: {
            asOf: {
              selector: string;
              resolved: { granularity: string; from: string; through: string };
            };
            quality: {
              status: string;
              universe: string;
              issues: Array<{ code: string; scope: string }>;
            };
          };
          coverageVerification: {
            status: string;
            officialDeclaredRowCountAvailable: boolean;
          };
          coverageComplete: boolean;
          counts: { listed: number; otc: number; returned: number };
          profileCoverage: {
            incorporationDate: {
              reported: number;
              missing: number;
              invalid: number;
            };
          };
          companies: Array<{
            code: string;
            market: string;
            incorporationDate: string | null;
            paidInCapitalTwd: number | null;
            profileValueStatus: { paidInCapitalTwd: string };
          }>;
        };
        expect(structured.coverageVerification).toEqual({
          status: "heuristic",
          method: "required_sources_schema_single_report_date_minimum_count",
          officialDeclaredRowCountAvailable: false,
        });
        expect(structured.coverageComplete).toBe(true);
        expect(structured.meta.asOf).toMatchObject({
          selector: "snapshot",
          resolved: {
            granularity: "date",
            from: "2026-08-24",
            through: "2026-08-24",
          },
        });
        expect(structured.meta.quality.status).toBe("partial");
        expect(structured.meta.quality.universe).toBe("unverified");
        expect(structured.meta.quality.issues).toContainEqual(
          expect.objectContaining({
            code: "MASTER_ROWSET_HEURISTIC",
            scope: "universe",
          }),
        );
        expect(structured.counts).toMatchObject({ listed: 1, otc: 1, returned: 2 });
        expect(structured.profileCoverage.incorporationDate).toEqual({
          reported: 2,
          missing: 0,
          invalid: 0,
        });
        expect(structured.companies.map((company) => company.code)).toEqual([
          "2330",
          "3105",
        ]);
        expect(structured.companies[0]).toMatchObject({
          incorporationDate: "1987-02-21",
          paidInCapitalTwd: 280_500_000_000,
          profileValueStatus: { paidInCapitalTwd: "reported" },
        });
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
      if (name === "get_stock_price_series") {
        const structured = result.structuredContent as {
          meta: {
            asOf: {
              selector: string;
              resolved: {
                granularity: string;
                from: string | null;
                through: string | null;
              };
              snapshotId: string | null;
            };
            quality: {
              status: string;
              source: string;
              universe: string;
              selection: string;
              values: string;
              freshness: string;
              issues: Array<{ code: string }>;
            };
            page: { mode: string; unit: string; next: unknown };
          };
          requestedPriceBasis: string;
          rawPriceBasis: string;
          adjustedPriceBasis: string | null;
          coverageComplete: boolean;
          dataQualityComplete: boolean;
          identity: { status: string; companyCode: string };
          adjustment: {
            status: string;
            adjustmentDirection: string;
            anchorDate: string;
            factorAtWindowStart: number | null;
            cashDividendTreatment: string;
            isAdjustedClose: boolean;
            isTotalReturn: boolean;
            volumeAdjusted: boolean;
            volumeBasis: string;
          };
          bars: Array<{
            date: string;
            close: number | null;
            cumulativeFactor: number | null;
            adjusted: { close: number | null } | null;
            adjustmentStatus: string;
            volumeShares: number | null;
            volumeBasis: string;
          }>;
          eventLedgerIncluded: boolean;
          eventLedger: Array<{
            status: string;
            factor: number | null;
            priorCloseCheck: { status: string };
            markerReconciliation: { status: string; marker: string | null };
          }>;
          coverage: {
            rawPrice: { pageCount: number; coverageComplete: boolean };
            corporateActions: { status: string };
            adjustment: {
              status: string;
              completeBarCount: number;
              unknownBarCount: number;
            };
          };
          workBudget: {
            rawPricePageLimit: number;
            rawPricePageCount: number;
            corporateActionHistoryCalls: number;
          };
        };
        expect(structured.meta).toMatchObject({
          asOf: {
            selector: "range",
            resolved: {
              granularity: "date",
              from: "2026-01-02",
              through: "2026-01-05",
            },
            snapshotId: "f".repeat(64),
          },
          quality: {
            status: "complete",
            source: "complete",
            universe: "verified",
            selection: "complete",
            values: "complete",
            freshness: "not_applicable",
          },
          page: { mode: "none", unit: "none", next: null },
        });
        expect(structured.meta.quality.issues.map((issue) => issue.code)).toEqual(
          expect.arrayContaining([
            "PRICE_INDEX_COMPATIBLE_ADJUSTMENT_BASIS",
            "RAW_VOLUME_NOT_ADJUSTED",
          ]),
        );
        expect(structured).toMatchObject({
          requestedPriceBasis:
            "price_index_compatible_corporate_action_adjusted",
          rawPriceBasis: "raw_unadjusted",
          adjustedPriceBasis:
            "price_index_compatible_corporate_action_adjusted",
          coverageComplete: true,
          dataQualityComplete: true,
          identity: {
            status: "verified_current_master",
            companyCode: "2330",
          },
          adjustment: {
            status: "complete",
            adjustmentDirection: "backward",
            anchorDate: "2026-01-05",
            factorAtWindowStart: 0.5,
            cashDividendTreatment: "retained",
            isAdjustedClose: false,
            isTotalReturn: false,
            volumeAdjusted: false,
            volumeBasis: "raw_shares",
          },
          eventLedgerIncluded: true,
          coverage: {
            rawPrice: { pageCount: 1, coverageComplete: true },
            corporateActions: { status: "complete" },
            adjustment: {
              status: "complete",
              completeBarCount: 2,
              unknownBarCount: 0,
            },
          },
          workBudget: {
            rawPricePageLimit: 3,
            rawPricePageCount: 1,
            corporateActionHistoryCalls: 1,
          },
        });
        expect(structured.bars[0]).toMatchObject({
          date: "2026-01-02",
          close: 1585,
          cumulativeFactor: 0.5,
          adjusted: { close: 792.5 },
          adjustmentStatus: "complete",
          volumeShares: 25_000_000,
          volumeBasis: "raw_shares",
        });
        expect(structured.eventLedger).toEqual([
          expect.objectContaining({
            status: "applied",
            factor: 0.5,
            priorCloseCheck: expect.objectContaining({ status: "matched" }),
            markerReconciliation: expect.objectContaining({
              status: "matched",
              marker: "X",
            }),
          }),
        ]);
      }
      if (name === "get_daily_market_ohlc") {
        const structured = result.structuredContent as {
          meta: {
            quality: {
              freshness: string;
              issues: Array<{ code: string }>;
            };
          };
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
        expect(structured.meta.quality.freshness).toBe("unknown");
        expect(structured.meta.quality.issues).toContainEqual(
          expect.objectContaining({ code: "FRESHNESS_UNVERIFIED" }),
        );
      }
      if (name === "analyze_observed_price") {
        const structured = result.structuredContent as {
          latestOfficialCompletedClose: number;
          latestOfficialCloseDate: string;
          sources: Array<{
            stage: string;
            companyCode?: string;
            dataMonth?: string;
            selectedBarDate?: string;
          }>;
          meta: {
            quality: {
              freshnessDetails: Array<{
                policyId: string;
                observedAsOf: string | null;
                expectedAsOf: string | null;
                sourceUrls: string[];
              }>;
            };
          };
        };
        expect(structured).toMatchObject({
          latestOfficialCompletedClose: 2_375,
          latestOfficialCloseDate: "2026-08-24",
        });
        expect(structured.sources[2]).toMatchObject({
          stage: "latest_official_completed_close",
          companyCode: "2330",
          dataMonth: "2026-08",
          selectedBarDate: "2026-08-24",
        });
        expect(
          structured.meta.quality.freshnessDetails.find(
            (detail) =>
              detail.policyId === "official.completed-session.v1",
          ),
        ).toMatchObject({
          observedAsOf: "2026-08-24",
          expectedAsOf: "2026-08-24",
        });
        expect(
          structured.meta.quality.freshnessDetails.filter(
            (detail) =>
              detail.policyId ===
              "official.current-snapshot.max-age-7d.v1",
          ),
        ).toEqual([
          expect.objectContaining({
            sourceUrls: [
              "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
            ],
          }),
          expect.objectContaining({
            sourceUrls: [
              "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
            ],
          }),
        ]);
        expect(authoritativeCompletedCloseSpy).toHaveBeenCalledTimes(1);
        expect(exactCompletedCloseSpy).toHaveBeenCalledTimes(1);
      }
      if (name === "get_daily_market_valuation") {
        const structured = result.structuredContent as {
          dataDate: string;
          universeCoverageVerified: boolean;
          counts: { returned: number };
          rows: Array<{
            code: string;
            peRatio: number | null;
            closePriceTwd: number | null;
            dividendPerShareTwd: number | null;
            dividendFiscalYear: number | null;
            referenceFiscalPeriod: string | null;
            valueStatus: {
              peRatio: string;
              closePriceTwd: string;
              dividendPerShareTwd: string;
            };
            rawValue: {
              closePriceTwd: string | null;
              dividendPerShareTwd: string | null;
              referenceFiscalPeriod: string | null;
            };
          }>;
        };
        expect(structured).toMatchObject({
          dataDate: "2026-08-24",
          universeCoverageVerified: true,
          counts: {
            returned: 2,
            withClosePrice: 1,
            withDividendPerShare: 1,
            withDividendFiscalYear: 1,
            withReferenceFiscalPeriod: 2,
          },
        });
        expect(structured.rows[0]).toMatchObject({
          code: "2330",
          peRatio: 24.6,
          closePriceTwd: 2375,
          dividendPerShareTwd: null,
          dividendFiscalYear: null,
          referenceFiscalPeriod: "2026Q2",
          valueStatus: {
            peRatio: "reported",
            closePriceTwd: "reported",
            dividendPerShareTwd: "not_provided_by_source",
          },
          rawValue: {
            closePriceTwd: "2375",
            dividendPerShareTwd: null,
            referenceFiscalPeriod: "2026Q2",
          },
        });
      }
      if (name === "get_valuation_model_inputs") {
        const structured = result.structuredContent as {
          meta: {
            asOf: {
              selector: string;
              resolved: {
                granularity: string;
                from: string | null;
                through: string | null;
              };
            };
            quality: {
              source: string;
              values: string;
              freshness: string;
              freshnessDetails: Array<{ policyId: string; status: string }>;
              issues: Array<{ code: string }>;
            };
          };
          quality: { dataGapFields: string[] };
          fields: Record<string, { value: number | null; status: string }>;
          workBudget: {
            statementCalls: { actual: number; maximum: number };
          };
        };
        expect(structured.meta.asOf).toMatchObject({
          selector: "latest",
          resolved: {
            granularity: "mixed",
            from: null,
            through: null,
          },
        });
        expect(structured.meta.quality).toMatchObject({
          source: "partial",
          values: "partial",
          freshness: "unknown",
        });
        expect(structured.meta.quality.freshnessDetails).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              policyId: "mopsfin.latest-unverified.v1",
              status: "unknown",
            }),
          ]),
        );
        expect(
          structured.meta.quality.freshnessDetails.some(
            (detail) =>
              detail.policyId === "official.completed-session.v1",
          ),
        ).toBe(false);
        expect(completedSessionSpy).toHaveBeenCalledTimes(
          resolverCallsBeforeTool,
        );
        expect(structured.meta.quality.issues.map((issue) => issue.code)).toEqual(
          expect.arrayContaining([
            "VALUATION_MODEL_DATA_GAP",
            "VALUATION_MODEL_EVIDENCE_CLASSES",
            "FINANCIAL_STATEMENT_CURRENT_VIEW_NOT_POINT_IN_TIME",
            "DATA_GAPS_NOT_ZERO_FILLED",
            "ISSUED_SHARES_NOT_DILUTED",
            "SOURCE_DEPENDENCY_INCOMPLETE",
            "FRESHNESS_UNVERIFIED",
          ]),
        );
        expect(structured.quality.dataGapFields).toHaveLength(14);
        expect(
          Object.values(structured.fields).every(
            (field) => field.status === "data_gap" && field.value === null,
          ),
        ).toBe(true);
        expect(structured.workBudget.statementCalls).toEqual({
          actual: 3,
          maximum: 7,
          rowsPerCallMaximum: 500,
        });
      }
      if (name === "get_monthly_revenue") {
        const structured = result.structuredContent as {
          meta: {
            quality: {
              freshness: string;
              freshnessDetails: Array<{
                policyId: string;
                expectedAsOf: string | null;
              }>;
            };
          };
          dataMonth: string;
          amountUnit: string;
          filingCoverage: {
            reportedCompanyCount: number;
            expectedCompanyCount: number;
          };
          rows: Array<{
            code: string;
            sourceIndustryName: string | null;
            currentMonthRevenueTwd: number | null;
          }>;
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
          sourceIndustryName: "半導體業",
          currentMonthRevenueTwd: 323_000_000_000,
        });
        expect(structured.meta.quality.freshness).toBe(
          "within_expected_window",
        );
        expect(structured.meta.quality.freshnessDetails[0]).toMatchObject({
          policyId: "official.monthly-revenue.latest-common.v1",
          expectedAsOf: "2026-07",
        });
      }
      if (name === "get_stock_reaction_signals") {
        const structured = result.structuredContent as {
          priceBasis: string;
          returnBasis: string;
          benchmarkBasis: string;
          coverage: { corporateActionHistoryComplete: boolean };
          pagination: { hasMore: boolean; nextCursor: string | null };
          companies: Array<{
            companyCode: string;
            dataQualityComplete: boolean;
            returns: Array<{
              horizonSessions: number;
              status: string;
              priceIndexCompatibleStockReturnPercent: number | null;
              excessReturnPercentagePoints: number | null;
            }>;
          }>;
        };
        expect(structured).toMatchObject({
          priceBasis: "raw_unadjusted",
          returnBasis: "price_index_compatible_corporate_action_adjusted",
          benchmarkBasis: "price_index",
          coverage: { corporateActionHistoryComplete: true },
          pagination: { hasMore: false, nextCursor: null },
          companies: [{ companyCode: "2330", dataQualityComplete: true }],
        });
        expect(structured.companies[0].returns[0]).toMatchObject({
          horizonSessions: 5,
          status: "available",
          priceIndexCompatibleStockReturnPercent: 3,
          excessReturnPercentagePoints: 2,
        });
      }
      if (name === "get_company_catalyst_events") {
        const structured = result.structuredContent as {
          meta: {
            asOf: { selector: string; snapshotId: string | null };
            quality: { source: string; selection: string; values: string };
            page: { mode: string; unit: string; total: number | null };
          };
          isConsensus: boolean;
          events: Array<{
            eventType: string;
            publishedAt: string | null;
            factDate: string | null;
            scheduledAt: string | null;
            effectiveAt: string | null;
          }>;
          coverage: { failureIsolation: string };
        };
        expect(structured.meta).toMatchObject({
          asOf: {
            selector: "range",
            snapshotId: "fixture-catalyst-fingerprint",
          },
          quality: {
            source: "complete",
            selection: "complete",
            values: "complete",
          },
          page: { mode: "offset", unit: "row", total: 1 },
        });
        expect(structured.isConsensus).toBe(false);
        expect(structured.events[0]).toMatchObject({
          eventType: "material_information",
          publishedAt: "2026-01-15T13:30:00+08:00",
          factDate: "2026-01-15",
          scheduledAt: null,
          effectiveAt: null,
        });
        expect(structured.coverage.failureIsolation).toBe(
          "per_company_event_type_calendar_month",
        );
      }
      if (name === "get_company_catalyst_snapshots") {
        const structured = result.structuredContent as {
          meta: {
            asOf: {
              selector: string;
              resolved: {
                granularity: string;
                from: string | null;
                through: string | null;
              };
              snapshotId: string | null;
            };
            quality: {
              source: string;
              universe: string;
              selection: string;
              values: string;
              freshness: string;
              issues: Array<{ code: string }>;
            };
            page: { mode: string; unit: string; total: number | null };
          };
          scope: string;
          isConsensus: boolean;
          records: Array<{
            snapshotType: string;
            freshness: string;
            pointInTimeHistoryAvailable: boolean;
            firstKnownAt: null;
            isConsensus: boolean;
            upcomingEligible: boolean;
            details: { kind: string; meetingDate?: string };
          }>;
          sources: Array<{
            snapshotType: string;
            market: string;
            sourceKey: string;
            sourceUrl: string | null;
            status: string;
            freshness: string;
            pointInTimeHistoryAvailable: boolean;
            isConsensus: boolean;
          }>;
          coverage: {
            sourceComplete: boolean;
            selection: string;
            failureIsolation: string;
            snapshots: Array<{
              snapshotType: string;
              status: string;
              disclosureStatus: string;
              freshness: string;
            }>;
          };
          companies: Array<{
            staleSnapshotTypes: string[];
            unsupportedSnapshotTypes: string[];
            failedSnapshotTypes: string[];
          }>;
          failures: Array<{
            snapshotType: string;
            affectedCompanyCodes: string[];
          }>;
        };
        expect(structured.meta).toMatchObject({
          asOf: {
            selector: "latest",
            resolved: {
              granularity: "mixed",
              from: "2021-04-16",
              through: "2026-08-27",
            },
            snapshotId: "fixture-catalyst-snapshot-fingerprint",
          },
          quality: {
            source: "partial",
            universe: "verified",
            selection: "partial",
            values: "partial",
            freshness: "stale",
          },
          page: { mode: "offset", unit: "row", total: 2 },
        });
        expect(structured.meta.quality.issues.map((issue) => issue.code)).toEqual(
          expect.arrayContaining([
            "CATALYST_SNAPSHOT_SOURCE_FAILED",
            "CATALYST_SNAPSHOT_SOURCE_STALE",
            "CATALYST_SNAPSHOT_ROUTE_UNSUPPORTED",
            "CATALYST_SNAPSHOT_NO_POINT_IN_TIME_HISTORY",
            "OFFICIAL_DISCLOSURE_NOT_CONSENSUS",
          ]),
        );
        expect(structured).toMatchObject({
          scope: "current_official_company_snapshots",
          isConsensus: false,
          coverage: {
            sourceComplete: false,
            selection: "partial",
            failureIsolation: "per_snapshot_type_market",
          },
          failures: [
            {
              snapshotType: "forecast_material_variance",
              affectedCompanyCodes: ["3105"],
            },
          ],
        });
        expect(structured.records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              snapshotType: "forecast_achievement",
              freshness: "stale",
              pointInTimeHistoryAvailable: false,
              firstKnownAt: null,
              isConsensus: false,
              upcomingEligible: false,
            }),
            expect.objectContaining({
              snapshotType: "shareholder_meeting",
              freshness: "within_expected_window",
              pointInTimeHistoryAvailable: false,
              firstKnownAt: null,
              isConsensus: false,
              upcomingEligible: true,
              details: expect.objectContaining({
                kind: "shareholder_meeting",
                meetingDate: "2026-09-30",
              }),
            }),
          ]),
        );
        expect(structured.sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              snapshotType: "forecast_achievement",
              status: "nonempty",
              freshness: "stale",
              pointInTimeHistoryAvailable: false,
              isConsensus: false,
            }),
            expect.objectContaining({
              snapshotType: "forecast_material_variance",
              status: "failed",
              freshness: "not_applicable",
            }),
            expect.objectContaining({
              snapshotType: "dividend_decision",
              market: "otc",
              sourceKey: "tpex_dividend_decision_current_unsupported",
              sourceUrl: null,
              status: "unsupported",
              freshness: "not_applicable",
            }),
          ]),
        );
        expect(structured.coverage.snapshots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              snapshotType: "forecast_achievement",
              status: "partial",
              disclosureStatus: "disclosed",
              freshness: "stale",
            }),
            expect.objectContaining({
              snapshotType: "forecast_material_variance",
              status: "failed",
              disclosureStatus: "unknown_source_failure",
            }),
            expect.objectContaining({
              snapshotType: "dividend_decision",
              status: "unsupported",
              disclosureStatus: "unsupported",
            }),
          ]),
        );
        expect(structured.companies[0]).toMatchObject({
          staleSnapshotTypes: ["forecast_achievement"],
          unsupportedSnapshotTypes: ["dividend_decision"],
          failedSnapshotTypes: ["forecast_material_variance"],
        });
      }
      if (name === "screen_taiwan_stock_candidates") {
        const structured = result.structuredContent as {
          meta: {
            asOf: {
              selector: string;
              resolved: { granularity: string; from: string | null; through: string | null };
            };
            quality: {
              source: string;
              universe: string;
              selection: string;
              values: string;
              freshness: string;
              issues: Array<{ code: string }>;
            };
            page: { mode: string; unit: string };
          };
          screenDefinition: {
            latestOnly: boolean;
            financialCompanies: string;
            scoreCompensationAcrossPillars: boolean;
            evidencePolicies: {
              requiredFinancialMetricRoles: string[];
              financialMetricCodes: string[];
              resolvedFinancialMetrics: Array<{
                role: string;
                metricCode: string;
                family: string;
              }>;
              catalogDiscoveredAt: string;
              catalogSnapshotId: string;
            };
          };
          workBudget: {
            deepCompanyLimit: number;
            reactionCompanyLimit: number;
          };
          candidates: unknown[];
        };
        expect(structured.meta.asOf).toMatchObject({
          selector: "latest",
          resolved: { granularity: "mixed", from: null, through: null },
        });
        expect(structured.meta.page).toEqual(
          expect.objectContaining({ mode: "none", unit: "none" }),
        );
        expect(structured.meta.quality).toMatchObject({
          source: "partial",
          universe: "unverified",
          selection: "complete",
          values: "partial",
          freshness: "unknown",
        });
        expect(structured.meta.quality.issues).toContainEqual(
          expect.objectContaining({ code: "MASTER_ROWSET_HEURISTIC" }),
        );
        expect(structured.screenDefinition).toMatchObject({
          latestOnly: true,
          financialCompanies: "excluded",
          scoreCompensationAcrossPillars: false,
          evidencePolicies: {
            requiredFinancialMetricRoles: [
              "roe",
              "net_profit",
              "operating_cashflow",
              "debt_ratio",
              "gross_margin",
              "operating_margin",
              "eps",
            ],
            financialMetricCodes: [
              "ROE",
              "NetProfit",
              "OperatingCashflow",
              "DebtRatio",
              "GrossMargin",
              "OperatingMargin",
              "EPS",
            ],
            resolvedFinancialMetrics: expect.arrayContaining([
              expect.objectContaining({
                role: "net_profit",
                metricCode: "NetProfit",
                family: "data",
              }),
            ]),
            catalogDiscoveredAt: "2026-08-24T00:00:00.000Z",
            catalogSnapshotId: expect.stringMatching(
              /^mopsfin-catalog-[a-f0-9]{64}$/,
            ),
          },
        });
        expect(structured.workBudget).toMatchObject({
          deepCompanyLimit: 10,
          reactionCompanyLimit: 5,
        });
        expect(structured.candidates.length).toBeLessThanOrEqual(1);
      }
      if (
        name ===
        "screen_taiwan_stock_candidates_with_catalyst_snapshots"
      ) {
        const structured = result.structuredContent as {
          meta: { quality: { issues: Array<{ code: string }> } };
          posture: string;
          screen: { candidates: Array<{ companyCode: string }> };
          catalystSnapshots: {
            stageStatus: string;
            queriedCompanyCodes: string[];
            workBudget: { snapshotCallCount: 0 | 1 };
          };
          compositionIntegrity: {
            screenResultPreserved: boolean;
            catalystEvidenceAffectsScreenRanking: boolean;
          };
        };
        expect(structured).toMatchObject({
          posture: "research_triage_evidence_only",
          compositionIntegrity: {
            screenResultPreserved: true,
            catalystEvidenceAffectsScreenRanking: false,
          },
        });
        expect(
          structured.meta.quality.issues.map((issue) => issue.code),
        ).toContain("CATALYST_EVIDENCE_DOES_NOT_AFFECT_SCREEN");
        expect(structured.screen.candidates.length).toBeLessThanOrEqual(1);
        expect(structured.catalystSnapshots.workBudget.snapshotCallCount).toBe(
          structured.screen.candidates.length === 0 ? 0 : 1,
        );
      }
      if (name === "get_monthly_revenue_trend") {
        const structured = result.structuredContent as {
          startMonth: string;
          endMonth: string;
          counts: {
            requestedCompanies: number;
            returnedCompanies: number;
            requestedMonths: number;
          };
          companies: Array<{
            code: string;
            points: Array<{ sourceIndustryName: string | null }>;
            derived: {
              latestYoyPercent: number | null;
              rolling3MonthYoyPercent: number | null;
              yoyAccelerationVs3MonthsAgoPp: number | null;
              valueStatus: { rolling3MonthYoyPercent: string };
            };
          }>;
        };
        expect(structured).toMatchObject({
          startMonth: "2026-02",
          endMonth: "2026-07",
          counts: {
            requestedCompanies: 1,
            returnedCompanies: 1,
            requestedMonths: 6,
          },
        });
        expect(structured.companies[0].points).toHaveLength(6);
        expect(structured.companies[0].points[0]).toMatchObject({
          sourceIndustryName: "半導體業",
        });
        expect(structured.companies[0].derived).toMatchObject({
          latestYoyPercent: 30,
          rolling3MonthYoyPercent: 20,
          yoyAccelerationVs3MonthsAgoPp: 6,
          valueStatus: { rolling3MonthYoyPercent: "reported" },
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
      if (name === "get_company_metrics_batch") {
        const structured = result.structuredContent as {
          meta: {
            page: { mode: string };
            quality: { source: string; selection: string; values: string };
          };
          metricDefinitions: Array<{ code: string }>;
          companies: Array<{
            companyCode: string;
            evaluationStatus: string;
            metrics: Array<{
              metricCode: string;
              availability: string;
              failure: unknown;
              points: Array<{ period: string; value: number | null }>;
            }>;
          }>;
          failures: unknown[];
          coverage: {
            selectionComplete: boolean;
            sourceComplete: boolean;
            failureIsolationComplete: boolean;
            unavailableCompanyCodes: string[];
          };
          workBudget: { comparisonUnitLimit: number };
        };
        expect(structured.meta.page.mode).toBe("cursor");
        expect(structured.meta.quality).toMatchObject({
          source: "complete",
          selection: "complete",
          values: "complete",
        });
        expect(structured.metricDefinitions).toEqual([
          expect.objectContaining({ code: "ROE" }),
        ]);
        expect(structured.companies[0]).toMatchObject({
          companyCode: "2330",
          evaluationStatus: "complete",
          metrics: [
            {
              metricCode: "ROE",
              availability: "available",
              failure: null,
              points: [{ period: "2026Q1", value: 20.5, valueStatus: "reported" }],
            },
          ],
        });
        expect(structured.failures).toEqual([]);
        expect(structured.coverage).toMatchObject({
          selectionComplete: true,
          sourceComplete: true,
          failureIsolationComplete: true,
          unavailableCompanyCodes: [],
        });
        expect(structured.workBudget.comparisonUnitLimit).toBe(24);
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
      if (name === "screen_taiwan_financial_candidates") {
        const structured = result.structuredContent as {
          screenDefinition: {
            id: string;
            preset: string;
            crossModelScoreComparable: boolean;
          };
          funnel: {
            excludedNonFinancial: number;
            returned: number;
          };
          excluded: Array<{ companyCode: string; reasonCodes: string[] }>;
        };
        expect(structured.screenDefinition).toMatchObject({
          id: "taiwan_financial_screen.v1",
          preset: "balanced_financial_v1",
          crossModelScoreComparable: false,
        });
        expect(structured.funnel).toMatchObject({
          excludedNonFinancial: 1,
          returned: 0,
        });
        expect(structured.excluded).toContainEqual(
          expect.objectContaining({
            companyCode: "2330",
            reasonCodes: ["non_financial_company_not_supported"],
          }),
        );
      }
      if (name === "screen_taiwan_market_candidates") {
        const structured = result.structuredContent as {
          screenDefinition: {
            id: string;
            crossModelScoreComparable: boolean;
            mergePolicy: {
              compareRawOverallScoreAcrossModels: boolean;
              refillUnusedQuotaAcrossSegments: boolean;
            };
          };
          composition: {
            requested: { nonFinancial: number; financial: number };
            returned: { nonFinancial: number; financial: number };
            unfilled: { financial: number };
          };
          segments: { nonFinancial: object; financial: object };
        };
        expect(structured.screenDefinition).toMatchObject({
          id: "taiwan_market_screen.v1",
          crossModelScoreComparable: false,
          mergePolicy: {
            compareRawOverallScoreAcrossModels: false,
            refillUnusedQuotaAcrossSegments: false,
          },
        });
        expect(structured.composition).toMatchObject({
          requested: { nonFinancial: 1, financial: 1 },
          returned: { financial: 0 },
          unfilled: { financial: 1 },
        });
        expect(structured.segments.nonFinancial).toBeDefined();
        expect(structured.segments.financial).toBeDefined();
      }
      if (name === "screen_taiwan_market_universe_page") {
        const structured = result.structuredContent as {
          meta: { page: { mode: string; unit: string; next: unknown } };
          executionDefinition: {
            snapshotScope: string;
            pageValuesPinned: boolean;
            pointInTime: boolean;
            globalRankAvailable: boolean;
          };
          manifest: { companyCount: number; snapshotId: string };
          page: { companyCodes: string[]; hasMore: boolean };
          coverage: { pageTerminalReconciliationComplete: boolean };
          terminalResults: Array<{ companyCode: string; rankScope: string }>;
        };
        expect(structured.meta.page).toMatchObject({
          mode: "cursor",
          unit: "company",
          next: null,
        });
        expect(structured.executionDefinition).toMatchObject({
          snapshotScope: "manifest_company_identity_only",
          pageValuesPinned: false,
          pointInTime: false,
          globalRankAvailable: false,
        });
        expect(structured.manifest).toMatchObject({
          companyCount: 2,
          snapshotId: expect.stringMatching(/^market-universe-/),
        });
        expect(structured.page).toMatchObject({
          companyCodes: ["2330", "3105"],
          hasMore: false,
        });
        expect(structured.coverage.pageTerminalReconciliationComplete).toBe(
          true,
        );
        expect(structured.terminalResults).toHaveLength(2);
        expect(
          structured.terminalResults.every(
            (terminal) => terminal.rankScope === "page_segment_only",
          ),
        ).toBe(true);
      }
    }

    const resolverCallsAfterLatestTools = completedSessionSpy.mock.calls.length;
    for (const [name, args] of [
      [
        "get_daily_market_ohlc",
        { market: "all", date: "2026-08-24" },
      ],
      [
        "get_daily_market_valuation",
        { market: "all", date: "2026-08-24" },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} explicit selector`).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        meta: {
          quality: {
            freshness: "not_applicable",
          },
        },
      });
    }
    expect(completedSessionSpy).toHaveBeenCalledTimes(
      resolverCallsAfterLatestTools,
    );

    valuationModelInputsSpy.mockResolvedValueOnce({
      data: financialValuationModelInputs,
      completedClose: null,
      completedCloseError: null,
    });
    const financialModelResult = await client.callTool({
      name: "get_valuation_model_inputs",
      arguments: { company_code: "2881" },
    });
    const financialModelStructured = financialModelResult.structuredContent as {
      applicability: { status: string };
      meta: { quality: { values: string; issues: Array<{ code: string }> } };
    };
    expect(financialModelStructured.applicability.status).toBe(
      "not_applicable",
    );
    expect(financialModelStructured.meta.quality.values).toBe(
      "not_applicable",
    );
    const financialIssueCodes = financialModelStructured.meta.quality.issues.map(
      (issue) => issue.code,
    );
    expect(financialIssueCodes).toEqual(
      expect.arrayContaining([
        "VALUATION_MODEL_NOT_APPLICABLE",
        "VALUATION_MODEL_EVIDENCE_CLASSES",
        "DATA_GAPS_NOT_ZERO_FILLED",
      ]),
    );
    expect(financialIssueCodes).not.toEqual(
      expect.arrayContaining([
        "FINANCIAL_STATEMENT_CURRENT_VIEW_NOT_POINT_IN_TIME",
        "ISSUED_SHARES_NOT_DILUTED",
        "HISTORICAL_FCFF_PROXY_NOT_FORECAST",
        "CAPEX_PPE_ACQUISITION_ONLY",
      ]),
    );

    expect(priceSeriesSpy).toHaveBeenCalledOnce();
    expect(priceSeriesSpy).toHaveBeenCalledWith({
      companyCode: "2330",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      priceBasis: "price_index_compatible_corporate_action_adjusted",
      includeEventLedger: true,
    });

    expect(catalystSnapshotSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(catalystSnapshotSpy).toHaveBeenCalledWith({
      companyCodes: ["3105"],
      snapshotTypes: [
        "forecast_achievement",
        "forecast_material_variance",
        "shareholder_meeting",
        "dividend_decision",
      ],
      companyMarkets: [{ companyCode: "3105", market: "otc" }],
      asOf: "latest",
      offset: 0,
      limit: 50,
    });

    const isolatedFailure = {
      failureId: "fixture-catalyst-failure",
      companyCode: "2330",
      eventType: "investor_conference" as const,
      market: "listed" as const,
      queryMonth: "2026-01",
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_DEADLINE_EXCEEDED",
      message: "fixture isolated conference failure",
      retryable: true,
      retryAfterMs: null,
      action: "retry" as const,
    };
    catalystSpy.mockResolvedValueOnce({
      ...catalystEvents,
      coverage: {
        ...catalystEvents.coverage,
        sourceComplete: false,
        families: catalystEvents.coverage.families.map((family) =>
          family.eventType === "investor_conference"
            ? {
                ...family,
                status: "partial" as const,
                failedCompanyCodes: ["2330"],
              }
            : family,
        ),
      },
      familyCoverage: catalystEvents.familyCoverage.map((family) =>
        family.eventType === "investor_conference"
          ? {
              ...family,
              status: "partial" as const,
              completedRequestCount: 0,
              verifiedEmptyRequestCount: 0,
              failures: [isolatedFailure],
            }
          : family,
      ),
      companies: [
        {
          companyCode: "2330",
          status: "partial" as const,
          eventCount: 1,
          failures: [isolatedFailure],
        },
      ],
      failures: [isolatedFailure],
      counts: {
        ...catalystEvents.counts,
        completeCompanies: 0,
        partialCompanies: 1,
      },
      fingerprint: "fixture-partial-catalyst-fingerprint",
    });
    const partialCatalystResult = await client.callTool({
      name: "get_company_catalyst_events",
      arguments: {
        company_codes: ["2330"],
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      },
    });
    expect(partialCatalystResult.isError).not.toBe(true);
    expect(partialCatalystResult.structuredContent).toMatchObject({
      meta: {
        quality: {
          status: "partial",
          source: "partial",
          selection: "partial",
          values: "partial",
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "CATALYST_COMPANY_FAMILY_FAILED",
              refs: expect.objectContaining({ companyCodes: ["2330"] }),
            }),
          ]),
        },
      },
      companies: [
        expect.objectContaining({ companyCode: "2330", status: "partial" }),
      ],
      failures: [
        expect.objectContaining({
          companyCode: "2330",
          eventType: "investor_conference",
          queryMonth: "2026-01",
        }),
      ],
    });

    companyMasterSpy.mockResolvedValueOnce({
      ...companyMaster,
      companies: [],
    });
    catalystSpy.mockResolvedValueOnce({
      ...catalystEvents,
      query: {
        ...catalystEvents.query,
        companyCodes: ["9999"],
      },
      events: [],
      sources: catalystEvents.sources.map((item) => ({
        ...item,
        rawRowCount: 0,
        acceptedEventCount: 0,
      })),
      familyCoverage: catalystEvents.familyCoverage.map((family) => ({
        ...family,
        companyCode: "9999",
        verifiedEmptyRequestCount: 1,
        nonemptyRequestCount: 0,
        eventCount: 0,
      })),
      companies: [
        {
          companyCode: "9999",
          status: "complete" as const,
          eventCount: 0,
          failures: [],
        },
      ],
      counts: {
        ...catalystEvents.counts,
        totalEvents: 0,
        returnedEvents: 0,
      },
      pagination: {
        ...catalystEvents.pagination,
        totalRows: 0,
        returnedRows: 0,
      },
      fingerprint: "fixture-unverified-identity-catalyst-fingerprint",
    });
    const unverifiedIdentityResult = await client.callTool({
      name: "get_company_catalyst_events",
      arguments: {
        company_codes: ["9999"],
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      },
    });
    expect(unverifiedIdentityResult.isError).not.toBe(true);
    expect(unverifiedIdentityResult.structuredContent).toMatchObject({
      meta: {
        quality: {
          status: "partial",
          source: "complete",
          selection: "partial",
          values: "complete",
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "CATALYST_MARKET_HINT_PARTIAL",
            }),
            expect.objectContaining({
              code: "CATALYST_COMPANY_IDENTITY_UNVERIFIED",
              refs: expect.objectContaining({ companyCodes: ["9999"] }),
            }),
          ]),
        },
      },
      companies: [
        expect.objectContaining({
          companyCode: "9999",
          status: "complete",
          eventCount: 0,
        }),
      ],
    });

    reactionSpy.mockResolvedValueOnce(stockUnavailableReactionSignals());
    const unavailableReactionPage = await client.callTool({
      name: "get_stock_reaction_signals",
      arguments: { company_codes: ["2330"], horizons: [5] },
    });
    expect(unavailableReactionPage.isError).not.toBe(true);
    const unavailableReactionData = unavailableReactionPage.structuredContent as {
      meta: {
        quality: {
          status: string;
          source: string;
          values: string;
          issues: Array<{
            code: string;
            refs: { companyCodes: string[]; fields: string[] };
          }>;
        };
      };
      companies: Array<{
        companyCode: string;
        stockDataStatus: string;
        stockDataFailure: { code: string; retryable: boolean } | null;
        returns: Array<{
          status: string;
          excessReturnStatus: string;
          stockReturnPercent: number | null;
        }>;
      }>;
    };
    expect(unavailableReactionData.meta.quality).toMatchObject({
      status: "partial",
      source: "partial",
      values: "partial",
    });
    expect(unavailableReactionData.meta.quality.issues).toContainEqual(
      expect.objectContaining({
        code: "STOCK_DATA_UPSTREAM_UNAVAILABLE",
        refs: expect.objectContaining({
          companyCodes: ["2330"],
          fields: ["stockDataStatus", "stockDataFailure"],
        }),
      }),
    );
    expect(unavailableReactionData.companies[0]).toMatchObject({
      companyCode: "2330",
      stockDataStatus: "unavailable",
      stockDataFailure: { code: "UPSTREAM_TIMEOUT", retryable: true },
      returns: [
        {
          status: "stock_data_unavailable",
          excessReturnStatus: "stock_data_unavailable",
          stockReturnPercent: null,
        },
      ],
    });

    reactionSpy.mockResolvedValueOnce(unavailableCorporateActionReactionSignals());
    const incompleteActionPage = await client.callTool({
      name: "get_stock_reaction_signals",
      arguments: { company_codes: ["2330"], horizons: [5] },
    });
    expect(incompleteActionPage.isError).not.toBe(true);
    const incompleteActionData = incompleteActionPage.structuredContent as {
      meta: {
        quality: {
          source: string;
          values: string;
          issues: Array<{
            code: string;
            refs: { companyCodes: string[]; fields: string[] };
          }>;
        };
      };
      coverage: { corporateActionHistoryComplete: boolean };
    };
    expect(incompleteActionData.coverage.corporateActionHistoryComplete).toBe(false);
    expect(incompleteActionData.meta.quality).toMatchObject({
      source: "partial",
      values: "partial",
    });
    expect(incompleteActionData.meta.quality.issues).toContainEqual(
      expect.objectContaining({
        code: "CORPORATE_ACTION_HISTORY_INCOMPLETE",
        refs: expect.objectContaining({
          companyCodes: ["2330"],
          fields: expect.arrayContaining([
            "coverage.corporateActionHistoryComplete",
            "comparability.corporateActions.adjustmentStatus",
          ]),
        }),
      }),
    );

    companyMetricsBatchSpy.mockResolvedValueOnce(partialCompanyMetricsBatch);
    const partialBatchPage = await client.callTool({
      name: "get_company_metrics_batch",
      arguments: {
        company_codes: ["2330", "9999", "3105"],
        metric_codes: ["ROE", "MARGIN"],
        page_size: 2,
      },
    });
    expect(partialBatchPage.isError).not.toBe(true);
    const partialBatchData = partialBatchPage.structuredContent as {
      meta: {
        quality: {
          status: string;
          source: string;
          selection: string;
          values: string;
          issues: Array<{ code: string }>;
        };
        page: {
          mode: string;
          returned: number | null;
          total: number | null;
          next: { kind: string; cursor: string } | null;
        };
      };
      failures: Array<{
        companyCode: string;
        stage: string;
        metricCode: string | null;
        attribution: string;
      }>;
      companies: Array<{
        companyCode: string;
        evaluationStatus: string;
        metrics: Array<{
          metricCode: string;
          availability: string;
          failure: { code: string } | null;
        }>;
      }>;
      coverage: {
        selectionComplete: boolean;
        sourceComplete: boolean;
        failureIsolationComplete: boolean;
        identityFailedCompanyCodes: string[];
        unavailableCompanyCodes: string[];
      };
      workBudget: {
        comparisonPlanUnits: number;
        comparisonExecutedUnits: number;
        isolationRetryUnits: number;
        comparisonUnitLimit: number;
      };
    };
    expect(partialBatchData.meta.quality).toMatchObject({
      status: "partial",
      source: "partial",
      selection: "partial",
      values: "partial",
    });
    expect(partialBatchData.meta.quality.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "STATELESS_PAGE_VALUES_NOT_PINNED",
        "BATCH_COMPANY_IDENTITY_FAILED",
        "BATCH_COMPANY_METRIC_FAILED",
        "BATCH_FAILURE_ISOLATION_INCOMPLETE",
      ]),
    );
    expect(partialBatchData.meta.page).toMatchObject({
      mode: "cursor",
      returned: 2,
      total: 3,
      next: { kind: "cursor", cursor: expect.any(String) },
    });
    expect(partialBatchData.failures).toEqual([
      expect.objectContaining({
        companyCode: "9999",
        stage: "identity",
        metricCode: null,
        attribution: "company",
      }),
      expect.objectContaining({
        companyCode: "2330",
        stage: "metric",
        metricCode: "MARGIN",
        attribution: "chunk",
      }),
    ]);
    expect(partialBatchData.companies[0]).toMatchObject({
      companyCode: "2330",
      evaluationStatus: "partial",
      metrics: [
        expect.objectContaining({ availability: "available", failure: null }),
        expect.objectContaining({
          metricCode: "MARGIN",
          availability: "unavailable",
          failure: expect.objectContaining({ code: "UPSTREAM_TIMEOUT" }),
        }),
      ],
    });
    expect(partialBatchData.coverage).toMatchObject({
      selectionComplete: false,
      sourceComplete: false,
      failureIsolationComplete: false,
      identityFailedCompanyCodes: ["9999"],
      unavailableCompanyCodes: ["9999", "2330"],
    });
    expect(partialBatchData.workBudget).toEqual({
      comparisonPlanUnits: 2,
      comparisonExecutedUnits: 2,
      isolationRetryUnits: 0,
      comparisonUnitLimit: 24,
      identityLookupUpperBound: 2,
      unitDefinition: "one_metric_by_up_to_ten_companies_request",
    });

    const firstCompanyPage = await client.callTool({
      name: "list_companies",
      arguments: { market: "all", page_size: 1 },
    });
    const firstCompanyPageData = firstCompanyPage.structuredContent as {
      meta: {
        asOf: { snapshotId: string | null };
        page: { next: { kind: "cursor"; cursor: string } | null };
      };
      companies: Array<{ code: string }>;
    };
    expect(firstCompanyPageData.companies.map((company) => company.code)).toEqual([
      "2330",
    ]);
    const companyCursor = firstCompanyPageData.meta.page.next?.cursor as string;
    const secondCompanyPage = await client.callTool({
      name: "list_companies",
      arguments: { market: "all", cursor: companyCursor },
    });
    const secondCompanyPageData = secondCompanyPage.structuredContent as {
      meta: { asOf: { snapshotId: string | null }; page: { next: null } };
      companies: Array<{ code: string }>;
    };
    expect(secondCompanyPageData.companies.map((company) => company.code)).toEqual([
      "3105",
    ]);
    expect(secondCompanyPageData.meta.asOf.snapshotId).toBe(
      firstCompanyPageData.meta.asOf.snapshotId,
    );
    expect(secondCompanyPageData.meta.page.next).toBeNull();

    const queryMismatch = await client.callTool({
      name: "list_companies",
      arguments: { market: "listed", cursor: companyCursor },
    });
    expect(queryMismatch.structuredContent).toMatchObject({
      ok: false,
      error: {
        reason: "CURSOR_INVALID",
        category: "pagination",
        action: "restart_pagination",
      },
    });

    companyMasterSpy.mockResolvedValueOnce({
      ...companyMaster,
      snapshotId: "changed-master-snapshot",
    });
    const changedSnapshot = await client.callTool({
      name: "list_companies",
      arguments: { market: "all", cursor: companyCursor },
    });
    expect(changedSnapshot.structuredContent).toMatchObject({
      ok: false,
      error: {
        reason: "SNAPSHOT_CHANGED",
        category: "pagination",
        action: "restart_pagination",
      },
    });

    companyMetricSpy.mockRejectedValueOnce(
      new MopsfinError("NO_DATA", "fixture no data", {
        details: { companyCodes: ["2330"] },
      }),
    );
    const errorResult = await client.callTool({
      name: "get_company_metric",
      arguments: { metric_code: "ROE", company_codes: ["2330"] },
    });
    expect(errorResult.isError).toBe(true);
    expect(errorResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("NO_DATA"),
    });
    expect(errorResult.structuredContent).toMatchObject({
      ok: false,
      meta: {
        contractVersion: "mopsfin.result.v1",
        asOf: null,
        quality: null,
        page: null,
      },
      error: {
        code: "NO_DATA",
        reason: null,
        category: "no_data",
        message: "fixture no data",
        retryable: false,
        retryAfterMs: null,
        action: "change_query",
        details: { companyCodes: ["2330"] },
      },
    });

    await client.close();
    await server.close();
  });
});
