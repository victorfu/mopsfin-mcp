import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import type { CompanyMarket } from "@/lib/company-master/types";

export type FreshnessStatus =
  | "within_expected_window"
  | "stale"
  | "unknown"
  | "not_applicable";

export type FreshnessLagUnit =
  | "calendar_day"
  | "calendar_month"
  | "trading_session"
  | "quarter";

export type { CacheStatus } from "@/lib/upstream/cache-provenance";

/** Caller-specific observation of an in-process source cache. */
export type SourceCacheObservation = Omit<CacheProvenance, "observedAt"> & {
  /** Null when the source loader does not expose caller-specific cache state. */
  observedAt: string | null;
};

export type CompletedSessionResolverReasonCode =
  | "COMPLETED_SESSION_RESOLVED"
  | "CALENDAR_SOURCE_UNAVAILABLE"
  | "CALENDAR_CONTRACT_MISMATCH"
  | "CALENDAR_YEAR_IDENTITY_MISMATCH"
  | "SCHEDULED_SESSION_UNRESOLVED"
  | "SESSION_MARKER_UNAVAILABLE"
  | "SESSION_MARKER_NOT_CONFIRMED"
  | "CROSS_MARKET_EXPECTED_AS_OF_MISMATCH";

export interface CompletedSessionResolverSource {
  role: "calendar" | "session_marker";
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  cache: SourceCacheObservation;
  asOf: string;
  asOfGranularity: "year" | "month";
}

export interface CompletedSessionMarketResolution {
  market: CompanyMarket;
  status: "resolved" | "unresolved";
  scheduledCandidate: string | null;
  expectedAsOf: string | null;
  reasonCode: Exclude<
    CompletedSessionResolverReasonCode,
    "CROSS_MARKET_EXPECTED_AS_OF_MISMATCH"
  >;
  reason: string;
  sources: CompletedSessionResolverSource[];
  workBudget: {
    unitDefinition: "one logical load of one official market source; transport retries do not add units";
    calendarLogicalLoads: number;
    sessionMarkerLogicalLoads: number;
    actualTotal: number;
    maximumTotal: 2;
  };
}

export interface CompletedSessionResolverEvidence {
  resolverId: "taiwan-equity.completed-session.v1";
  status: "resolved" | "unresolved";
  evaluatedAt: string;
  timezone: "Asia/Taipei";
  completionGuardTaipei: "13:33:00";
  markets: CompanyMarket[];
  expectedAsOf: string | null;
  reasonCode: CompletedSessionResolverReasonCode;
  reason: string;
  marketResolutions: CompletedSessionMarketResolution[];
  workBudget: {
    scope: "freshness_meta_layer";
    unitDefinition: "one logical load of one official market source; transport retries do not add units";
    marketCount: number;
    calendarLogicalLoads: number;
    sessionMarkerLogicalLoads: number;
    actualTotal: number;
    maximumTotal: number;
  };
}

export type FreshnessPolicy =
  | {
      id: string;
      mode: "not_applicable" | "unverifiable";
      lagUnit: FreshnessLagUnit;
    }
  | {
      id: string;
      mode: "match_expected";
      lagUnit: FreshnessLagUnit;
    }
  | {
      id: string;
      mode: "maximum_lag";
      lagUnit: FreshnessLagUnit;
      maximumLag: number;
    };

export interface EvaluateFreshnessInput {
  policy: FreshnessPolicy;
  observedAsOf: string | null;
  expectedAsOf: string | null;
  /**
   * Optional lag supplied by an authoritative calendar/session resolver.
   * It is required when a non-zero trading-session lag must be quantified.
   */
  resolvedLag?: number | null;
  sourceUrls?: string[];
  resolverEvidence?: CompletedSessionResolverEvidence;
}

export interface FreshnessEvaluation {
  status: FreshnessStatus;
  policyId: string;
  observedAsOf: string | null;
  expectedAsOf: string | null;
  lag: {
    value: number;
    unit: FreshnessLagUnit;
  } | null;
  reasonCode: string;
  reason: string;
  sourceUrls: string[];
  resolverEvidence?: CompletedSessionResolverEvidence;
}
