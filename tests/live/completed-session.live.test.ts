import { describe, expect, it } from "vitest";

import { AuthoritativeCompletedCloseClient } from "@/lib/completed-close/client";
import {
  COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
  COMPLETED_SESSION_RESOLVER_ID,
  CompletedSessionResolver,
} from "@/lib/freshness/completed-session-resolver";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

const expectedSourcePaths = new Map([
  ["listed:calendar", "/holidaySchedule/holidaySchedule"],
  ["listed:session_marker", "/indicesReport/MI_5MINS_HIST"],
  ["otc:calendar", "/www/zh-tw/bulletin/tradingDate"],
  ["otc:session_marker", "/www/zh-tw/afterTrading/tradingIndex"],
]);

liveDescribe("live authoritative completed-session contract", () => {
  it("resolves both equity markets with one calendar and one exact benchmark load each", async () => {
    const resolution = await new CompletedSessionResolver().resolve({
      market: "all",
    });

    expect(
      resolution.status,
      JSON.stringify(
        {
          reasonCode: resolution.reasonCode,
          reason: resolution.reason,
          marketResolutions: resolution.marketResolutions,
        },
        null,
        2,
      ),
    ).toBe("resolved");
    expect(resolution).toMatchObject({
      resolverId: COMPLETED_SESSION_RESOLVER_ID,
      timezone: "Asia/Taipei",
      completionGuardTaipei: COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
      markets: ["listed", "otc"],
      reasonCode: "COMPLETED_SESSION_RESOLVED",
      workBudget: {
        scope: "freshness_meta_layer",
        marketCount: 2,
        calendarLogicalLoads: 2,
        sessionMarkerLogicalLoads: 2,
        actualTotal: 4,
        maximumTotal: 4,
      },
    });
    expect(resolution.expectedAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(resolution.marketResolutions).toHaveLength(2);
    expect(
      resolution.marketResolutions.map((market) => market.market),
    ).toEqual(["listed", "otc"]);
    expect(
      resolution.marketResolutions.every(
        (market) =>
          market.status === "resolved" &&
          market.expectedAsOf === resolution.expectedAsOf &&
          market.workBudget.calendarLogicalLoads === 1 &&
          market.workBudget.sessionMarkerLogicalLoads === 1 &&
          market.workBudget.actualTotal === 2 &&
          market.workBudget.maximumTotal === 2,
      ),
    ).toBe(true);

    const sources = resolution.marketResolutions.flatMap(
      (market) => market.sources,
    );
    const logicalLoads = sources.map(
      (source) => `${source.market}:${source.role}`,
    );

    // market=all is intentionally bounded to four logical official loads:
    // one annual calendar plus one exact monthly benchmark marker per market.
    expect(sources).toHaveLength(4);
    expect(new Set(logicalLoads)).toEqual(
      new Set([
        "listed:calendar",
        "listed:session_marker",
        "otc:calendar",
        "otc:session_marker",
      ]),
    );

    for (const source of sources) {
      const key = `${source.market}:${source.role}`;
      const sourceUrl = new URL(source.sourceUrl);
      expect(sourceUrl.pathname).toBe(expectedSourcePaths.get(key));
      expect(sourceUrl.protocol).toBe("https:");
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(source.cache.status).toMatch(
        /^(?:hit|miss|shared|bypass|unknown)$/,
      );
    }
  }, 90_000);

  it("routes the resolved listed session to the exact 2330 single-stock close", async () => {
    const result = await new AuthoritativeCompletedCloseClient()
      .getLatestCompletedClose({
        company: {
          code: "2330",
          shortName: "台積電",
          market: "listed",
          exchange: "TWSE",
        },
        evaluatedAt: new Date(),
      });

    expect(result.expectedAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.selectedBarDate).toBe(result.expectedAsOf);
    expect(result.bar.date).toBe(result.expectedAsOf);
    expect(result.close).toBe(result.bar.close);
    expect(result.close).toBeGreaterThan(0);
    expect(result.source).toMatchObject({
      companyCode: "2330",
      market: "listed",
      exchange: "TWSE",
      observedName: "台積電",
      dataMonth: result.expectedAsOf.slice(0, 7),
      selectedBarDate: result.expectedAsOf,
      snapshotIdentity: "verified",
    });
    const sourceUrl = new URL(result.source.sourceUrl);
    expect(sourceUrl.hostname).toBe("www.twse.com.tw");
    expect(sourceUrl.pathname).toBe("/rwd/zh/afterTrading/STOCK_DAY");
    expect(sourceUrl.searchParams.get("stockNo")).toBe("2330");
    expect(result.workBudget).toMatchObject({
      scope: "authoritative_completed_close_routing",
      completedSessionResolver: {
        marketCount: 1,
        calendarLogicalLoads: 1,
        sessionMarkerLogicalLoads: 1,
        actualTotal: 2,
        maximumTotal: 2,
      },
      exactStockOhlcAttempts: {
        maximum: 2,
      },
    });
    expect([1, 2]).toContain(
      result.workBudget.exactStockOhlcAttempts.actual,
    );
  }, 90_000);
});
