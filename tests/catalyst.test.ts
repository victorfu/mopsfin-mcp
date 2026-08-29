import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CatalystClient } from "@/lib/catalyst/client";
import {
  OfficialHtmlPostLoader,
  type CatalystHtmlPostLoader,
} from "@/lib/catalyst/html-loader";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { BoundedSemaphore } from "@/lib/upstream/reliability";

function textFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

function jsonFixture(name: string): unknown {
  return JSON.parse(textFixture(name)) as unknown;
}

const currentTwse = jsonFixture("catalyst-current-twse.json");
const currentTpex = jsonFixture("catalyst-current-tpex.json");
const materialHistory = textFixture("catalyst-material-history.html");
const conferenceHistory = textFixture("catalyst-conference-history.html");
const materialEmpty = textFixture("catalyst-material-empty.html");
const conferenceEmpty = textFixture("catalyst-conference-empty.html");
const now = () => new Date("2026-08-27T00:00:00.000Z");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function currentFetch(twse: unknown = currentTwse, tpex: unknown = currentTpex) {
  return vi.fn(async (input: URL | RequestInfo) =>
    jsonResponse(String(input).includes("openapi.twse.com.tw") ? twse : tpex),
  );
}

function htmlLoader(
  implementation?: CatalystHtmlPostLoader["post"],
): CatalystHtmlPostLoader & { post: ReturnType<typeof vi.fn> } {
  return {
    post: vi.fn(
      implementation ??
        (async (_name, url, fields) => ({
          body: url.includes("t100sb02_1")
            ? fields.TYPEK === "sii"
              ? conferenceHistory
              : conferenceEmpty
            : materialHistory,
          contentType: "text/html; charset=utf-8",
          retrievedAt: "2026-08-27T00:00:00.000Z",
        })),
    ),
  };
}

describe("CatalystClient current material information", () => {
  it("normalizes official dates, filters companies, deduplicates rows, and fingerprints without retrievedAt", async () => {
    const first = await new CatalystClient(currentFetch() as typeof fetch, now, {
      maxAttempts: 1,
    }).getCurrentMaterialInformation({
      market: "all",
      companyCodes: ["3105", "2330"],
    });

    expect(first.events).toHaveLength(2);
    expect(first.events.find((event) => event.companyCode === "2330")).toMatchObject({
      publishedAt: "2026-08-26T17:45:50+08:00",
      factDate: "2026-08-26",
      status: "announced",
      dateBasis: "publication",
      dateConfidence: "confirmed",
      isConsensus: false,
    });
    expect(first.sources.find((source) => source.market === "listed")).toMatchObject({
      reportDate: "2026-08-27",
      rawRowCount: 3,
      eligibleEventCount: 2,
      duplicateRowCount: 1,
      returnedEventCount: 1,
      snapshotStatus: "nonempty",
    });
    expect(first.selection.withoutEventsCompanyCodes).toEqual([]);

    const later = await new CatalystClient(
      currentFetch() as typeof fetch,
      () => new Date("2026-08-28T00:00:00.000Z"),
      { maxAttempts: 1 },
    ).getCurrentMaterialInformation({
      market: "all",
      companyCodes: ["3105", "2330"],
    });
    expect(later.fingerprint).toBe(first.fingerprint);
  });

  it("fails closed on an unverified empty JSON array", async () => {
    const client = new CatalystClient(currentFetch([]) as typeof fetch, now, {
      maxAttempts: 1,
    });

    await expect(
      client.getCurrentMaterialInformation({ market: "listed" }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_UNVERIFIED_EMPTY",
      retryable: true,
    });
  });

  it("accepts only the official blank-sentinel shape as verified empty", async () => {
    const client = new CatalystClient(
      currentFetch([
        {
          出表日期: "",
          發言日期: "",
          發言時間: "",
          公司代號: "",
          公司名稱: "",
          "主旨 ": "",
          符合條款: "",
          事實發生日: "",
          說明: "",
        },
      ]) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );
    const result = await client.getCurrentMaterialInformation({
      market: "listed",
    });

    expect(result.events).toEqual([]);
    expect(result.sources[0]).toMatchObject({
      snapshotStatus: "verified_empty",
      emptyVerification: "official_blank_sentinel",
    });
  });

  it("rejects an all-blank object that does not match the exact source sentinel schema", async () => {
    const client = new CatalystClient(
      currentFetch([{ message: "" }]) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    await expect(
      client.getCurrentMaterialInformation({ market: "listed" }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
    });
  });
});

describe("CatalystClient selected-company history", () => {
  it("keeps publication and scheduled timestamps separate across material and IR events", async () => {
    const loader = htmlLoader();
    const client = new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
    });

    const result = await client.getCompanyCatalystEvents({
      companyCodes: ["2330"],
      companyMarkets: [{ companyCode: "2330", market: "listed" }],
      startDate: "2025-10-01",
      endDate: "2025-10-31",
      eventTypes: ["material_information", "investor_conference"],
      offset: 0,
      limit: 10,
    });

    expect(result.events).toHaveLength(2);
    expect(
      result.events.find((event) => event.eventType === "material_information"),
    ).toMatchObject({
      publishedAt: "2025-10-16T16:08:07+08:00",
      factDate: null,
      scheduledAt: null,
      market: "listed",
      datePrecision: "second",
    });
    expect(
      result.events.find((event) => event.eventType === "investor_conference"),
    ).toMatchObject({
      publishedAt: null,
      scheduledAt: "2025-10-16T14:00:00+08:00",
      status: "scheduled",
      datePrecision: "minute",
      eventDetails: {
        location: "線上法說會",
        presentationZhFileName: "233020251016M001.pdf",
        presentationEnFileName: "233020251016E001.pdf",
        companyIrUrl:
          "https://investor.tsmc.com/chinese/quarterly-results/2025/q3",
      },
    });
    expect(result.coverage.sourceComplete).toBe(true);
    expect(result.workBudget).toMatchObject({
      historicalLogicalUnits: 2,
      historicalUpstreamRequests: 3,
      currentSnapshotRequests: 0,
      plannedUpstreamRequests: 3,
      upstreamRequestLimit: 40,
    });
    expect(result.sources).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(loader.post).toHaveBeenCalledTimes(3);
    expect(
      loader.post.mock.calls
        .filter((call) => String(call[1]).includes("t100sb02_1"))
        .map((call) => call[2].TYPEK)
        .sort(),
    ).toEqual(["otc", "sii"]);
  });

  it("treats exact MOPS no-data markers as verified empty, not source failure", async () => {
    const loader = htmlLoader(async (_name, url) => ({
      body: url.includes("t100sb02_1") ? conferenceEmpty : materialEmpty,
      contentType: "text/html",
      retrievedAt: "2026-08-27T00:00:00.000Z",
    }));
    const result = await new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
    }).getCompanyCatalystEvents({
      companyCodes: ["2330"],
      companyMarkets: [{ companyCode: "2330", market: "listed" }],
      startDate: "2025-10-01",
      endDate: "2025-10-31",
      eventTypes: ["material_information", "investor_conference"],
    });

    expect(result.events).toEqual([]);
    expect(result.coverage.sourceComplete).toBe(true);
    expect(result.familyCoverage.every((family) => family.status === "complete")).toBe(
      true,
    );
    expect(
      result.familyCoverage.every(
        (family) =>
          family.verifiedEmptyRequestCount ===
          (family.eventType === "investor_conference" ? 2 : 1),
      ),
    ).toBe(true);
    expect(result.sources.every((source) => source.acceptedEventCount === 0)).toBe(
      true,
    );
  });

  it("isolates one company failure while retaining another verified company", async () => {
    const loader = htmlLoader(async (_name, _url, fields) => {
      if (fields.co_id === "2454") {
        throw new MopsfinError("UPSTREAM_TIMEOUT", "fixture timeout", {
          reason: "UPSTREAM_ATTEMPT_TIMEOUT",
          retryable: true,
          retryAfterMs: 500,
          action: "retry",
        });
      }
      return {
        body: materialHistory,
        contentType: "text/html",
        retrievedAt: "2026-08-27T00:00:00.000Z",
      };
    });
    const result = await new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
    }).getCompanyCatalystEvents({
      companyCodes: ["2330", "2454"],
      startDate: "2025-10-01",
      endDate: "2025-10-31",
      eventTypes: ["material_information"],
    });

    expect(result.events).toHaveLength(1);
    expect(result.companies).toEqual([
      expect.objectContaining({ companyCode: "2330", status: "complete" }),
      expect.objectContaining({ companyCode: "2454", status: "failed" }),
    ]);
    expect(result.coverage.sourceComplete).toBe(false);
    expect(result.failures[0]).toMatchObject({
      companyCode: "2454",
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_ATTEMPT_TIMEOUT",
      retryable: true,
      retryAfterMs: 500,
      action: "retry",
    });
  });

  it("fails the whole call when every source is a security block", async () => {
    const loader = htmlLoader(async () => ({
      body: "<html><head><title>Access Denied</title></head><body>Request Rejected</body></html>",
      contentType: "text/html",
      retrievedAt: "2026-08-27T00:00:00.000Z",
    }));
    const client = new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
    });

    await expect(
      client.getCompanyCatalystEvents({
        companyCodes: ["2330"],
        startDate: "2025-10-01",
        endDate: "2025-10-31",
        eventTypes: ["material_information"],
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "ALL_CATALYST_SOURCES_FAILED",
    });
  });

  it("enforces the aggregate official request budget before loading", async () => {
    const loader = htmlLoader();
    const client = new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
    });

    await expect(
      client.getCompanyCatalystEvents({
        companyCodes: ["1101", "1216", "1301", "2002", "2330"],
        startDate: "2025-01-01",
        endDate: "2025-04-30",
        eventTypes: ["material_information", "investor_conference"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(loader.post).not.toHaveBeenCalled();
  });

  it("shares one bounded scheduler across all historical families", async () => {
    let active = 0;
    let maximumActive = 0;
    const loader = htmlLoader(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        body: materialEmpty,
        contentType: "text/html",
        retrievedAt: "2026-08-27T00:00:00.000Z",
      };
    });
    const companyCodes = Array.from({ length: 20 }, (_, index) =>
      String(1101 + index),
    );

    const result = await new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
    }).getCompanyCatalystEvents({
      companyCodes,
      startDate: "2025-10-01",
      endDate: "2025-10-31",
      eventTypes: ["material_information"],
    });

    expect(loader.post).toHaveBeenCalledTimes(20);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(result.failures).toEqual([]);
    expect(result.familyCoverage.map((row) => row.companyCode)).toEqual(
      companyCodes,
    );
  });

  it("completes a 40-unit query while one global upstream slot is occupied", async () => {
    const semaphore = new BoundedSemaphore(8, 32);
    const releaseOccupiedSlot = await semaphore.acquire();
    const fetchMock = vi.fn(async () =>
      new Response(materialEmpty, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const companyCodes = Array.from({ length: 20 }, (_, index) =>
      String(1101 + index),
    );
    try {
      const result = await new CatalystClient(fetchMock as typeof fetch, now, {
        maxAttempts: 1,
        cacheTtlMs: 0,
        htmlLoaderOptions: {
          maxAttempts: 1,
          cacheTtlMs: 0,
          semaphore,
        },
      }).getCompanyCatalystEvents({
        companyCodes,
        startDate: "2025-09-01",
        endDate: "2025-10-31",
        eventTypes: ["material_information"],
      });

      expect(fetchMock).toHaveBeenCalledTimes(40);
      expect(result.workBudget.plannedUpstreamRequests).toBe(40);
      expect(result.failures).toEqual([]);
      expect(result.familyCoverage.every((row) => row.status === "complete")).toBe(
        true,
      );
    } finally {
      releaseOccupiedSlot();
    }
  });

  it("merges the current OpenAPI snapshot for a range intersecting current publications", async () => {
    const loader = htmlLoader(async () => ({
      body: materialEmpty,
      contentType: "text/html",
      retrievedAt: "2026-08-27T00:00:00.000Z",
    }));
    const result = await new CatalystClient(currentFetch() as typeof fetch, now, {
      htmlLoader: loader,
      maxAttempts: 1,
    }).getCompanyCatalystEvents({
      companyCodes: ["2330"],
      companyMarkets: [{ companyCode: "2330", market: "listed" }],
      startDate: "2026-08-26",
      endDate: "2026-08-26",
      eventTypes: ["material_information"],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].sourceKey).toBe(
      "twse_material_information_current",
    );
    expect(result.sources.map((source) => source.sourceKey)).toEqual([
      "mops_material_information_history",
      "twse_material_information_current",
    ]);
    expect(result.workBudget.currentSnapshotRequests).toBe(1);
    expect(result.coverage.currentSnapshots).toEqual([
      expect.objectContaining({
        sourceKey: "twse_material_information_current",
        market: "listed",
        status: "complete",
        affectedCompanyCodes: ["2330"],
        eventCount: 1,
        failures: [],
      }),
    ]);
  });

  it("keeps distinct current disclosures that share the same timestamp and title", async () => {
    const first = (currentTwse as Array<Record<string, unknown>>)[0];
    const twoDistinctRows = [
      first,
      {
        ...first,
        說明: "同一時間與主旨的另一筆官方說明。",
      },
    ];
    const loader = htmlLoader(async () => ({
      body: materialEmpty,
      contentType: "text/html",
      retrievedAt: "2026-08-27T00:00:00.000Z",
    }));
    const result = await new CatalystClient(
      currentFetch(twoDistinctRows) as typeof fetch,
      now,
      { htmlLoader: loader, maxAttempts: 1 },
    ).getCompanyCatalystEvents({
      companyCodes: ["2330"],
      companyMarkets: [{ companyCode: "2330", market: "listed" }],
      startDate: "2026-08-26",
      endDate: "2026-08-26",
      eventTypes: ["material_information"],
    });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.description)).toEqual(
      expect.arrayContaining([
        "同一時間與主旨的另一筆官方說明。",
        "董事會通過重要營運事項。",
      ]),
    );
  });

  it("isolates a failed current snapshot with a contract-valid calendar month", async () => {
    const failingCurrentFetch = vi.fn(async () => {
      throw new TypeError("fixture current snapshot network failure");
    });
    const loader = htmlLoader(async () => ({
      body: materialEmpty,
      contentType: "text/html",
      retrievedAt: "2026-08-27T00:00:00.000Z",
    }));
    const result = await new CatalystClient(
      failingCurrentFetch as typeof fetch,
      now,
      { htmlLoader: loader, maxAttempts: 1 },
    ).getCompanyCatalystEvents({
      companyCodes: ["2330"],
      companyMarkets: [{ companyCode: "2330", market: "listed" }],
      startDate: "2026-08-26",
      endDate: "2026-08-26",
      eventTypes: ["material_information"],
    });

    expect(result.coverage.sourceComplete).toBe(false);
    expect(result.companies[0]).toMatchObject({
      companyCode: "2330",
      status: "partial",
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyCode: "2330",
        eventType: "material_information",
        market: "listed",
        queryMonth: "2026-08",
        retryable: true,
      }),
    ]);
    expect(result.coverage.currentSnapshots).toEqual([
      expect.objectContaining({
        sourceKey: "twse_material_information_current",
        market: "listed",
        status: "failed",
        affectedCompanyCodes: ["2330"],
        failures: result.failures,
      }),
    ]);
  });
});

describe("OfficialHtmlPostLoader", () => {
  it("single-flights and caches normalized POST fields for five minutes", async () => {
    let clockMs = Date.parse("2026-08-26T00:00:00.000Z");
    const clock = () => new Date(clockMs);
    const fetchMock = vi.fn(async () =>
      new Response(materialEmpty, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const loader = new OfficialHtmlPostLoader(fetchMock as typeof fetch, clock, {
      maxAttempts: 1,
    });
    const url = "https://mopsov.twse.com.tw/mops/web/ajax_t05st01";

    const [first, second] = await Promise.all([
      loader.post("fixture", url, { co_id: "2330", year: "114" }),
      loader.post("fixture", url, { year: "114", co_id: "2330" }),
    ]);
    clockMs += 3_000;
    const third = await loader.post("fixture", url, {
      co_id: "2330",
      year: "114",
    });

    expect(first.body).toBe(materialEmpty);
    expect(second.body).toBe(materialEmpty);
    expect(third.body).toBe(materialEmpty);
    expect(first.cache).toMatchObject({
      status: "miss",
      storedAt: "2026-08-26T00:00:00.000Z",
      ageMs: 0,
      ttlMs: 300_000,
    });
    expect(second.cache?.status).toBe("shared");
    expect(third).toMatchObject({
      retrievedAt: first.retrievedAt,
      cache: {
        status: "hit",
        observedAt: "2026-08-26T00:00:03.000Z",
        storedAt: "2026-08-26T00:00:00.000Z",
        ageMs: 3_000,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes a retry delay that exceeds the shared deadline", async () => {
    const loader = new OfficialHtmlPostLoader(
      vi.fn(async () => new Response("busy", { status: 503 })) as typeof fetch,
      now,
      {
        deadlineMs: 10,
        maxAttempts: 2,
        retryDelayMs: 100,
        cacheTtlMs: 0,
      },
    );

    await expect(
      loader.post(
        "fixture",
        "https://mopsov.twse.com.tw/mops/web/ajax_t05st01",
        { co_id: "2330", year: "115" },
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_DEADLINE_EXCEEDED",
    });
  });

  it("rejects non-allowlisted origins before fetch", async () => {
    const fetchMock = vi.fn();
    const loader = new OfficialHtmlPostLoader(fetchMock as typeof fetch, now);

    await expect(
      loader.post("fixture", "https://example.test/mops", { co_id: "2330" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
