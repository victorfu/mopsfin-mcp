import { describe, expect, it, vi } from "vitest";

import {
  OfficialJsonLoader,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";

const config: OfficialSourceConfig = {
  market: "listed",
  exchange: "TWSE",
  sourceName: "fixture",
  sourceUrl: "https://example.test/a",
};
const now = () => new Date("2026-08-26T00:00:00.000Z");

describe("OfficialJsonLoader reliability", () => {
  it("preserves upstream retrieval time and observes cache age per caller", async () => {
    let clockMs = Date.parse("2026-08-26T00:00:00.000Z");
    const clock = () => new Date(clockMs);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ Code: "2330" }]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const loader = new OfficialJsonLoader(fetchMock as typeof fetch, clock, {
      cacheTtlMs: 60_000,
      maxAttempts: 1,
    });

    const first = await loader.get(config);
    clockMs += 5_000;
    const second = await loader.get(config);

    expect(first).toMatchObject({
      retrievedAt: "2026-08-26T00:00:00.000Z",
      cache: {
        status: "miss",
        observedAt: "2026-08-26T00:00:00.000Z",
        storedAt: "2026-08-26T00:00:00.000Z",
        ageMs: 0,
        ttlMs: 60_000,
      },
    });
    expect(second).toMatchObject({
      retrievedAt: first.retrievedAt,
      cache: {
        status: "hit",
        observedAt: "2026-08-26T00:00:05.000Z",
        storedAt: "2026-08-26T00:00:00.000Z",
        ageMs: 5_000,
        ttlMs: 60_000,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("labels a concurrent follower shared without mutating the owner metadata", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const loader = new OfficialJsonLoader(fetchMock as typeof fetch, now, {
      cacheTtlMs: 60_000,
      maxAttempts: 1,
    });

    const owner = loader.get(config);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const follower = loader.get(config);
    release?.(new Response(JSON.stringify([{ Code: "2330" }])));
    const [ownerResult, followerResult] = await Promise.all([owner, follower]);

    expect(ownerResult.cache?.status).toBe("miss");
    expect(followerResult.cache?.status).toBe("shared");
    expect(followerResult.retrievedAt).toBe(ownerResult.retrievedAt);
    expect(followerResult.cache?.storedAt).toBe(ownerResult.cache?.storedAt);
  });

  it("reports cache bypass when caching is disabled", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}"));
    const loader = new OfficialJsonLoader(fetchMock as typeof fetch, now, {
      cacheTtlMs: 0,
      maxAttempts: 1,
    });

    const first = await loader.get(config);
    const second = await loader.get(config);

    expect(first.cache).toMatchObject({
      status: "bypass",
      storedAt: null,
      ageMs: null,
      ttlMs: 0,
    });
    expect(second.cache?.status).toBe("bypass");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns structured retryable metadata for an exhausted 5xx", async () => {
    const loader = new OfficialJsonLoader(
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    await expect(loader.get(config)).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_HTTP_5XX",
      retryable: true,
      action: "retry",
    });
  });

  it("preserves Retry-After on an exhausted HTTP 429", async () => {
    const loader = new OfficialJsonLoader(
      vi.fn().mockResolvedValue(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
      ) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    await expect(loader.get(config)).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      reason: "UPSTREAM_HTTP_429",
      retryable: true,
      retryAfterMs: 3_000,
      action: "retry",
    });
  });

  it("enforces JSON row limits without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ code: "1" }, { code: "2" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const loader = new OfficialJsonLoader(fetchMock as typeof fetch, now, {
      maxAttempts: 2,
      maxJsonArrayLength: 1,
      retryDelayMs: 0,
    });

    await expect(loader.get(config)).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("evicts the least-recently-used response when cache entry capacity is reached", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) =>
      new Response(JSON.stringify({ source: String(input) })),
    );
    const loader = new OfficialJsonLoader(fetchMock as typeof fetch, now, {
      cacheMaxEntries: 1,
      cacheTtlMs: 60_000,
    });

    await loader.get(config);
    await loader.get({ ...config, sourceUrl: "https://example.test/b" });
    await loader.get(config);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
