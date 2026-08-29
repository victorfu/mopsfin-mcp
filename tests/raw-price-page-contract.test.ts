import { describe, expect, it } from "vitest";

import { validateAndAppendRawOhlcPage } from "@/lib/price/raw-page-contract";
import type {
  OhlcBar,
  StockOhlcQuery,
  StockOhlcResult,
} from "@/lib/price/types";

const query: StockOhlcQuery = {
  companyCode: "2330",
  startDate: "2026-08-24",
  endDate: "2026-08-26",
};

const bar: OhlcBar = {
  date: "2026-08-24",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volumeShares: 1_000,
  turnoverTwd: 100_000,
  tradeCount: 10,
  change: 1,
  changeMarker: null,
  market: "listed",
  status: "traded",
  qualityStatus: "complete",
  missingFields: [],
};

function page(
  overrides: Partial<StockOhlcResult> = {},
): StockOhlcResult {
  return {
    query,
    companyCode: query.companyCode,
    observedNames: ["台積電"],
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    dataQualityComplete: true,
    bars: [structuredClone(bar)],
    coverage: {
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      coveredThrough: query.endDate,
      coverageComplete: true,
      nextCursor: null,
    },
    sources: [],
    warnings: [],
    ...overrides,
  };
}

describe("raw OHLC cursor page contract", () => {
  it("rejects a returned cursor outside the requested query scope", () => {
    expect(() =>
      validateAndAppendRawOhlcPage(
        page({ query: { ...query, cursor: "wrong" } }),
        query,
        undefined,
        null,
        new Map(),
      ),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }));
  });

  it("requires coveredThrough to advance strictly across pages", () => {
    expect(() =>
      validateAndAppendRawOhlcPage(
        page({
          query: { ...query, cursor: "cursor-2" },
          bars: [],
          coverage: {
            requestedStart: query.startDate,
            requestedEnd: query.endDate,
            coveredThrough: "2026-08-24",
            coverageComplete: false,
            nextCursor: "cursor-3",
          },
        }),
        { ...query, cursor: "cursor-2" },
        "cursor-2",
        "2026-08-24",
        new Map(),
      ),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }));
  });

  it("rejects a complete page that still advertises a next cursor", () => {
    expect(() =>
      validateAndAppendRawOhlcPage(
        page({
          coverage: {
            requestedStart: query.startDate,
            requestedEnd: query.endDate,
            coveredThrough: query.endDate,
            coverageComplete: true,
            nextCursor: "unexpected",
          },
        }),
        query,
        undefined,
        null,
        new Map(),
      ),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }));
  });

  it("rejects identical dates across pages instead of silently overwriting", () => {
    const barsByDate = new Map([[bar.date, structuredClone(bar)]]);
    expect(() =>
      validateAndAppendRawOhlcPage(
        page(),
        query,
        undefined,
        null,
        barsByDate,
      ),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }));
  });
});
