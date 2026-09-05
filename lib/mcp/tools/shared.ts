import { evaluateFreshness } from "@/lib/freshness/evaluate";
import {
  completedSessionExpectedAsOfForMarket,
  completedSessionResolver,
} from "@/lib/freshness/completed-session-resolver";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
import type {
  CompletedSessionResolverEvidence,
  FreshnessEvaluation,
  FreshnessPolicy,
} from "@/lib/freshness/types";
import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";
import { MOPSFIN_SOURCE_URL } from "@/lib/mopsfin/constants";
import type { Catalog } from "@/lib/mopsfin/types";

import { fingerprint, paginateByCompany } from "../cursor";
import {
  buildResultMeta,
  type ResultMetaHints,
} from "../result-contract";

export { catalystClient } from "@/lib/catalyst/client";
export { companyCatalystSnapshotClient } from "@/lib/catalyst/snapshot-client";
export { companyMasterClient } from "@/lib/company-master/client";
export { evaluateFreshness } from "@/lib/freshness/evaluate";
export { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
export { MOPSFIN_SOURCE_URL } from "@/lib/mopsfin/constants";
export { asMopsfinError } from "@/lib/mopsfin/errors";
export { companyMetricsBatchClient } from "@/lib/mopsfin/batch";
export { mopsfinClient } from "@/lib/mopsfin/client";
export {
  MOPSFIN_OFFICIAL_GUIDANCE,
  metricGuidance,
} from "@/lib/mopsfin/guidance";
export { priceClient } from "@/lib/price/client";
export { reactionClient } from "@/lib/reaction/client";
export { monthlyRevenueClient } from "@/lib/revenue/client";
export { taiwanStockScreenClient } from "@/lib/screening/client";
export { taiwanFinancialScreenClient } from "@/lib/financial-screening/client";
export { taiwanMarketScreenClient } from "@/lib/market-screening/client";
export { taiwanMarketFullUniverseClient } from "@/lib/full-screening/client";
export { valuationClient } from "@/lib/valuation/client";
export type { FreshnessEvaluation } from "@/lib/freshness/types";
export type { ResultMetaHints } from "../result-contract";
export { fingerprint, paginateByCompany } from "../cursor";
export { failure } from "./result";
export {
  companyCatalystEventsInputSchema,
  companyCatalystEventsOutputSchema,
  companyCatalystSnapshotsInputSchema,
  companyCatalystSnapshotsOutputSchema,
  companyMetricInputSchema,
  companyMetricOutputSchema,
  companyMetricsBatchInputSchema,
  companyMetricsBatchOutputSchema,
  dailyMarketOhlcInputSchema,
  dailyMarketOhlcOutputSchema,
  dailyMarketValuationInputSchema,
  dailyMarketValuationOutputSchema,
  financialInstitutionInputSchema,
  financialInstitutionOutputSchema,
  financialNoteInputSchema,
  financialNoteOutputSchema,
  financialStatementInputSchema,
  financialStatementOutputSchema,
  findCompaniesInputSchema,
  findCompaniesOutputSchema,
  industryDataInputSchema,
  industryDataOutputSchema,
  listCatalogInputSchema,
  listCatalogOutputSchema,
  listCompaniesInputSchema,
  listCompaniesOutputSchema,
  monthlyRevenueInputSchema,
  monthlyRevenueOutputSchema,
  monthlyRevenueTrendInputSchema,
  monthlyRevenueTrendOutputSchema,
  analyzeObservedPriceInputSchema,
  analyzeObservedPriceOutputSchema,
  reverseDcfInputSchema,
  reverseDcfOutputSchema,
  screenTaiwanStockCandidatesInputSchema,
  screenTaiwanStockCandidatesOutputSchema,
  screenTaiwanFinancialCandidatesInputSchema,
  screenTaiwanFinancialCandidatesOutputSchema,
  screenTaiwanMarketCandidatesInputSchema,
  screenTaiwanMarketCandidatesOutputSchema,
  screenTaiwanMarketUniversePageInputSchema,
  screenTaiwanMarketUniversePageOutputSchema,
  stockReactionSignalsInputSchema,
  stockReactionSignalsOutputSchema,
  stockOhlcInputSchema,
  stockOhlcOutputSchema,
  valuationModelInputsInputSchema,
  valuationModelInputsOutputSchema,
} from "../schemas";

export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function sourceUrls(
  sources: Array<{ sourceUrl: string | null }>,
): string[] {
  return sources.flatMap((item) => (item.sourceUrl ? [item.sourceUrl] : []));
}

export function selectorFreshness(options: {
  selector: "latest" | "explicit" | "range";
  observedAsOf: string | null;
  sources: Array<{ sourceUrl: string | null }>;
  latestPolicy?: FreshnessPolicy;
  expectedAsOf?: string | null;
}): FreshnessEvaluation[] {
  return [
    evaluateFreshness({
      policy:
        options.selector === "latest"
          ? options.latestPolicy ?? FRESHNESS_POLICIES.completedOfficialSession
          : FRESHNESS_POLICIES.historicalExact,
      observedAsOf: options.observedAsOf,
      expectedAsOf:
        options.selector === "latest" ? options.expectedAsOf ?? null : null,
      sourceUrls: sourceUrls(options.sources),
    }),
  ];
}

export interface CompletedSessionFreshnessObservation {
  market: CompanyMarket;
  observedAsOf: string | null;
  sources: Array<{ sourceUrl: string | null }>;
}

export function officialCompletedSessionFreshnessFromEvidence(options: {
  observations: CompletedSessionFreshnessObservation[];
  evidenceByMarket: CompletedSessionResolverEvidence[];
}): FreshnessEvaluation[] {
  return options.observations.map((observation) => {
    const evidence = options.evidenceByMarket.find(
      (candidate) =>
        candidate.markets.length === 1 &&
        candidate.markets[0] === observation.market,
    );
    if (!evidence) {
      throw new TypeError(
        `缺少 ${observation.market} 的 completed-session resolver evidence。`,
      );
    }
    const resolution = evidence.marketResolutions.find(
      (item) => item.market === observation.market,
    );
    return evaluateFreshness({
      policy: FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: observation.observedAsOf,
      expectedAsOf:
        evidence.status === "resolved"
          ? completedSessionExpectedAsOfForMarket(
              evidence,
              observation.market,
            )
          : null,
      sourceUrls: [
        ...sourceUrls(observation.sources),
        ...(resolution?.sources.map((item) => item.sourceUrl) ?? []),
      ],
      resolverEvidence: evidence,
    });
  });
}

/**
 * Resolve latest completed-session freshness once, then evaluate one or more
 * source-domain observations without performing network work in schemas or
 * result-contract validation. Explicit historical selectors must keep using
 * selectorFreshness and never call this helper.
 */
export async function resolveOfficialCompletedSessionFreshness(options: {
  market: CompanyMarketSelection;
  observations: CompletedSessionFreshnessObservation[];
  evaluatedAt?: string;
}): Promise<FreshnessEvaluation[]> {
  const allowedMarkets: CompanyMarket[] =
    options.market === "all" ? ["listed", "otc"] : [options.market];
  if (
    options.observations.length === 0 ||
    options.observations.some(
      (observation) => !allowedMarkets.includes(observation.market),
    )
  ) {
    throw new TypeError(
      "completed-session observations 必須非空且 market 必須位於 resolver scope。",
    );
  }
  const evidence = await completedSessionResolver.resolve({
    market: options.market,
    ...(options.evaluatedAt ? { evaluatedAt: options.evaluatedAt } : {}),
  });
  return options.observations.map((observation) => {
    const resolution = evidence.marketResolutions.find(
      (item) => item.market === observation.market,
    );
    const resolverSourceUrls = resolution?.sources.map(
      (item) => item.sourceUrl,
    ) ?? [];
    return evaluateFreshness({
      policy: FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: observation.observedAsOf,
      expectedAsOf:
        evidence.status === "resolved"
          ? completedSessionExpectedAsOfForMarket(evidence, observation.market)
          : null,
      sourceUrls: [
        ...sourceUrls(observation.sources),
        ...resolverSourceUrls,
      ],
      resolverEvidence: evidence,
    });
  });
}

export function taipeiDate(instant: string): string | null {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function source(
  route: string,
  retrievedAt: string,
  cache?: Catalog["cache"],
) {
  return {
    sourceName: "公開資訊觀測站－財務比較 E 點通",
    sourceUrl: MOPSFIN_SOURCE_URL,
    retrievedAt,
    ...(cache ? { cache } : {}),
    upstreamRoute: route,
    freshnessNote: "原站每日更新一次，資料可能較最新申報落後約一日。",
  };
}

export function success<T extends object>(
  summary: string,
  data: T,
  hints: ResultMetaHints = {},
) {
  const structuredContent = {
    ok: true as const,
    meta: buildResultMeta(data as Record<string, unknown>, hints),
    ...data,
  };
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent,
  };
}

export function includesQuery(
  values: Array<string | undefined>,
  query: string,
): boolean {
  const needle = query.toLocaleLowerCase("zh-TW");
  return values.some((value) =>
    value?.toLocaleLowerCase("zh-TW").includes(needle),
  );
}

export function catalogPeriods(catalog: Catalog): string[] {
  return catalog.years.flatMap((year) =>
    catalog.quarters.map((quarter) => `${year}Q${quarter}`),
  );
}

export function resolvedQuarterRange(periods: string[]) {
  const ordered = [...periods].sort();
  return {
    granularity: "quarter" as const,
    from: ordered[0] ?? null,
    through: ordered.at(-1) ?? null,
  };
}
