import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import type {
  CurrentCompanyPriceIdentity,
  ExactCurrentCompanyOhlcResult,
  OhlcBar,
} from "@/lib/price/types";

import { completedSessionEvidenceFixture } from "./completed-session";

export const COMPLETED_CLOSE_COMPANY = {
  code: "2330",
  shortName: "台積電",
  market: "listed",
  exchange: "TWSE",
} as const satisfies CurrentCompanyPriceIdentity;

export function completedCloseBar(
  options: Partial<OhlcBar> = {},
): OhlcBar {
  return {
    date: "2026-08-28",
    open: 2_410,
    high: 2_430,
    low: 2_400,
    close: 2_420,
    volumeShares: 10_000_000,
    turnoverTwd: 24_200_000_000,
    tradeCount: 20_000,
    change: 10,
    changeMarker: null,
    market: "listed",
    status: "traded",
    qualityStatus: "complete",
    missingFields: [],
    ...options,
  };
}

export function exactCurrentCompanyOhlcFixture(options: {
  date?: string;
  observedName?: string | null;
  bars?: OhlcBar[];
  cacheRefreshAttempted?: boolean;
} = {}): ExactCurrentCompanyOhlcResult {
  const date = options.date ?? "2026-08-28";
  const bars = options.bars ?? [completedCloseBar({ date })];
  const selectedBarDate = bars.length === 1 ? bars[0]?.date ?? null : null;
  return {
    query: {
      companyCode: COMPLETED_CLOSE_COMPANY.code,
      market: COMPLETED_CLOSE_COMPANY.market,
      date,
    },
    companyCode: COMPLETED_CLOSE_COMPANY.code,
    market: COMPLETED_CLOSE_COMPANY.market,
    observedName: options.observedName === undefined
      ? COMPLETED_CLOSE_COMPANY.shortName
      : options.observedName,
    dataMonth: date.slice(0, 7),
    selectedBarDate,
    coverageComplete: true,
    bars,
    source: {
      market: COMPLETED_CLOSE_COMPANY.market,
      sourceName: "臺灣證券交易所－個股日成交資訊",
      sourceUrl:
        `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${date.slice(0, 7).replace("-", "")}01&stockNo=2330&response=json`,
      retrievedAt: options.cacheRefreshAttempted
        ? "2026-08-28T07:00:00.000Z"
        : "2026-08-28T06:58:59.000Z",
      cache: {
        status: options.cacheRefreshAttempted ? "miss" : "hit",
        observedAt: "2026-08-28T07:00:00.000Z",
        storedAt: options.cacheRefreshAttempted
          ? "2026-08-28T07:00:00.000Z"
          : "2026-08-28T06:59:00.000Z",
        ageMs: options.cacheRefreshAttempted ? 0 : 60_000,
        ttlMs: 300_000,
      },
      snapshotIdentity: "verified",
      dataMonth: date.slice(0, 7),
      normalization: {
        volumeShares: {
          sourceUnit: "share",
          outputUnit: "share",
          multiplier: 1,
        },
        turnoverTwd: {
          sourceUnit: "TWD",
          outputUnit: "TWD",
          multiplier: 1,
        },
        tradeCount: {
          sourceUnit: "trade",
          outputUnit: "trade",
          multiplier: 1,
        },
      },
    },
    cacheRefresh: {
      attempted: options.cacheRefreshAttempted ?? false,
      initialCacheStatus: options.cacheRefreshAttempted ? "hit" : "miss",
    },
  };
}

export function completedCloseResolverEvidenceFixture(options: {
  evaluatedAt?: string;
  expectedAsOf?: string;
  status?: "resolved" | "unresolved";
} = {}): CompletedSessionResolverEvidence {
  const evidence = completedSessionEvidenceFixture({
    market: COMPLETED_CLOSE_COMPANY.market,
    status: options.status,
    expectedAsOf: options.expectedAsOf ?? "2026-08-28",
  });
  const evaluatedAt =
    options.evaluatedAt ?? "2026-08-28T07:00:00.000Z";
  evidence.evaluatedAt = evaluatedAt;
  for (const source of evidence.marketResolutions.flatMap(
    (resolution) => resolution.sources,
  )) {
    const storedAt = new Date(Date.parse(evaluatedAt) - 60_000).toISOString();
    source.retrievedAt = storedAt;
    source.cache.storedAt = storedAt;
    source.cache.observedAt = evaluatedAt;
    source.cache.ageMs = 60_000;
  }
  return evidence;
}
