import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { CompanyMasterClient } from "@/lib/company-master/client";
import type { CompanyMarket } from "@/lib/company-master/types";
import type { DailyMarketOhlcResult } from "@/lib/price/types";
import type { DailyMarketValuationResult } from "@/lib/valuation/types";
import type { MonthlyRevenueResult } from "@/lib/revenue/types";
import type { ResearchMarketDependencies } from "@/lib/research/market-data";
import type { Catalog } from "@/lib/mopsfin/types";
import { completedSessionEvidenceFixture } from "./completed-session";

export const researchNow = () => new Date("2026-08-28T07:00:00Z");
const identities = [
  { code: "2330", name: "台積電", market: "listed" as const },
  { code: "6488", name: "環球晶", market: "otc" as const },
  { code: "2881", name: "富邦金", market: "listed" as const },
];
function source(market: CompanyMarket) {
  return { market, exchange: market === "listed" ? "TWSE" as const : "TPEx" as const, sourceName: "official fixture", sourceUrl: market === "listed" ? "https://www.twse.com.tw/fixture" : "https://www.tpex.org.tw/fixture", retrievedAt: "2026-08-28T07:00:00Z", rawCount: 3, eligibleRowCount: 3 };
}

export function researchMarketFixture() {
  const companyMaster = new CompanyMasterClient(async (url) => {
    const file = String(url).includes("twse.com.tw") ? "twse-companies.json" : "tpex-companies.json";
    return new Response(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), { headers: { "content-type": "application/json" } });
  }, researchNow, { minimumCompanyCounts: { listed: 1, otc: 1 } });
  const price: DailyMarketOhlcResult = {
    query: { market: "all", date: "2026-08-28", universePolicy: "compatible" }, dataDate: "2026-08-28", currency: "TWD", timezone: "Asia/Taipei", interval: "1d", priceBasis: "raw_unadjusted",
    classificationMethod: "historical_code_rule", classificationPolicy: "historical_code_rule", coverageComplete: true, universeCoverageVerified: false, dataQualityComplete: true, reconciliation: [], selectionComplete: true, missingCompanyCodes: [], counts: { listed: 2, otc: 1, returned: 3 }, warnings: [],
    bars: identities.map((identity, index) => ({ ...identity, date: "2026-08-28", open: 100, high: 110, low: 90, close: 100 + index, volumeShares: 1000, turnoverTwd: 200_000_000, tradeCount: 100, change: 1, changeMarker: null, status: "traded", qualityStatus: "complete", missingFields: [] })),
    sources: (["listed", "otc"] as const).map((market) => ({ market, sourceName: source(market).sourceName, sourceUrl: source(market).sourceUrl, retrievedAt: source(market).retrievedAt, dataDate: "2026-08-28", snapshotIdentity: "verified", normalization: { volumeShares: { sourceUnit: "share", outputUnit: "share", multiplier: 1 }, turnoverTwd: { sourceUnit: "TWD", outputUnit: "TWD", multiplier: 1 }, tradeCount: { sourceUnit: "trade", outputUnit: "trade", multiplier: 1 } } })),
  };
  const valuation: DailyMarketValuationResult = {
    query: { market: "all", date: "2026-08-28", universePolicy: "compatible" }, dataDate: "2026-08-28", currency: "TWD", classificationPolicy: "historical_code_rule", coverageComplete: true, universeCoverageVerified: false, selectionComplete: true, missingCompanyCodes: [], reconciliation: [], warnings: [],
    counts: { raw: 3, returned: 3, withPe: 3, withPb: 3, withDividendYield: 3, withClosePrice: 0, withDividendPerShare: 0, withDividendFiscalYear: 0, withReferenceFiscalPeriod: 0 },
    rows: identities.map((identity) => ({ ...identity, peRatio: 20, priceToBookRatio: 2, dividendYieldPercent: 3, closePriceTwd: null, dividendPerShareTwd: null, dividendFiscalYear: null, referenceFiscalPeriod: null,
      valueStatus: { peRatio: "reported", priceToBookRatio: "reported", dividendYieldPercent: "reported", closePriceTwd: "not_provided_by_source", dividendPerShareTwd: "not_provided_by_source", dividendFiscalYear: "not_provided_by_source", referenceFiscalPeriod: "not_provided_by_source" },
      rawValue: { peRatio: "20", priceToBookRatio: "2", dividendYieldPercent: "3", closePriceTwd: null, dividendPerShareTwd: null, dividendFiscalYear: null, referenceFiscalPeriod: null },
    })),
    sources: (["listed", "otc"] as const).map((market) => ({ ...source(market), dataDate: "2026-08-28" })),
  };
  const revenue: MonthlyRevenueResult = {
    query: { market: "all", dataMonth: "latest", universePolicy: "compatible" }, dataMonth: "2026-07", currency: "TWD", amountUnit: "TWD", coverageComplete: true, sourceCoverage: { status: "unverified", method: "structure_only_no_official_declared_count", complete: false }, selectionComplete: true, missingCompanyCodes: [], filingCoverage: { expectedCompanyCount: 3, reportedCompanyCount: 3, missingCompanyCodes: [], coverageRatio: 1, complete: true, status: "complete" }, reconciliation: [], counts: { listed: 2, otc: 1, returned: 3 }, warnings: [],
    rows: identities.map((identity, index) => ({ ...identity, industryCode: "24", sourceIndustryName: "fixture", sourceReportDate: "2026-08-28", currentMonthRevenueTwd: 1_000_000, previousMonthRevenueTwd: 900_000, sameMonthLastYearRevenueTwd: 800_000, momPercent: 10, yoyPercent: 25 + index, currentYearCumulativeRevenueTwd: 6_000_000, previousYearCumulativeRevenueTwd: 5_000_000, cumulativeYoyPercent: 20, note: null,
      valueStatus: { currentMonthRevenueTwd: "reported", previousMonthRevenueTwd: "reported", sameMonthLastYearRevenueTwd: "reported", momPercent: "reported", yoyPercent: "reported", currentYearCumulativeRevenueTwd: "reported", previousYearCumulativeRevenueTwd: "reported", cumulativeYoyPercent: "reported" },
    })),
    sources: (["listed", "otc"] as const).map((market) => ({ ...source(market), dataMonth: "2026-07", sourceReportDate: "2026-08-28", sourceAmountUnit: "thousand_TWD", outputAmountUnit: "TWD", amountMultiplier: 1000, integrity: { format: "json_array", structure: "verified", snapshotIdentity: "verified", eligibleCompanyCodesUnique: "verified", officialDeclaredRowCount: null, rowsetCompleteness: "unverified_no_official_declared_count" } })),
  };
  const catalog: Catalog = { metrics: [], industries: [{ code: "24", name: "半導體" }, { code: "17", name: "金融保險" }], financialInstitutions: [], years: [2026], quarters: [1, 2, 3, 4], discoveredAt: "2026-08-28T00:00:00Z" };
  const dependencies = {
    master: { listCompanies: vi.fn(companyMaster.listCompanies.bind(companyMaster)) },
    resolver: { resolve: vi.fn(async ({ market }: { market: "all" | CompanyMarket }) => completedSessionEvidenceFixture({ market, expectedAsOf: "2026-08-28" })) },
    price: { getDailyMarketOhlc: vi.fn(async () => price) },
    valuation: { getDailyMarketValuation: vi.fn(async () => valuation) },
    revenue: { getMonthlyRevenue: vi.fn(async () => revenue) },
  } satisfies ResearchMarketDependencies;
  return { dependencies, price, valuation, revenue, catalog: { getCatalog: vi.fn(async () => catalog) }, catalogData: catalog };
}
