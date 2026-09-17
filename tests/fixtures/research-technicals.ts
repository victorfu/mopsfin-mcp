import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { CompanyMasterClient } from "@/lib/company-master/client";
import { StockPriceSeriesClient } from "@/lib/price-series/client";
import type { OhlcBar, StockOhlcQuery, StockOhlcResult } from "@/lib/price/types";
import { StockTechnicalsClient } from "@/lib/technicals/client";
import { completedSessionEvidenceFixture } from "./completed-session";

export const technicalNow = () => new Date("2026-08-28T07:00:00.000Z");


export function technicalFixture(options: { missingLast?: boolean; missingSession?: boolean; resolverFailed?: boolean; sparseBenchmark?: boolean; marketTransition?: boolean } = {}) {
  const master = new CompanyMasterClient(async (url) => {
    const name = String(url).includes("openapi.twse.com.tw") ? "twse-companies.json" : "tpex-companies.json";
    return new Response(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"), { headers: { "content-type": "application/json" } });
  }, technicalNow, { minimumCompanyCounts: { listed: 1, otc: 1 }, retryDelayMs: 0 });
  const resolver = { resolve: vi.fn(async () => completedSessionEvidenceFixture({ expectedAsOf: "2026-08-28", status: options.resolverFailed ? "unresolved" : "resolved" })) };
  const benchmark = { getHistory: vi.fn(async (market: "listed" | "otc", months: string[]) => ({
    market, benchmarkCode: "TAIEX" as const, benchmarkName: "發行量加權股價指數" as const, priceBasis: "price_index" as const, sources: [],
    bars: (options.sparseBenchmark ? [28] : [24, 25, 26, 27, 28]).filter((day) => !options.missingSession || day !== 28).map((day) => ({ date: `${months[0]}-${day}`, close: 100 })),
  })) };
  const rawPrice = { getStockOhlc: vi.fn(async (request: StockOhlcQuery): Promise<StockOhlcResult> => {
    const bars = [24, 25, 26, 27, 28].filter((day) => !options.missingLast || day !== 28).map((day): OhlcBar => ({ date: `2026-08-${day}`, open: day, high: day, low: day, close: day, volumeShares: 100, turnoverTwd: day * 100, tradeCount: 1, change: 1, changeMarker: null, market: options.marketTransition && day === 24 ? "otc" : "listed", status: "traded", qualityStatus: "complete", missingFields: [] })).filter((bar) => bar.date >= request.startDate && bar.date <= request.endDate);
    return {
      query: request, companyCode: request.companyCode, observedNames: ["台積電"], currency: "TWD", timezone: "Asia/Taipei", interval: "1d", priceBasis: "raw_unadjusted", dataQualityComplete: true, bars,
      coverage: { requestedStart: request.startDate, requestedEnd: request.endDate, coveredThrough: request.endDate, coverageComplete: true, nextCursor: null }, sources: [], warnings: [],
    };
  }) };
  const prices = new StockPriceSeriesClient(technicalNow, master, rawPrice);
  const priceCall = vi.spyOn(prices, "getStockPriceSeries");
  const client = new StockTechnicalsClient({ master, resolver, benchmark, prices, now: technicalNow });
  return { client, master, resolver, benchmark, rawPrice, prices, priceCall };
}

