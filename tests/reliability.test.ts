import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AbsoluteDeadline,
  assertJsonWithinLimits,
  BoundedSemaphore,
  BoundedTtlLru,
  createAttemptAbortScope,
  createSharedUpstreamFlight,
  getCurrentDeadline,
  getUpstreamReliabilitySnapshot,
  parseRetryAfterMs,
  readResponseTextWithLimit,
  runWithRequestDeadline,
  UpstreamReliabilityError,
} from "@/lib/upstream/reliability";

afterEach(() => {
  vi.useRealTimers();
});

describe("upstream reliability primitives", () => {
  it("clamps nested deadlines to the ambient request deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));

    await runWithRequestDeadline(1_000, async (requestDeadline) => {
      expect(getCurrentDeadline()).toBe(requestDeadline);
      const nested = new AbsoluteDeadline(5_000);
      try {
        expect(nested.expiresAtMs).toBe(requestDeadline.expiresAtMs);
        requestDeadline.abort();
        expect(nested.signal.aborted).toBe(true);
      } finally {
        nested.dispose();
      }
    });
    expect(getCurrentDeadline()).toBeUndefined();
  });

  it("distinguishes an attempt timeout from its absolute deadline", async () => {
    vi.useFakeTimers();
    const deadline = new AbsoluteDeadline(1_000);
    const scope = createAttemptAbortScope(deadline, 100);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(scope.signal.aborted).toBe(true);
      expect(scope.abortKind()).toBe("timeout");
    } finally {
      scope.cleanup();
      deadline.dispose();
    }
  });

  it("marks a no-waiter shared flight orphaned before its task settles", async () => {
    let resolveTask: ((value: string) => void) | undefined;
    let sharedSignal: AbortSignal | undefined;
    const flight = createSharedUpstreamFlight(1_000, (deadline) => {
      sharedSignal = deadline.signal;
      return new Promise<string>((resolve) => {
        resolveTask = resolve;
      });
    });
    const waiterDeadline = new AbsoluteDeadline(1_000);
    const waiter = flight.wait(waiterDeadline).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    expect(flight.state).toBe("active");
    waiterDeadline.abort(
      new UpstreamReliabilityError("ABORTED", "waiter disconnected"),
    );
    expect((await waiter).status).toBe("rejected");
    expect(flight.state).toBe("orphaned");
    expect(flight.settled).toBe(false);
    expect(sharedSignal?.aborted).toBe(true);

    resolveTask?.("done");
    await expect(flight.promise).resolves.toBe("done");
    expect(flight.state).toBe("settled");
    expect(flight.settled).toBe(true);
    waiterDeadline.dispose();
  });

  it("parses Retry-After seconds and dates with a safe maximum", () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    expect(parseRetryAfterMs("1.5", now)).toBe(1_500);
    expect(
      parseRetryAfterMs("Wed, 26 Aug 2026 00:00:02 GMT", now),
    ).toBe(2_000);
    expect(parseRetryAfterMs("999", now)).toBe(30_000);
    expect(parseRetryAfterMs("not-a-date", now)).toBeNull();
  });

  it("rejects response bodies and JSON arrays above configured limits", async () => {
    const before = getUpstreamReliabilitySnapshot().counters;
    await expect(
      readResponseTextWithLimit(new Response("12345"), 4),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(() =>
      assertJsonWithinLimits([1, 2], { maximumArrayLength: 1 }),
    ).toThrow(expect.objectContaining({ code: "ROW_LIMIT_EXCEEDED" }));
    const after = getUpstreamReliabilitySnapshot().counters;
    expect(after.responseLimitExceeded).toBe(before.responseLimitExceeded + 1);
    expect(after.rowLimitExceeded).toBe(before.rowLimitExceeded + 1);
  });

  it("keeps TTL cache entry count and weight bounded with LRU eviction", () => {
    const cache = new BoundedTtlLru<string, string>(2, 5);
    cache.set("a", "A", { ttlMs: 100, weight: 2, nowMs: 0 });
    cache.set("b", "B", { ttlMs: 100, weight: 2, nowMs: 0 });
    expect(cache.get("a", 1)).toBe("A");
    cache.set("c", "C", { ttlMs: 100, weight: 2, nowMs: 1 });

    expect(cache.get("b", 1)).toBeUndefined();
    expect(cache.get("a", 1)).toBe("A");
    expect(cache.get("c", 1)).toBe("C");
    expect(cache.size).toBe(2);
    expect(cache.weight).toBe(4);
    expect(cache.get("a", 101)).toBeUndefined();
    cache.set("invalid-ttl", "X", {
      ttlMs: Number.POSITIVE_INFINITY,
      weight: 1,
    });
    cache.set("invalid-weight", "X", { ttlMs: 100, weight: Number.NaN });
    expect(cache.size).toBe(1);
  });

  it("bounds semaphore concurrency and rejects excess queued work", async () => {
    const semaphore = new BoundedSemaphore(1, 1, 321);
    const releaseFirst = await semaphore.acquire();
    const second = semaphore.acquire();

    expect(semaphore.snapshot()).toEqual({
      active: 1,
      queued: 1,
      maximumConcurrency: 1,
      maximumQueue: 1,
    });
    await expect(semaphore.acquire()).rejects.toEqual(
      expect.objectContaining<Partial<UpstreamReliabilityError>>({
        code: "BACKPRESSURE",
        retryAfterMs: 321,
      }),
    );

    releaseFirst();
    const releaseSecond = await second;
    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.queuedCount).toBe(0);
    releaseSecond();
    expect(semaphore.activeCount).toBe(0);
  });
});
