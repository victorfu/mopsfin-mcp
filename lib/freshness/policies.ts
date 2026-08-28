import type { FreshnessPolicy } from "./types";

export const FRESHNESS_POLICIES = {
  historicalExact: {
    id: "historical.exact.v1",
    mode: "not_applicable",
    lagUnit: "calendar_day",
  },
  completedOfficialSession: {
    id: "official.completed-session.v1",
    mode: "match_expected",
    lagUnit: "trading_session",
  },
  monthlyRevenueLatestCommon: {
    id: "official.monthly-revenue.latest-common.v1",
    mode: "match_expected",
    lagUnit: "calendar_month",
  },
  currentSnapshotSevenDays: {
    id: "official.current-snapshot.max-age-7d.v1",
    mode: "maximum_lag",
    lagUnit: "calendar_day",
    maximumLag: 7,
  },
  mopsfinLatestUnverified: {
    id: "mopsfin.latest-unverified.v1",
    mode: "unverifiable",
    lagUnit: "quarter",
  },
  unspecified: {
    id: "unverified.no-policy.v1",
    mode: "unverifiable",
    lagUnit: "calendar_day",
  },
} as const satisfies Record<string, FreshnessPolicy>;
