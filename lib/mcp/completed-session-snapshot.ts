import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";

/**
 * Stable routing provenance for snapshot fingerprints. Caller-specific cache
 * observations and request timing are excluded, while official source identity
 * and retrieval provenance remain bound to the resulting snapshot.
 */
export function completedSessionSnapshotEvidence(
  evidence: CompletedSessionResolverEvidence,
) {
  return {
    resolverId: evidence.resolverId,
    status: evidence.status,
    timezone: evidence.timezone,
    completionGuardTaipei: evidence.completionGuardTaipei,
    markets: evidence.markets,
    expectedAsOf: evidence.expectedAsOf,
    reasonCode: evidence.reasonCode,
    marketResolutions: evidence.marketResolutions.map((resolution) => ({
      market: resolution.market,
      status: resolution.status,
      scheduledCandidate: resolution.scheduledCandidate,
      expectedAsOf: resolution.expectedAsOf,
      reasonCode: resolution.reasonCode,
      sources: resolution.sources.map(
        ({ cache: _callerCacheObservation, ...source }) => source,
      ),
    })),
  };
}
