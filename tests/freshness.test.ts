import { describe, expect, it } from "vitest";

import {
  aggregateFreshness,
  evaluateFreshness,
} from "@/lib/freshness/evaluate";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";

describe("central freshness evaluation", () => {
  it("marks an exact official completed session as within the expected window", () => {
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.completedOfficialSession,
        observedAsOf: "2026-08-27",
        expectedAsOf: "2026-08-27",
        sourceUrls: ["https://example.test/twse"],
      }),
    ).toMatchObject({
      status: "within_expected_window",
      policyId: "official.completed-session.v1",
      lag: { value: 0, unit: "trading_session" },
      reasonCode: "MATCHES_EXPECTED_AS_OF",
    });
  });

  it("fails conservatively when a completed-session resolver is unavailable", () => {
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.completedOfficialSession,
        observedAsOf: "2026-08-27",
        expectedAsOf: null,
      }),
    ).toMatchObject({
      status: "unknown",
      lag: null,
      reasonCode: "EXPECTED_AS_OF_UNAVAILABLE",
    });
  });

  it("marks a source behind the expected as-of as stale without inventing session lag", () => {
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.completedOfficialSession,
        observedAsOf: "2026-08-26",
        expectedAsOf: "2026-08-27",
      }),
    ).toMatchObject({
      status: "stale",
      lag: null,
      reasonCode: "BEHIND_EXPECTED_AS_OF",
    });
  });

  it("computes month lag for coordinated monthly-revenue sources", () => {
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.monthlyRevenueLatestCommon,
        observedAsOf: "2026-06",
        expectedAsOf: "2026-07",
      }),
    ).toMatchObject({
      status: "stale",
      lag: { value: 1, unit: "calendar_month" },
    });
  });

  it("applies a bounded current-snapshot age policy", () => {
    const fresh = evaluateFreshness({
      policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
      observedAsOf: "2026-08-21",
      expectedAsOf: "2026-08-28",
    });
    const stale = evaluateFreshness({
      policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
      observedAsOf: "2026-08-20",
      expectedAsOf: "2026-08-28",
    });

    expect(fresh).toMatchObject({
      status: "within_expected_window",
      lag: { value: 7, unit: "calendar_day" },
    });
    expect(stale).toMatchObject({
      status: "stale",
      lag: { value: 8, unit: "calendar_day" },
    });
  });

  it("does not accept a future or malformed observed as-of as fresh", () => {
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
        observedAsOf: "2026-08-29",
        expectedAsOf: "2026-08-28",
      }),
    ).toMatchObject({
      status: "unknown",
      reasonCode: "OBSERVED_AFTER_EXPECTED_AS_OF",
    });
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
        observedAsOf: "2026-02-30",
        expectedAsOf: "2026-08-28",
      }),
    ).toMatchObject({
      status: "unknown",
      reasonCode: "AS_OF_FORMAT_UNVERIFIED",
    });
  });

  it("marks explicit historical evidence not applicable", () => {
    expect(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.historicalExact,
        observedAsOf: "2024-01-31",
        expectedAsOf: null,
      }),
    ).toMatchObject({
      status: "not_applicable",
      reasonCode: "HISTORICAL_SELECTOR_NOT_APPLICABLE",
    });
  });

  it("aggregates conservatively with stale ahead of unknown and fresh", () => {
    expect(
      aggregateFreshness([
        { status: "within_expected_window" },
        { status: "unknown" },
      ]),
    ).toBe("unknown");
    expect(
      aggregateFreshness([
        { status: "within_expected_window" },
        { status: "unknown" },
        { status: "stale" },
      ]),
    ).toBe("stale");
    expect(aggregateFreshness([])).toBe("unknown");
  });
});
