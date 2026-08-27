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
      version: "0.6.0",
      toolCount: 17,
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
      sourceUrls: {
        twseExRightDividend:
          "https://www.twse.com.tw/rwd/zh/exRight/TWT49U",
        twseExRightDividendDetail:
          "https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail",
        twseCapitalReduction:
          "https://www.twse.com.tw/rwd/zh/reducation/TWTAUU",
        twseParValueChange:
          "https://www.twse.com.tw/rwd/zh/change/TWTB8U",
        tpexExRightDividend:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ",
        tpexCapitalReduction:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/revivt",
        tpexParValueChange:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt",
        twseMaterialInformation:
          "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
        tpexMaterialInformation:
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
        mopsMaterialInformationHistory:
          "https://mopsov.twse.com.tw/mops/web/ajax_t05st01",
        mopsInvestorConferenceHistory:
          "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
