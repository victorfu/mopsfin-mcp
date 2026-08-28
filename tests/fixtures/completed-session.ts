import type {
  CompletedSessionResolverEvidence,
  CompletedSessionResolverSource,
} from "@/lib/freshness/types";
import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";

const WORK_UNIT =
  "one logical load of one official market source; transport retries do not add units" as const;

function source(
  market: CompanyMarket,
  role: CompletedSessionResolverSource["role"],
  asOf: string,
): CompletedSessionResolverSource {
  const listed = market === "listed";
  return {
    role,
    market,
    exchange: listed ? "TWSE" : "TPEx",
    sourceName:
      role === "calendar"
        ? `${listed ? "TWSE" : "TPEx"} annual trading calendar`
        : `${listed ? "TAIEX" : "TPEX_PRICE_INDEX"} exact benchmark month`,
    sourceUrl:
      role === "calendar"
        ? listed
          ? "https://www.twse.com.tw/holidaySchedule/holidaySchedule?queryYear=115&response=json"
          : "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate"
        : listed
          ? `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?date=${asOf.replace("-", "")}01&response=json`
          : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${asOf.replace("-", "")}01&response=json`,
    retrievedAt: "2026-08-28T06:01:00.000Z",
    cache: {
      status: "miss",
      observedAt: "2026-08-28T06:01:00.000Z",
      storedAt: "2026-08-28T06:01:00.000Z",
      ageMs: 0,
      ttlMs: 300_000,
    },
    asOf,
    asOfGranularity: role === "calendar" ? "year" : "month",
  };
}

export function completedSessionEvidenceFixture(options: {
  market?: CompanyMarketSelection;
  status?: "resolved" | "unresolved";
  expectedAsOf?: string;
} = {}): CompletedSessionResolverEvidence {
  const market = options.market ?? "listed";
  const markets: CompanyMarket[] =
    market === "all" ? ["listed", "otc"] : [market];
  const status = options.status ?? "resolved";
  const expectedAsOf = options.expectedAsOf ?? "2026-08-27";
  const resolved = status === "resolved";
  const marketResolutions = markets.map((resolvedMarket) => {
    const sources = resolved
      ? [
          source(resolvedMarket, "calendar", "2026"),
          source(
            resolvedMarket,
            "session_marker",
            expectedAsOf.slice(0, 7),
          ),
        ]
      : [];
    return {
      market: resolvedMarket,
      status,
      scheduledCandidate: resolved ? expectedAsOf : null,
      expectedAsOf: resolved ? expectedAsOf : null,
      reasonCode: resolved
        ? ("COMPLETED_SESSION_RESOLVED" as const)
        : ("CALENDAR_SOURCE_UNAVAILABLE" as const),
      reason: resolved
        ? "fixture scheduled candidate 已確認。"
        : "fixture calendar source unavailable。",
      sources,
      workBudget: {
        unitDefinition: WORK_UNIT,
        calendarLogicalLoads: 1,
        sessionMarkerLogicalLoads: resolved ? 1 : 0,
        actualTotal: resolved ? 2 : 1,
        maximumTotal: 2 as const,
      },
    };
  });
  return {
    resolverId: "taiwan-equity.completed-session.v1",
    status,
    evaluatedAt: "2026-08-28T06:02:00.000Z",
    timezone: "Asia/Taipei",
    completionGuardTaipei: "13:33:00",
    markets,
    expectedAsOf: resolved ? expectedAsOf : null,
    reasonCode: resolved
      ? "COMPLETED_SESSION_RESOLVED"
      : "CALENDAR_SOURCE_UNAVAILABLE",
    reason: resolved
      ? "fixture scheduled candidate 已由 exact benchmark 確認。"
      : "fixture calendar source unavailable。",
    marketResolutions,
    workBudget: {
      scope: "freshness_meta_layer",
      unitDefinition: WORK_UNIT,
      marketCount: markets.length,
      calendarLogicalLoads: markets.length,
      sessionMarkerLogicalLoads: resolved ? markets.length : 0,
      actualTotal: resolved ? markets.length * 2 : markets.length,
      maximumTotal: markets.length * 2,
    },
  };
}
