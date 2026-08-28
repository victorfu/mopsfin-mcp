export type CacheStatus =
  | "hit"
  | "miss"
  | "shared"
  | "bypass"
  | "not_applicable"
  | "unknown";

/**
 * Cache state as observed by one caller. `storedAt` belongs to the cached
 * upstream value and therefore remains stable across hits; `observedAt` and
 * `ageMs` are recomputed for every caller.
 */
export interface CacheProvenance {
  status: CacheStatus;
  observedAt: string;
  storedAt: string | null;
  ageMs: number | null;
  ttlMs: number | null;
}

export interface CacheObservationInput {
  status: CacheStatus;
  observedAtMs: number;
  storedAtMs: number | null;
  ttlMs: number | null;
}

export function observeCache({
  status,
  observedAtMs,
  storedAtMs,
  ttlMs,
}: CacheObservationInput): CacheProvenance {
  return {
    status,
    observedAt: new Date(observedAtMs).toISOString(),
    storedAt: storedAtMs === null ? null : new Date(storedAtMs).toISOString(),
    ageMs:
      storedAtMs === null
        ? null
        : Math.max(0, Math.trunc(observedAtMs - storedAtMs)),
    ttlMs,
  };
}
