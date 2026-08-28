import {
  aggregateFreshness,
  evaluateFreshness,
} from "@/lib/freshness/evaluate";
import { completedSessionExpectedAsOfForMarket } from "@/lib/freshness/completed-session-resolver";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
import type {
  CompletedSessionResolverEvidence,
  FreshnessEvaluation,
  FreshnessStatus,
} from "@/lib/freshness/types";
import type {
  ObservedPriceAnalysisResult,
  ObservedPriceSource,
} from "@/lib/observed-price/types";
import type { QualityIssue } from "@/lib/mcp/result-contract";

import { completedSessionSnapshotEvidence } from "./completed-session-snapshot";
import { fingerprint } from "./cursor";

type ObservedPriceMetaData = Pick<
  ObservedPriceAnalysisResult,
  | "query"
  | "generatedAt"
  | "company"
  | "latestOfficialCompletedClose"
  | "latestOfficialCloseDate"
  | "officialPriceBasis"
> & {
  sources: ObservedPriceSource[];
};

export interface ObservedPriceMetaContract {
  freshnessDetails: [FreshnessEvaluation, FreshnessEvaluation];
  freshness: Extract<
    FreshnessStatus,
    "within_expected_window" | "stale" | "unknown"
  >;
  requiredFreshnessIssueCodes: Array<
    "DATA_STALE" | "FRESHNESS_UNVERIFIED"
  >;
  snapshotId: string;
}

export const OBSERVED_PRICE_REQUIRED_QUALITY_ISSUE_CODES = [
  "CALLER_SUPPLIED_PRICE_UNVERIFIED",
  "OFFICIAL_BASELINE_COMPLETED_SESSION",
  "CONSERVATIVE_SAME_DAY_SESSION_GUARD",
  "MECHANICAL_PRICE_COMPARISON_NOT_FAIR_VALUE",
  "MASTER_ROWSET_HEURISTIC",
] as const;

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function taipeiDate(instant: string): string | null {
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

function snapshotSources(sources: ObservedPriceSource[]) {
  return sources.map(({ cache: _callerCacheObservation, ...source }) => source);
}

function refs(
  data: ObservedPriceAnalysisResult,
  fields: string[],
  options: {
    periods?: string[];
    stages?: ObservedPriceAnalysisResult["sources"][number]["stage"][];
  } = {},
): QualityIssue["refs"] {
  const sources = options.stages
    ? data.sources.filter((source) => options.stages?.includes(source.stage))
    : data.sources;
  return {
    companyCodes: [data.company.code],
    fields,
    periods: unique(options.periods ?? []),
    sourceUrls: unique(sources.map((source) => source.sourceUrl)),
  };
}

export function observedPriceQualityIssues(
  data: ObservedPriceAnalysisResult,
): QualityIssue[] {
  return [
    {
      code: "CALLER_SUPPLIED_PRICE_UNVERIFIED",
      severity: "warning",
      scope: "value",
      message:
        "observedPriceTwd 與 observedAt 完全由 caller 提供，未由 MopsFin 或官方來源獨立驗證；不得描述為官方或 real-time 報價。",
      refs: refs(data, [
        "observedPriceTwd",
        "observedAt",
        "sourceLabel",
        "provenance.observedPrice",
      ]),
    },
    {
      code: "OFFICIAL_BASELINE_COMPLETED_SESSION",
      severity: "info",
      scope: "period",
      message:
        "官方基準先由 authoritative completed-session resolver 固定 expectedAsOf，再取同日 exact single-stock raw_unadjusted 收盤價；不是盤中價、adjusted close 或 total return，也不退回前一日價格。",
      refs: refs(
        data,
        [
          "latestOfficialCompletedClose",
          "latestOfficialCloseDate",
          "officialPriceBasis",
        ],
        {
          periods: [data.latestOfficialCloseDate],
          stages: ["latest_official_completed_close"],
        },
      ),
    },
    {
      code: "CONSERVATIVE_SAME_DAY_SESSION_GUARD",
      severity: "info",
      scope: "period",
      message:
        "同一台北日期的 caller observation 只有在 13:33 Asia/Taipei 保守 regular-session completion guard 之後才可與該日官方完成收盤比較。",
      refs: refs(data, ["observedAt", "latestOfficialCloseDate"], {
        periods: unique([
          data.observedTaipeiDate,
          data.latestOfficialCloseDate,
        ]),
        stages: ["latest_official_completed_close"],
      }),
    },
    {
      code: "MECHANICAL_PRICE_COMPARISON_NOT_FAIR_VALUE",
      severity: "info",
      scope: "value",
      message:
        "價差只是在 caller-supplied 觀察價與官方完成交易日收盤價之間做可重算的機械比較；不代表 fair value、進場區、目標價、評級或投資建議。",
      refs: refs(data, [
        "changeFromOfficialCloseTwd",
        "changeFromOfficialClosePercent",
        "provenance.comparison",
      ]),
    },
    {
      code: "MASTER_ROWSET_HEURISTIC",
      severity: "warning",
      scope: "universe",
      message:
        "目前上市櫃公司 master 已通過 listed／otc 必要來源、schema、日期與最低筆數 heuristic gate，但官方未提供 declared row count，不能宣稱完整全市場母體。",
      refs: refs(
        data,
        ["provenance.currentMasterIdentity", "sources.company_master"],
        {
          periods: unique(
            data.sources.flatMap((source) =>
              source.stage === "company_master" ? [source.reportDate] : [],
            ),
          ),
          stages: ["company_master"],
        },
      ),
    },
  ];
}

export function observedPriceFreshnessDetails(
  data: ObservedPriceMetaData,
  resolverEvidence: CompletedSessionResolverEvidence,
): [FreshnessEvaluation, FreshnessEvaluation] {
  const masterSources = data.sources.filter(
    (source) => source.stage === "company_master",
  );
  const closeSources = data.sources.filter(
    (source) => source.stage === "latest_official_completed_close",
  );
  const marketResolution = resolverEvidence.marketResolutions.find(
    (resolution) => resolution.market === data.company.market,
  );
  return [
    evaluateFreshness({
      policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
      observedAsOf: masterSources[0]?.reportDate ?? null,
      expectedAsOf: taipeiDate(data.generatedAt),
      sourceUrls: unique(masterSources.map((source) => source.sourceUrl)),
    }),
    evaluateFreshness({
      policy: FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: data.latestOfficialCloseDate,
      expectedAsOf:
        resolverEvidence.status === "resolved"
          ? completedSessionExpectedAsOfForMarket(
              resolverEvidence,
              data.company.market,
            )
          : null,
      sourceUrls: unique([
        ...closeSources.map((source) => source.sourceUrl),
        ...(marketResolution?.sources.map((source) => source.sourceUrl) ?? []),
      ]),
      resolverEvidence,
    }),
  ];
}

export function observedPriceSnapshotId(
  data: ObservedPriceMetaData,
  resolverEvidence: CompletedSessionResolverEvidence,
): string {
  return fingerprint({
    query: data.query,
    company: data.company,
    officialBaseline: {
      close: data.latestOfficialCompletedClose,
      date: data.latestOfficialCloseDate,
      priceBasis: data.officialPriceBasis,
    },
    sources: snapshotSources(data.sources),
    completedSessionResolver:
      completedSessionSnapshotEvidence(resolverEvidence),
  });
}

export function observedPriceFreshnessDetailsMatch(
  actual: FreshnessEvaluation[],
  expected: FreshnessEvaluation[],
): boolean {
  return fingerprint(actual) === fingerprint(expected);
}

export function observedPriceMetaContract(
  data: ObservedPriceMetaData,
  resolverEvidence: CompletedSessionResolverEvidence,
): ObservedPriceMetaContract {
  const freshnessDetails = observedPriceFreshnessDetails(
    data,
    resolverEvidence,
  );
  const aggregated = aggregateFreshness(freshnessDetails);
  const freshness =
    aggregated === "within_expected_window" || aggregated === "stale"
      ? aggregated
      : "unknown";
  const requiredFreshnessIssueCodes: ObservedPriceMetaContract["requiredFreshnessIssueCodes"] = [];
  if (freshnessDetails.some((detail) => detail.status === "stale")) {
    requiredFreshnessIssueCodes.push("DATA_STALE");
  }
  if (freshnessDetails.some((detail) => detail.status === "unknown")) {
    requiredFreshnessIssueCodes.push("FRESHNESS_UNVERIFIED");
  }
  return {
    freshnessDetails,
    freshness,
    requiredFreshnessIssueCodes,
    snapshotId: observedPriceSnapshotId(data, resolverEvidence),
  };
}
