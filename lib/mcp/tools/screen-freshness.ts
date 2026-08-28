import type { FreshnessEvaluation } from "@/lib/freshness/types";
import type { TaiwanStockScreenResult } from "@/lib/screening/types";

import {
  FRESHNESS_POLICIES,
  evaluateFreshness,
  resolveOfficialCompletedSessionFreshness,
  taipeiDate,
  type CompletedSessionFreshnessObservation,
} from "./shared";

function reactionDateByMarket(
  data: TaiwanStockScreenResult,
  market: "listed" | "otc",
): string | null {
  const dates = [
    ...new Set(
      data.asOf.reactionDates
        .filter((item) => item.market === market)
        .map((item) => item.date),
    ),
  ];
  return dates.length === 1 ? (dates[0] ?? null) : null;
}

/**
 * Build the mixed-source screen freshness contract. Official latest market
 * sources share one bounded completed-session resolution, while historical,
 * monthly, current-master, and Mopsfin sources retain their own policies.
 * evaluatedAt defaults at metadata assembly time so a long screen cannot carry
 * a pre-13:33 start instant across the completed-session guard.
 */
export async function buildScreenFreshnessDetails(
  data: TaiwanStockScreenResult,
  evaluatedAt: string = new Date().toISOString(),
): Promise<FreshnessEvaluation[]> {
  const expectedScreenDate = taipeiDate(evaluatedAt);
  const details: FreshnessEvaluation[] = [];
  const completedSessionObservations: CompletedSessionFreshnessObservation[] =
    [];

  for (const source of data.sources) {
    if (source.kind === "company_master") {
      details.push(
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
          observedAsOf: source.asOf,
          expectedAsOf: expectedScreenDate,
          sourceUrls: [source.sourceUrl],
        }),
      );
      continue;
    }
    if (source.kind === "monthly_revenue_latest") {
      details.push(
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.monthlyRevenueLatestCommon,
          observedAsOf: source.asOf,
          expectedAsOf: data.asOf.revenueMonth,
          sourceUrls: [source.sourceUrl],
        }),
      );
      continue;
    }
    if (
      source.kind === "monthly_revenue_history" ||
      source.kind === "reaction_corporate_action"
    ) {
      details.push(
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.historicalExact,
          observedAsOf: source.asOf,
          expectedAsOf: null,
          sourceUrls: [source.sourceUrl],
        }),
      );
      continue;
    }
    if (source.kind === "company_metrics") {
      details.push(
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
          observedAsOf: source.asOf === "mixed" ? null : source.asOf,
          expectedAsOf: null,
          sourceUrls: [source.sourceUrl],
        }),
      );
      continue;
    }

    const observedAsOf =
      source.kind === "valuation_latest"
        ? source.asOf
        : source.market
          ? reactionDateByMarket(data, source.market)
          : null;
    const marketInScope =
      source.market !== null &&
      (data.query.market === "all" || source.market === data.query.market);
    if (source.market && marketInScope) {
      completedSessionObservations.push({
        market: source.market,
        observedAsOf,
        sources: [{ sourceUrl: source.sourceUrl }],
      });
    } else {
      details.push(
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.completedOfficialSession,
          observedAsOf,
          expectedAsOf: null,
          sourceUrls: [source.sourceUrl],
        }),
      );
    }
  }

  if (completedSessionObservations.length > 0) {
    details.push(
      ...(await resolveOfficialCompletedSessionFreshness({
        market: data.query.market,
        observations: completedSessionObservations,
        evaluatedAt,
      })),
    );
  }
  return details;
}
