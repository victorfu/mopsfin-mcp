import { afterEach, describe, expect, it, vi } from "vitest";

import { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import type {
  CompletedSessionMarketResolution,
  CompletedSessionResolverEvidence,
} from "@/lib/freshness/types";
import { buildScreenFreshnessDetails } from "@/lib/mcp/tools/screen-freshness";
import type {
  ScreenSource,
  TaiwanStockScreenResult,
} from "@/lib/screening/types";

const EVALUATED_AT = "2026-08-28T07:00:00.000Z";

function marketResolution(
  market: "listed" | "otc",
): CompletedSessionMarketResolution {
  const exchange = market === "listed" ? "TWSE" : "TPEx";
  return {
    market,
    status: "resolved",
    scheduledCandidate: "2026-08-28",
    expectedAsOf: "2026-08-28",
    reasonCode: "COMPLETED_SESSION_RESOLVED",
    reason: "resolved",
    sources: [
      {
        role: "calendar",
        market,
        exchange,
        sourceName: `${exchange} calendar`,
        sourceUrl: `https://example.test/${market}/calendar`,
        retrievedAt: EVALUATED_AT,
        cache: {
          status: "miss",
          observedAt: EVALUATED_AT,
          storedAt: EVALUATED_AT,
          ageMs: 0,
          ttlMs: 300_000,
        },
        asOf: "2026",
        asOfGranularity: "year",
      },
      {
        role: "session_marker",
        market,
        exchange,
        sourceName: `${exchange} benchmark`,
        sourceUrl: `https://example.test/${market}/benchmark`,
        retrievedAt: EVALUATED_AT,
        cache: {
          status: "miss",
          observedAt: EVALUATED_AT,
          storedAt: EVALUATED_AT,
          ageMs: 0,
          ttlMs: 300_000,
        },
        asOf: "2026-08",
        asOfGranularity: "month",
      },
    ],
    workBudget: {
      unitDefinition:
        "one logical load of one official market source; transport retries do not add units",
      calendarLogicalLoads: 1,
      sessionMarkerLogicalLoads: 1,
      actualTotal: 2,
      maximumTotal: 2,
    },
  };
}

function resolverEvidence(): CompletedSessionResolverEvidence {
  const marketResolutions = [
    marketResolution("listed"),
    marketResolution("otc"),
  ];
  return {
    resolverId: "taiwan-equity.completed-session.v1",
    status: "resolved",
    evaluatedAt: EVALUATED_AT,
    timezone: "Asia/Taipei",
    completionGuardTaipei: "13:33:00",
    markets: ["listed", "otc"],
    expectedAsOf: "2026-08-28",
    reasonCode: "COMPLETED_SESSION_RESOLVED",
    reason: "resolved",
    marketResolutions,
    workBudget: {
      scope: "freshness_meta_layer",
      unitDefinition:
        "one logical load of one official market source; transport retries do not add units",
      marketCount: 2,
      calendarLogicalLoads: 2,
      sessionMarkerLogicalLoads: 2,
      actualTotal: 4,
      maximumTotal: 4,
    },
  };
}

function source(
  kind: ScreenSource["kind"],
  market: ScreenSource["market"],
  asOf: string,
  asOfGranularity: ScreenSource["asOfGranularity"],
): ScreenSource {
  return {
    kind,
    sourceName: kind,
    sourceUrl: `https://example.test/${kind}/${market ?? "none"}`,
    retrievedAt: EVALUATED_AT,
    market,
    asOf,
    asOfGranularity,
  };
}

function screen(
  sources: ScreenSource[],
  reactionDates: TaiwanStockScreenResult["asOf"]["reactionDates"] = [
    { market: "listed", date: "2026-08-28" },
    { market: "otc", date: "2026-08-28" },
  ],
  market: "all" | "listed" | "otc" = "all",
): TaiwanStockScreenResult {
  return {
    query: { market },
    generatedAt: EVALUATED_AT,
    asOf: {
      revenueMonth: "2026-07",
      reactionDates,
    },
    sources,
  } as TaiwanStockScreenResult;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("screen mixed-source freshness", () => {
  it("resolves market freshness once and uses reactionDates instead of benchmark months", async () => {
    const resolve = vi
      .spyOn(completedSessionResolver, "resolve")
      .mockResolvedValue(resolverEvidence());
    const details = await buildScreenFreshnessDetails(
      screen([
        source("valuation_latest", "listed", "2026-08-28", "date"),
        source("reaction_benchmark", "listed", "2026-08", "month"),
        source("reaction_stock", "otc", "2026-08", "month"),
      ]),
      EVALUATED_AT,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      market: "all",
      evaluatedAt: EVALUATED_AT,
    });
    expect(details).toHaveLength(3);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyId: "official.completed-session.v1",
          observedAsOf: "2026-08-28",
          expectedAsOf: "2026-08-28",
          status: "within_expected_window",
          resolverEvidence: expect.objectContaining({ status: "resolved" }),
        }),
      ]),
    );
    expect(details.some((detail) => detail.observedAsOf === "2026-08")).toBe(
      false,
    );
  });

  it("fails reaction freshness closed when one market has conflicting resolved dates", async () => {
    vi.spyOn(completedSessionResolver, "resolve").mockResolvedValue(
      resolverEvidence(),
    );
    const [detail] = await buildScreenFreshnessDetails(
      screen(
        [source("reaction_benchmark", "listed", "2026-08", "month")],
        [
          { market: "listed", date: "2026-08-27" },
          { market: "listed", date: "2026-08-28" },
        ],
      ),
      EVALUATED_AT,
    );

    expect(detail).toMatchObject({
      policyId: "official.completed-session.v1",
      observedAsOf: null,
      expectedAsOf: "2026-08-28",
      status: "unknown",
    });
  });

  it("does not invoke the resolver when the screen has no latest market source", async () => {
    const resolve = vi.spyOn(completedSessionResolver, "resolve");
    const details = await buildScreenFreshnessDetails(
      screen([
        source("monthly_revenue_latest", "listed", "2026-07", "month"),
        source("company_metrics", null, "2026Q2", "quarter"),
      ]),
      EVALUATED_AT,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(details.map((detail) => detail.policyId)).toEqual([
      "official.monthly-revenue.latest-common.v1",
      "mopsfin.latest-unverified.v1",
    ]);
  });

  it("keeps an out-of-scope source unknown without failing the screen", async () => {
    const resolve = vi.spyOn(completedSessionResolver, "resolve");
    const [detail] = await buildScreenFreshnessDetails(
      screen(
        [source("valuation_latest", "otc", "2026-08-28", "date")],
        [],
        "listed",
      ),
      EVALUATED_AT,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(detail).toMatchObject({
      policyId: "official.completed-session.v1",
      observedAsOf: "2026-08-28",
      expectedAsOf: null,
      status: "unknown",
    });
  });

  it("evaluates the session guard at freshness assembly time, not screen start time", async () => {
    const resolve = vi
      .spyOn(completedSessionResolver, "resolve")
      .mockResolvedValue(resolverEvidence());
    const startedBeforeGuard = screen([
      source("valuation_latest", "listed", "2026-08-28", "date"),
    ]);
    startedBeforeGuard.generatedAt = "2026-08-28T05:32:59.000Z";
    const completedAfterGuard = "2026-08-28T05:33:01.000Z";

    await buildScreenFreshnessDetails(
      startedBeforeGuard,
      completedAfterGuard,
    );

    expect(resolve).toHaveBeenCalledWith({
      market: "all",
      evaluatedAt: completedAfterGuard,
    });
  });
});
