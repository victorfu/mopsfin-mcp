import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CorporateActionClient } from "@/lib/corporate-actions/client";
import { BoundedSemaphore } from "@/lib/upstream/reliability";

interface CorporateActionFixtures {
  exRight: Record<string, unknown>;
  capitalReduction: Record<string, unknown>;
  parValueChange: Record<string, unknown>;
  exRightDetail2317?: Record<string, unknown>;
}

interface EmptyCorporateActionFixtures {
  listed: CorporateActionFixtures;
  otc: CorporateActionFixtures;
}

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const twseFixture = fixture<CorporateActionFixtures>(
  "corporate-actions-twse.json",
);
const tpexFixture = fixture<CorporateActionFixtures>(
  "corporate-actions-tpex.json",
);
const emptyFixture = fixture<EmptyCorporateActionFixtures>(
  "corporate-actions-empty.json",
);
const now = () => new Date("2026-08-27T00:00:00.000Z");

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fixtureFetch(
  listed: CorporateActionFixtures = twseFixture,
  otc: CorporateActionFixtures = tpexFixture,
) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("TWT49UDetail")) {
      return response(listed.exRightDetail2317);
    }
    if (url.includes("/exRight/TWT49U?")) return response(listed.exRight);
    if (url.includes("/reducation/TWTAUU?")) {
      return response(listed.capitalReduction);
    }
    if (url.includes("/change/TWTB8U?")) {
      return response(listed.parValueChange);
    }
    if (url.includes("/bulletin/exDailyQ?")) return response(otc.exRight);
    if (url.includes("/bulletin/revivt?")) {
      return response(otc.capitalReduction);
    }
    if (url.includes("/bulletin/pvChgRslt?")) {
      return response(otc.parValueChange);
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  });
}

function eventByCode<T extends { companyCode: string }>(events: T[], code: string): T {
  const event = events.find((candidate) => candidate.companyCode === code);
  if (!event) throw new Error(`missing fixture event ${code}`);
  return event;
}

describe("CorporateActionClient", () => {
  it("normalizes TWSE event families and only fetches selected combined-event detail", async () => {
    const fetchMock = fixtureFetch();
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
    });

    const result = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
      { companyCodes: ["2371", "2317", "2330", "2327", "2303"] },
    );

    expect(result.coverage).toMatchObject({
      status: "complete",
      coverageComplete: true,
      gaps: [],
    });
    expect(result.filteredCompanyCodes).toEqual([
      "2303",
      "2317",
      "2327",
      "2330",
      "2371",
    ]);
    expect(result.events).toHaveLength(5);
    expect(result.requestCount).toBe(4);
    expect(eventByCode(result.events, "2330")).toMatchObject({
      kind: "cash_dividend",
      cashDividendPerShareTwd: 10,
      priceIndexAdjustmentFactor: 1,
      shareCountChanged: false,
      adjustmentStatus: "available",
    });
    expect(eventByCode(result.events, "2303")).toMatchObject({
      kind: "stock_rights",
      cashDividendPerShareTwd: 0,
      priceIndexAdjustmentFactor: 0.9,
      shareCountChanged: true,
    });
    expect(eventByCode(result.events, "2317")).toMatchObject({
      kind: "rights_and_dividend",
      cashDividendPerShareTwd: 3,
      adjustmentStatus: "available",
    });
    expect(
      eventByCode(result.events, "2317").priceIndexAdjustmentFactor,
    ).toBeCloseTo(88 / (100 - 3), 12);
    expect(eventByCode(result.events, "2371").priceIndexAdjustmentFactor).toBe(
      1.25,
    );
    expect(eventByCode(result.events, "2327").priceIndexAdjustmentFactor).toBe(
      0.1,
    );
    expect(result.sources.map((source) => source.scope)).toEqual([
      "range_summary",
      "range_summary",
      "range_summary",
      "event_detail",
    ]);
    expect(result.sources[0]).toMatchObject({
      rawRowCount: 4,
      companyEventCount: 3,
      officialDeclaredRowCountAvailable: false,
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const secondPage = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
      { companyCodes: ["2330"] },
    );
    expect(secondPage.fingerprint).not.toBe(result.fingerprint);
    expect(secondPage.events.map((event) => event.companyCode)).toEqual(["2330"]);
    const laterRetrieval = await new CorporateActionClient(
      fixtureFetch() as typeof fetch,
      () => new Date("2026-08-28T00:00:00.000Z"),
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2371", "2317", "2330", "2327", "2303"],
    });
    expect(laterRetrieval.fingerprint).toBe(result.fingerprint);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("TWT49UDetail"),
      ),
    ).toHaveLength(1);
  });

  it("interprets TWSE summary values by event kind before numeric validation", async () => {
    const listed = structuredClone(twseFixture);
    const rows = listed.exRight.data as unknown[][];
    (rows.find((row) => row[1] === "2303") as unknown[])[5] = "-5.000000";
    (rows.find((row) => row[1] === "2317") as unknown[])[5] = "-12.000000";
    const client = new CorporateActionClient(
      fixtureFetch(listed) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    const result = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
      { companyCodes: ["2303", "2317", "2330"] },
    );

    expect(eventByCode(result.events, "2330")).toMatchObject({
      kind: "cash_dividend",
      cashDividendPerShareTwd: 10,
      priceIndexAdjustmentFactor: 1,
    });
    expect(eventByCode(result.events, "2303")).toMatchObject({
      kind: "stock_rights",
      cashDividendPerShareTwd: 0,
      priceIndexAdjustmentFactor: 0.9,
    });
    expect(eventByCode(result.events, "2317")).toMatchObject({
      kind: "rights_and_dividend",
      cashDividendPerShareTwd: 3,
      adjustmentStatus: "available",
    });
  });

  it("isolates invalid numeric fields outside the requested company scope", async () => {
    const listed = structuredClone(twseFixture);
    const exRightRows = listed.exRight.data as unknown[][];
    (exRightRows.find((row) => row[1] === "2303") as unknown[])[3] = "invalid";
    (exRightRows.find((row) => row[1] === "2317") as unknown[])[4] = "invalid";
    (listed.capitalReduction.data as unknown[][])[0][3] = "invalid";
    (listed.parValueChange.data as unknown[][])[0][4] = "invalid";
    const client = new CorporateActionClient(
      fixtureFetch(listed) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    const isolated = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
      { companyCodes: ["2330"] },
    );

    expect(isolated.events).toEqual([
      expect.objectContaining({
        companyCode: "2330",
        kind: "cash_dividend",
        adjustmentStatus: "available",
      }),
    ]);
    expect(isolated.sources.map((source) => source.companyEventCount)).toEqual([
      3,
      1,
      1,
    ]);

    await expect(
      client.getHistory("listed", "2025-07-01", "2025-07-10", {
        companyCodes: ["2303"],
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it("fingerprints selected TWSE combined-event detail evidence without retrievedAt", async () => {
    const baseline = await new CorporateActionClient(
      fixtureFetch() as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2317"],
    });
    const laterRetrieval = await new CorporateActionClient(
      fixtureFetch() as typeof fetch,
      () => new Date("2026-08-28T00:00:00.000Z"),
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2317"],
    });
    expect(laterRetrieval.fingerprint).toBe(baseline.fingerprint);

    const revised = structuredClone(twseFixture);
    const detailRows = revised.exRightDetail2317?.data as unknown[][];
    detailRows[0][2] = "4 元／股";
    const changed = await new CorporateActionClient(
      fixtureFetch(revised) as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2317"],
    });
    expect(changed.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("does not fan out TWSE detail calls without a company filter", async () => {
    const fetchMock = fixtureFetch();
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
    });

    const result = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
    );

    expect(eventByCode(result.events, "2317")).toMatchObject({
      adjustmentStatus: "unavailable",
      adjustmentReason: "twse_combined_event_detail_not_requested",
      priceIndexAdjustmentFactor: null,
    });
    expect(result.warnings).toContain(
      "未提供 companyCodes；為避免對全市場逐筆呼叫 detail，TWSE 權息事件不補抓現金股利，priceIndexAdjustmentFactor 保留 unavailable。",
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("TWT49UDetail"),
      ),
    ).toBe(false);
  });

  it("isolates one selected TWSE combined-event detail failure", async () => {
    const baseFetch = fixtureFetch();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("TWT49UDetail")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return baseFetch(input);
    });
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
    });

    const result = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
      { companyCodes: ["2317", "2330"] },
    );

    expect(eventByCode(result.events, "2317")).toMatchObject({
      adjustmentStatus: "unavailable",
      adjustmentReason: "twse_combined_event_detail_failed",
      priceIndexAdjustmentFactor: null,
    });
    expect(eventByCode(result.events, "2330")).toMatchObject({
      adjustmentStatus: "available",
      priceIndexAdjustmentFactor: 1,
    });
    expect(result.sources).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("2317 2025-07-03 權息 detail 查詢失敗");
    expect(result.requestCount).toBe(4);

    const recovered = await new CorporateActionClient(
      fixtureFetch() as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2317", "2330"],
    });
    expect(recovered.fingerprint).not.toBe(result.fingerprint);
  });

  it("bounds large selected TWSE combined-event detail fan-out without self-backpressure", async () => {
    const listed = structuredClone(twseFixture);
    const companyCodes = Array.from({ length: 41 }, (_, index) =>
      String(1001 + index),
    );
    const names = new Map(
      companyCodes.map((companyCode) => [
        companyCode,
        `公司${companyCode}`,
      ]),
    );
    listed.exRight = {
      ...listed.exRight,
      data: companyCodes.map((companyCode) => [
        "114年07月03日",
        companyCode,
        names.get(companyCode),
        "100.00",
        "88.00",
        "12.000000",
        "權息",
      ]),
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/TWT49UDetail")) {
        const companyCode = url.searchParams.get("STK_NO") as string;
        return response({
          stat: "ok",
          fields: [
            "股票代號",
            "股票名稱",
            "(每股配發現金股利)除息",
          ],
          data: [[companyCode, names.get(companyCode), "3 元／股"]],
        });
      }
      if (url.pathname.endsWith("/TWT49U")) {
        return response(listed.exRight);
      }
      if (url.pathname.endsWith("/TWTAUU")) {
        return response(listed.capitalReduction);
      }
      if (url.pathname.endsWith("/TWTB8U")) {
        return response(listed.parValueChange);
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    });
    const client = new CorporateActionClient(
      fetchMock as typeof fetch,
      now,
      {
        maxAttempts: 1,
        cacheTtlMs: 0,
        semaphore: new BoundedSemaphore(2, 2),
      },
    );

    const result = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
      { companyCodes },
    );

    expect(result.events).toHaveLength(companyCodes.length);
    expect(
      result.events.every(
        (event) =>
          event.adjustmentStatus === "available" &&
          event.adjustmentReason ===
            "official_reference_price_divided_by_prior_close_less_cash_dividend",
      ),
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("detail 查詢失敗")),
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3 + companyCodes.length);
  });

  it("aborts and drains sibling range loads after the first required source fails", async () => {
    const siblingSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        if (String(input).includes("/exRight/TWT49U?")) {
          return new Response("bad request", { status: 400 });
        }
        const signal = init?.signal as AbortSignal;
        siblingSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    );
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
      cacheTtlMs: 0,
    });

    await expect(
      client.getHistory("listed", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
    expect(siblingSignals).toHaveLength(2);
    expect(siblingSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("normalizes TPEx declared counts, encoded dates and price-index factors", async () => {
    const fetchMock = fixtureFetch();
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
    });

    const result = await client.getHistory(
      "otc",
      "2025-07-01",
      "2025-07-10",
    );

    expect(result.coverage.coverageComplete).toBe(true);
    expect(result.sources).toHaveLength(3);
    expect(result.sources.every((source) => source.officialDeclaredRowCountAvailable)).toBe(
      true,
    );
    expect(eventByCode(result.events, "6488")).toMatchObject({
      kind: "cash_dividend",
      cashDividendPerShareTwd: 5,
      priceIndexAdjustmentFactor: 1,
    });
    expect(eventByCode(result.events, "4109").priceIndexAdjustmentFactor).toBe(
      0.9,
    );
    expect(eventByCode(result.events, "5009").priceIndexAdjustmentFactor).toBeCloseTo(
      88 / (100 - 2),
      12,
    );
    expect(eventByCode(result.events, "3290").priceIndexAdjustmentFactor).toBeCloseTo(
      36.64 / 28.65,
      12,
    );
    expect(eventByCode(result.events, "5314").priceIndexAdjustmentFactor).toBe(
      0.05,
    );
    expect(
      fetchMock.mock.calls.every(([input]) =>
        String(input).includes("startDate=2025%2F07%2F01"),
      ),
    ).toBe(true);
  });

  it("clamps each family and starts an unverified-empty runtime gap at queryStart", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const start = url.searchParams.get("startDate") as string;
      const end = url.searchParams.get("endDate") as string;
      if (url.pathname.includes("TWT49U")) {
        return response({
          stat: "OK",
          fields: [
            "資料日期",
            "股票代號",
            "股票名稱",
            "除權息前收盤價",
            "除權息參考價",
            "權值+息值",
            "權/息",
          ],
          data: [],
          strDate: start,
          endDate: end,
        });
      }
      if (url.pathname.includes("TWTAUU")) {
        return response({ stat: "很抱歉，沒有符合條件的資料!" });
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    });
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
    });

    const result = await client.getHistory(
      "listed",
      "2010-12-30",
      "2011-01-03",
    );

    expect(result.coverage).toMatchObject({
      status: "partial",
      coverageComplete: false,
      gaps: [
        {
          family: "capital_reduction",
          requestedStart: "2010-12-30",
          uncoveredThrough: "2010-12-31",
          supportedFrom: "2011-01-01",
        },
        {
          family: "par_value_change",
          requestedStart: "2010-12-30",
          uncoveredThrough: "2011-01-03",
          supportedFrom: "2019-09-09",
        },
        {
          family: "capital_reduction",
          requestedStart: "2011-01-01",
          uncoveredThrough: "2011-01-03",
          supportedFrom: "2011-01-01",
          reason: "unverified_empty_response",
          queryStart: "2011-01-01",
          queryEnd: "2011-01-03",
        },
      ],
    });
    expect(result.sources.map((source) => [source.family, source.queryStart])).toEqual([
      ["ex_right_dividend", "2010-12-30"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deterministically collapses identical official revisions while retaining raw counts", async () => {
    const identicalRevision = structuredClone(twseFixture);
    const revisedRows = identicalRevision.capitalReduction.data as unknown[][];
    revisedRows.push(structuredClone(revisedRows[0]));
    const baseline = await new CorporateActionClient(
      fixtureFetch() as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2371"],
    });
    const collapsed = await new CorporateActionClient(
      fixtureFetch(identicalRevision) as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10", {
      companyCodes: ["2371"],
    });

    expect(collapsed.events).toHaveLength(1);
    expect(collapsed.events[0]).toEqual(baseline.events[0]);
    expect(
      collapsed.sources.find(
        (source) => source.family === "capital_reduction",
      ),
    ).toMatchObject({ rawRowCount: 2, companyEventCount: 1 });
    expect(collapsed.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("fails closed on response range, row-count, row-scope, identity and duplicate conflicts", async () => {
    const mismatchedRange = structuredClone(twseFixture);
    mismatchedRange.exRight.strDate = "20250702";
    await expect(
      new CorporateActionClient(
        fixtureFetch(mismatchedRange) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).getHistory("listed", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const badCount = structuredClone(tpexFixture);
    const badCountTables = badCount.exRight.tables as Array<Record<string, unknown>>;
    badCountTables[0].totalCount = 99;
    await expect(
      new CorporateActionClient(
        fixtureFetch(twseFixture, badCount) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).getHistory("otc", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const outOfScope = structuredClone(twseFixture);
    const scopedRows = outOfScope.exRight.data as unknown[][];
    scopedRows[0][0] = "114年06月30日";
    await expect(
      new CorporateActionClient(
        fixtureFetch(outOfScope) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).getHistory("listed", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const badIdentity = structuredClone(twseFixture);
    const identityRows = badIdentity.exRight.data as unknown[][];
    identityRows[0][1] = "BAD";
    await expect(
      new CorporateActionClient(
        fixtureFetch(badIdentity) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).getHistory("listed", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const duplicate = structuredClone(twseFixture);
    const duplicateRows = duplicate.exRight.data as unknown[][];
    duplicateRows.push(structuredClone(duplicateRows[0]));
    duplicateRows.at(-1)![4] = "989.00";
    await expect(
      new CorporateActionClient(
        fixtureFetch(duplicate) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).getHistory("listed", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it("rejects a non-positive or non-finite factor instead of returning it", async () => {
    const invalidFactor = structuredClone(tpexFixture);
    const tables = invalidFactor.exRight.tables as Array<Record<string, unknown>>;
    const rows = tables[0].data as unknown[][];
    rows[2][6] = "100.00";
    const client = new CorporateActionClient(
      fixtureFetch(twseFixture, invalidFactor) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    await expect(
      client.getHistory("otc", "2025-07-01", "2025-07-10"),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it.each([
    ["listed", "ex_right_dividend", "unverified_empty"],
    ["listed", "capital_reduction", "unverified_empty"],
    ["listed", "par_value_change", "verified_empty"],
    ["otc", "ex_right_dividend", "verified_empty"],
    ["otc", "capital_reduction", "verified_empty"],
    ["otc", "par_value_change", "verified_empty"],
  ] as const)(
    "classifies %s %s official empty contract as %s",
    async (market, family, expectedStatus) => {
      const result = await new CorporateActionClient(
        fixtureFetch(emptyFixture.listed, emptyFixture.otc) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).probeRangeContract(market, family, "2025-07-05", "2025-07-05");

      expect(result).toMatchObject({
        status: expectedStatus,
        market,
        family,
        queryStart: "2025-07-05",
        queryEnd: "2025-07-05",
        events: [],
      });
      if (expectedStatus === "unverified_empty") {
        expect(result).toMatchObject({
          responseRangeVerified: false,
          source: null,
          upstreamStatus: "很抱歉，沒有符合條件的資料!",
        });
      } else {
        expect(result.responseRangeVerified).toBe(true);
        expect(result.source).toMatchObject({
          market,
          family,
          queryStart: "2025-07-05",
          queryEnd: "2025-07-05",
          responseStart: "2025-07-05",
          responseEnd: "2025-07-05",
          rawRowCount: 0,
        });
      }
    },
  );

  it("fails closed when a known TWSE no-data status contradicts nonempty rows or counts", async () => {
    const withRows = structuredClone(emptyFixture.listed);
    withRows.exRight.data = [["unexpected official row"]];
    await expect(
      new CorporateActionClient(
        fixtureFetch(withRows, emptyFixture.otc) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).probeRangeContract(
        "listed",
        "ex_right_dividend",
        "2025-07-05",
        "2025-07-05",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const withCount = structuredClone(emptyFixture.listed);
    withCount.capitalReduction.data = [];
    withCount.capitalReduction.totalCount = 1;
    await expect(
      new CorporateActionClient(
        fixtureFetch(withCount, emptyFixture.otc) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).probeRangeContract(
        "listed",
        "capital_reduction",
        "2025-07-05",
        "2025-07-05",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it("classifies contract nonempty from raw rows even when no row is an eligible company", async () => {
    const listed = structuredClone(twseFixture);
    const rawRows = listed.exRight.data as unknown[][];
    listed.exRight.data = [
      structuredClone(
        rawRows.find((row) => row[1] === "00900") as unknown[],
      ),
    ];
    const result = await new CorporateActionClient(
      fixtureFetch(listed) as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).probeRangeContract(
      "listed",
      "ex_right_dividend",
      "2025-07-01",
      "2025-07-10",
    );

    expect(result).toMatchObject({
      status: "nonempty",
      events: [],
      source: {
        rawRowCount: 1,
        companyEventCount: 0,
      },
    });
  });

  it("keeps verified peer families when TWSE returns an unverified empty range", async () => {
    const listed = structuredClone(twseFixture);
    listed.exRight = structuredClone(emptyFixture.listed.exRight);
    const client = new CorporateActionClient(
      fixtureFetch(listed) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );

    const partial = await client.getHistory(
      "listed",
      "2025-07-01",
      "2025-07-10",
    );

    expect(partial.coverage).toMatchObject({
      status: "partial",
      coverageComplete: false,
      gaps: [
        {
          market: "listed",
          family: "ex_right_dividend",
          reason: "unverified_empty_response",
          queryStart: "2025-07-01",
          queryEnd: "2025-07-10",
          upstreamStatus: "很抱歉，沒有符合條件的資料!",
        },
      ],
    });
    expect(partial.events.map((event) => event.companyCode)).toEqual([
      "2371",
      "2327",
    ]);
    expect(partial.sources.map((source) => source.family)).toEqual([
      "capital_reduction",
      "par_value_change",
    ]);
    expect(partial.requestCount).toBe(3);
    expect(partial.warnings.join(" ")).toContain("不得視為已驗證無事件");

    const verified = structuredClone(listed);
    verified.exRight = {
      stat: "OK",
      fields: [
        "資料日期",
        "股票代號",
        "股票名稱",
        "除權息前收盤價",
        "除權息參考價",
        "權值+息值",
        "權/息",
      ],
      data: [],
      strDate: "20250701",
      endDate: "20250710",
    };
    const complete = await new CorporateActionClient(
      fixtureFetch(verified) as typeof fetch,
      now,
      { maxAttempts: 1 },
    ).getHistory("listed", "2025-07-01", "2025-07-10");
    expect(complete.coverage.coverageComplete).toBe(true);
    expect(complete.fingerprint).not.toBe(partial.fingerprint);
  });

  it("probes TWSE combined detail through the production normalizer", async () => {
    const fetchMock = fixtureFetch();
    const client = new CorporateActionClient(fetchMock as typeof fetch, now, {
      maxAttempts: 1,
    });
    const summary = await client.probeRangeContract(
      "listed",
      "ex_right_dividend",
      "2025-07-01",
      "2025-07-10",
    );
    expect(summary.status).toBe("nonempty");
    const event = eventByCode(summary.events, "2317");

    const detail = await client.probeTwseCombinedDetailContract(event);

    expect(detail.event).toMatchObject({
      companyCode: "2317",
      kind: "rights_and_dividend",
      cashDividendPerShareTwd: 3,
      adjustmentStatus: "available",
    });
    expect(detail.source).toMatchObject({
      scope: "event_detail",
      family: "ex_right_dividend",
      responseStart: null,
      responseEnd: null,
      rawRowCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["listed", "ex_right_dividend", "權/息"],
    ["listed", "capital_reduction", "減資原因"],
    ["listed", "par_value_change", "恢復買賣參考價"],
    ["otc", "ex_right_dividend", "現金股利"],
    ["otc", "capital_reduction", "減資原因"],
    ["otc", "par_value_change", "恢復買賣開始參考價"],
  ] as const)(
    "fails closed when %s %s required field %s drifts",
    async (market, family, requiredHeader) => {
      const listed = structuredClone(twseFixture);
      const otc = structuredClone(tpexFixture);
      const key =
        family === "ex_right_dividend"
          ? "exRight"
          : family === "capital_reduction"
            ? "capitalReduction"
            : "parValueChange";
      const payload = (market === "listed" ? listed : otc)[key];
      const fields =
        market === "listed"
          ? (payload.fields as string[])
          : (((payload.tables as Array<Record<string, unknown>>)[0]
              .fields as string[]));
      const index = fields.indexOf(requiredHeader);
      expect(index).toBeGreaterThanOrEqual(0);
      fields[index] = `${requiredHeader}（契約漂移）`;
      const client = new CorporateActionClient(
        fixtureFetch(listed, otc) as typeof fetch,
        now,
        { maxAttempts: 1 },
      );

      await expect(
        client.probeRangeContract(
          market,
          family,
          "2025-07-01",
          "2025-07-10",
        ),
      ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
    },
  );

  it("fails closed on unknown non-success status and TWSE detail schema drift", async () => {
    const unknown = structuredClone(twseFixture);
    unknown.exRight.stat = "maintenance";
    await expect(
      new CorporateActionClient(
        fixtureFetch(unknown) as typeof fetch,
        now,
        { maxAttempts: 1 },
      ).probeRangeContract(
        "listed",
        "ex_right_dividend",
        "2025-07-01",
        "2025-07-10",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const detailDrift = structuredClone(twseFixture);
    const detailClient = new CorporateActionClient(
      fixtureFetch(detailDrift) as typeof fetch,
      now,
      { maxAttempts: 1 },
    );
    const summary = await detailClient.probeRangeContract(
      "listed",
      "ex_right_dividend",
      "2025-07-01",
      "2025-07-10",
    );
    const event = eventByCode(summary.events, "2317");
    const detailFields = detailDrift.exRightDetail2317?.fields as string[];
    detailFields[2] = "每股現金股利（契約漂移）";
    await expect(
      detailClient.probeTwseCombinedDetailContract(event),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });
});
