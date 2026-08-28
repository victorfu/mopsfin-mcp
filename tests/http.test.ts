import { describe, expect, it, vi } from "vitest";

import { MopsfinError } from "@/lib/mopsfin/errors";
import { MopsfinHttpClient } from "@/lib/mopsfin/http";

describe("MopsfinHttpClient", () => {
  it("stamps the completed upstream fetch instead of response assembly time", async () => {
    const client = new MopsfinHttpClient(
      vi.fn().mockResolvedValue(new Response("ok")) as typeof fetch,
      { now: () => new Date("2026-08-26T01:02:03.000Z") },
    );

    await expect(client.get("/")).resolves.toMatchObject({
      retrievedAt: "2026-08-26T01:02:03.000Z",
      cache: {
        status: "bypass",
        observedAt: "2026-08-26T01:02:03.000Z",
        storedAt: null,
        ageMs: null,
        ttlMs: 0,
      },
    });
  });

  it("retries one network failure and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const client = new MopsfinHttpClient(fetchMock as typeof fetch, {
      retryDelayMs: 0,
    });

    await expect(client.get("/")).resolves.toMatchObject({ body: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry ordinary 4xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    const client = new MopsfinHttpClient(fetchMock as typeof fetch, {
      retryDelayMs: 0,
    });

    await expect(client.get("/")).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "UPSTREAM_RATE_LIMITED"],
    [503, "UPSTREAM_BAD_RESPONSE"],
  ])("retries HTTP %s once", async (status, code) => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("unavailable", { status }),
    );
    const client = new MopsfinHttpClient(fetchMock as typeof fetch, {
      retryDelayMs: 0,
    });

    await expect(client.get("/")).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves Retry-After metadata when an HTTP 429 is exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    );
    const client = new MopsfinHttpClient(fetchMock as typeof fetch, {
      maxAttempts: 1,
    });

    await expect(client.get("/")).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      reason: "UPSTREAM_HTTP_429",
      retryable: true,
      retryAfterMs: 2_000,
      action: "retry",
    });
  });

  it("returns structured retryable metadata for exhausted 5xx and network errors", async () => {
    const serverClient = new MopsfinHttpClient(
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })) as typeof fetch,
      { maxAttempts: 1 },
    );
    await expect(serverClient.get("/")).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_HTTP_5XX",
      retryable: true,
      action: "retry",
    });

    const networkClient = new MopsfinHttpClient(
      vi.fn().mockRejectedValue(new TypeError("network")) as typeof fetch,
      { maxAttempts: 1 },
    );
    await expect(networkClient.get("/")).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_NETWORK_ERROR",
      retryable: true,
      action: "retry",
    });
  });

  it("rejects an oversized response without retrying it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("12345"));
    const client = new MopsfinHttpClient(fetchMock as typeof fetch, {
      maxAttempts: 2,
      maxResponseBytes: 4,
      retryDelayMs: 0,
    });

    await expect(client.get("/")).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
      retryable: false,
      action: "none",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts timed-out upstream requests and retries once", async () => {
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    );
    const client = new MopsfinHttpClient(fetchMock as typeof fetch, {
      timeoutMs: 2,
      retryDelayMs: 0,
    });

    await expect(client.get("/")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MopsfinError && error.code === "UPSTREAM_TIMEOUT",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("encodes repeated form values without accepting arbitrary origins", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new MopsfinHttpClient(fetchMock as typeof fetch);

    await client.post("/compare/data", {
      compareItem: "ROE",
      companyId: ["2330 台積電", "2454 聯發科"],
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe("https://mopsfin.twse.com.tw");
    expect(url.pathname).toBe("/compare/data");
    expect((init.body as URLSearchParams).getAll("companyId")).toEqual([
      "2330 台積電",
      "2454 聯發科",
    ]);
    expect(init.headers).not.toHaveProperty("Cookie");
  });
});
