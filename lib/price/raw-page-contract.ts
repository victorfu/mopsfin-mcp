import { MopsfinError } from "@/lib/mopsfin/errors";

import type {
  OhlcBar,
  StockOhlcQuery,
  StockOhlcResult,
} from "./types";

function fail(message: string, details?: Record<string, unknown>): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, { details });
}

function sameBar(left: OhlcBar, right: OhlcBar): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validates one raw OHLC cursor page and appends only previously unseen bars.
 * Consumers share this seam so pagination cannot silently drift between tools.
 */
export function validateAndAppendRawOhlcPage(
  result: StockOhlcResult,
  expectedQuery: StockOhlcQuery,
  requestedCursor: string | undefined,
  previousCoveredThrough: string | null,
  barsByDate: Map<string, OhlcBar>,
): void {
  if (
    result.companyCode !== expectedQuery.companyCode ||
    result.query.companyCode !== expectedQuery.companyCode ||
    result.query.startDate !== expectedQuery.startDate ||
    result.query.endDate !== expectedQuery.endDate ||
    (result.query.cursor ?? null) !== (requestedCursor ?? null) ||
    result.priceBasis !== "raw_unadjusted" ||
    result.coverage.requestedStart !== expectedQuery.startDate ||
    result.coverage.requestedEnd !== expectedQuery.endDate
  ) {
    fail("個股 OHLC dependency 回傳 query scope 不一致。", {
      requestedCompanyCode: expectedQuery.companyCode,
      returnedCompanyCode: result.companyCode,
      requestedCursor: requestedCursor ?? null,
      returnedCursor: result.query.cursor ?? null,
    });
  }

  if (
    result.coverage.coveredThrough < expectedQuery.startDate ||
    result.coverage.coveredThrough > expectedQuery.endDate ||
    (previousCoveredThrough !== null &&
      result.coverage.coveredThrough <= previousCoveredThrough)
  ) {
    fail("個股 OHLC cursor coverage 未嚴格向前推進。", {
      previousCoveredThrough,
      coveredThrough: result.coverage.coveredThrough,
    });
  }

  if (
    (result.coverage.coverageComplete &&
      (result.coverage.coveredThrough !== expectedQuery.endDate ||
        result.coverage.nextCursor !== null)) ||
    (!result.coverage.coverageComplete && !result.coverage.nextCursor)
  ) {
    fail("個股 OHLC coverage／cursor 宣告矛盾。", {
      coverage: result.coverage,
    });
  }

  for (const bar of result.bars) {
    if (bar.date < expectedQuery.startDate || bar.date > expectedQuery.endDate) {
      fail("個股 OHLC dependency 回傳 requested range 外 bar。", {
        companyCode: expectedQuery.companyCode,
        date: bar.date,
      });
    }
    const existing = barsByDate.get(bar.date);
    if (existing) {
      fail(
        sameBar(existing, bar)
          ? "個股 OHLC cursor pages 出現重複日期。"
          : "個股 OHLC cursor pages 出現衝突日期。",
        { companyCode: expectedQuery.companyCode, date: bar.date },
      );
    }
    barsByDate.set(bar.date, bar);
  }
}
