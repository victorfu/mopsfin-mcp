import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

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
}
