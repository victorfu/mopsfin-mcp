import { describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/health/route";

describe("health route", () => {
  it("stays shallow while exposing bounded in-process reliability state", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      status: "ok",
      version: "0.4.1",
      toolCount: 16,
      readiness: {
        status: "ready",
        upstreamChecks: "not_run",
      },
      telemetry: {
        requests: expect.any(Number),
        toolErrors: expect.any(Number),
      },
      upstreamReliability: {
        counters: {
          backpressureRejected: expect.any(Number),
          deadlineExceeded: expect.any(Number),
          responseLimitExceeded: expect.any(Number),
        },
        semaphore: {
          active: expect.any(Number),
          queued: expect.any(Number),
          maximumConcurrency: 8,
          maximumQueue: 32,
        },
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
