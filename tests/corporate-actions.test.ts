import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CorporateActionClient } from "@/lib/corporate-actions/client";

interface CorporateActionFixtures {
  exRight: Record<string, unknown>;
  capitalReduction: Record<string, unknown>;
  parValueChange: Record<string, unknown>;
  exRightDetail2317?: Record<string, unknown>;
}

function fixture(name: string): CorporateActionFixtures {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as CorporateActionFixtures;
}

const twseFixture = fixture("corporate-actions-twse.json");
const tpexFixture = fixture("corporate-actions-tpex.json");
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

  it("clamps each family to its official history start and reports every gap", async () => {
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
        return response({
          stat: "OK",
          fields: [
            "恢復買賣日期",
            "股票代號",
            "名稱",
            "停止買賣前收盤價格",
            "恢復買賣參考價",
            "減資原因",
          ],
          data: [],
          strDate: start,
          endDate: end,
        });
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
      ],
    });
    expect(result.sources.map((source) => [source.family, source.queryStart])).toEqual([
      ["ex_right_dividend", "2010-12-30"],
      ["capital_reduction", "2011-01-01"],
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
});
