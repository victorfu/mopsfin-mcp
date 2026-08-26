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
