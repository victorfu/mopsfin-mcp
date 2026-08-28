import { describe, expect, it } from "vitest";

import { evaluateFreshness } from "@/lib/freshness/evaluate";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
import { paginateByCompany } from "@/lib/mcp/cursor";
import { buildResultMeta, structuredError } from "@/lib/mcp/result-contract";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";

describe("mopsfin.result.v1", () => {
  it("builds a date as-of and keeps legitimate missing selections separate from sources", () => {
    const meta = buildResultMeta(
      {
        query: { date: "latest" },
        dataDate: "2026-08-25",
        selectionComplete: false,
        missingCompanyCodes: ["9999"],
        sources: [
          {
            sourceUrl: "https://example.test/data",
            dataDate: "2026-08-25",
            retrievedAt: "2026-08-26T00:00:00.000Z",
          },
        ],
      },
      {},
      "2026-08-26T00:00:00.000Z",
    );

    expect(meta.contractVersion).toBe("mopsfin.result.v1");
    expect(meta.asOf).toMatchObject({
      selector: "latest",
      resolved: { granularity: "date", from: "2026-08-25", through: "2026-08-25" },
      timezone: "Asia/Taipei",
      servedAt: "2026-08-26T00:00:00.000Z",
      assembledAt: "2026-08-26T00:00:00.000Z",
    });
    expect(meta.quality).toMatchObject({
      status: "partial",
      source: "complete",
      selection: "partial",
    });
    expect(meta.quality.issues[0]).toMatchObject({
      code: "SELECTION_MISSING",
      refs: { companyCodes: ["9999"] },
    });
  });

  it("returns structured retry and pagination actions without leaking stack-like details", () => {
    const retry = structuredError(
      new MopsfinError("UPSTREAM_TIMEOUT", "逾時", {
        details: { source: "TWSE", stack: "do not expose" },
      }),
    );
    expect(retry.error).toMatchObject({
      category: "upstream",
      retryable: true,
      action: "retry",
    });
    expect(retry.error.details).toEqual({ source: "TWSE" });

    const stale = structuredError(
      new MopsfinError("INVALID_ARGUMENT", "stale", {
        reason: "SNAPSHOT_CHANGED",
        category: "pagination",
      }),
    );
    expect(stale.error).toMatchObject({
      reason: "SNAPSHOT_CHANGED",
      category: "pagination",
      action: "restart_pagination",
    });

    const invalidCursor = structuredError(
      new MopsfinError("INVALID_ARGUMENT", "invalid cursor", {
        reason: "CURSOR_INVALID",
      }),
    );
    expect(invalidCursor.error).toMatchObject({
      reason: "CURSOR_INVALID",
      category: "pagination",
      action: "restart_pagination",
    });
  });

  it("infers quarter ranges and nested coverage without mistaking catalog periods for data", () => {
    const trend = buildResultMeta(
      {
        query: { history: "recent_12" },
        periods: ["2025Q4", "2026Q1"],
        series: [],
        coverage: {
          selectionComplete: false,
          missingCompanyCodes: ["9999"],
        },
      },
      {},
      "2026-08-26T00:00:00.000Z",
    );
    expect(trend.asOf).toMatchObject({
      selector: "range",
      resolved: {
        granularity: "quarter",
        from: "2025Q4",
        through: "2026Q1",
      },
    });
    expect(trend.quality).toMatchObject({ selection: "partial" });
    expect(trend.quality.issues[0]).toMatchObject({
      code: "SELECTION_MISSING",
      refs: { companyCodes: ["9999"] },
    });

    const catalog = buildResultMeta(
      {
        query: { kind: "periods" },
        discoveredAt: "2026-08-26T00:00:00.000Z",
        periods: ["2026Q1"],
      },
      {},
      "2026-08-26T00:00:00.000Z",
    );
    expect(catalog.asOf.resolved.granularity).toBe("instant");
  });

  it("does not infer universe verification from an unrelated snapshot id", () => {
    const meta = buildResultMeta(
      {
        snapshotId: "page-content-snapshot",
        companies: [{ companyCode: "2330" }],
      },
      {},
      "2026-08-26T00:00:00.000Z",
    );

    expect(meta.quality).toMatchObject({
      status: "partial",
      universe: "not_applicable",
      values: "unknown",
    });
  });

  it("marks unverified universes partial and does not invent a cutoff for unverified empty sources", () => {
    const meta = buildResultMeta(
      {
        coverage: {
          requestedStart: "2026-01-01",
          requestedEnd: "2026-01-31",
          coveredThrough: "2026-01-31",
        },
        sources: [
          {
            sourceUrl: "https://example.test/no-data?month=2026-01",
            retrievedAt: "2026-08-26T00:00:00.000Z",
            snapshotIdentity: "unverified_empty",
          },
        ],
      },
      { universe: "unverified", source: "partial" },
      "2026-08-26T00:00:00.000Z",
    );

    expect(meta.quality).toMatchObject({
      status: "partial",
      source: "partial",
      universe: "unverified",
    });
    expect(meta.asOf.sourceCutoffs[0].resolved).toEqual({
      granularity: "none",
      from: null,
      through: null,
    });
  });

  it("uses normalized screen source as-of fields for mixed-source cutoffs", () => {
    const meta = buildResultMeta(
      {
        sources: [
          {
            sourceUrl: "https://example.test/revenue",
            retrievedAt: "2026-08-27T00:00:00.000Z",
            asOf: "2026-07",
            asOfGranularity: "month",
          },
          {
            sourceUrl: "https://example.test/financials",
            retrievedAt: "2026-08-27T00:00:00.000Z",
            asOf: "2026Q2",
            asOfGranularity: "quarter",
          },
        ],
      },
      {
        selector: "latest",
        resolved: { granularity: "mixed", from: null, through: null },
      },
      "2026-08-27T00:00:00.000Z",
    );

    expect(meta.asOf.sourceCutoffs.map((cutoff) => cutoff.resolved)).toEqual([
      { granularity: "month", from: "2026-07", through: "2026-07" },
      { granularity: "quarter", from: "2026Q2", through: "2026Q2" },
    ]);
  });

  it("uses catalyst sourceSnapshotDate as cutoff without inventing publishedAt", () => {
    const meta = buildResultMeta(
      {
        sources: [
          {
            sourceUrl: "https://example.test/catalyst-snapshot",
            retrievedAt: "2026-08-28T00:00:00.000Z",
            sourceSnapshotDate: "2026-08-27",
          },
        ],
      },
      {
        selector: "latest",
        resolved: {
          granularity: "date",
          from: "2026-08-27",
          through: "2026-08-27",
        },
      },
      "2026-08-28T00:00:00.000Z",
    );

    expect(meta.asOf.sourceCutoffs[0]).toMatchObject({
      resolved: {
        granularity: "date",
        from: "2026-08-27",
        through: "2026-08-27",
      },
      publishedAt: null,
      cache: {
        status: "unknown",
        observedAt: null,
        storedAt: null,
        ageMs: null,
        ttlMs: null,
      },
    });
  });

  it("does not fabricate source cutoffs for failed, unsupported or unretrieved routes", () => {
    const meta = buildResultMeta(
      {
        sources: [
          {
            sourceUrl: "https://example.test/failed",
            status: "failed",
            retrievedAt: null,
            sourceSnapshotDate: null,
          },
          {
            sourceUrl: null,
            status: "unsupported",
            retrievedAt: null,
            sourceSnapshotDate: null,
          },
          {
            sourceUrl: "https://example.test/not-retrieved",
            status: "nonempty",
            sourceSnapshotDate: "2026-08-27",
          },
          {
            sourceUrl: "https://example.test/success",
            status: "nonempty",
            retrievedAt: "2026-08-28T00:00:00.000Z",
            sourceSnapshotDate: "2026-08-27",
          },
        ],
      },
      {
        selector: "latest",
        resolved: {
          granularity: "date",
          from: "2026-08-27",
          through: "2026-08-27",
        },
      },
      "2026-08-28T00:00:00.000Z",
    );

    expect(meta.asOf.sourceCutoffs).toEqual([
      expect.objectContaining({
        sourceUrl: "https://example.test/success",
        retrievedAt: "2026-08-28T00:00:00.000Z",
        publishedAt: null,
      }),
    ]);
  });

  it("preserves only an explicitly supplied source publishedAt", () => {
    const meta = buildResultMeta(
      {
        sources: [
          {
            sourceUrl: "https://example.test/explicit-publication",
            retrievedAt: "2026-08-28T00:00:00.000Z",
            reportDate: "2026-08-27",
            publishedAt: "2026-08-27T18:00:00+08:00",
          },
        ],
      },
      { freshness: "not_applicable" },
      "2026-08-28T01:00:00.000Z",
    );

    expect(meta.asOf.sourceCutoffs[0]).toMatchObject({
      resolved: {
        granularity: "date",
        from: "2026-08-27",
        through: "2026-08-27",
      },
      publishedAt: "2026-08-27T18:00:00+08:00",
    });
  });

  it("aggregates freshness evidence and adds stable quality issues once", () => {
    const stale = evaluateFreshness({
      policy: FRESHNESS_POLICIES.monthlyRevenueLatestCommon,
      observedAsOf: "2026-06",
      expectedAsOf: "2026-07",
      sourceUrls: ["https://example.test/revenue"],
    });
    const unknown = evaluateFreshness({
      policy: FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: "2026-08-27",
      expectedAsOf: null,
      sourceUrls: ["https://example.test/market"],
    });
    const meta = buildResultMeta(
      {
        dataDate: "2026-08-27",
        dataQualityComplete: true,
      },
      {
        values: "complete",
        freshnessDetails: [stale, unknown],
        issues: [
          {
            code: "DATA_STALE",
            severity: "warning",
            scope: "source",
            message: "domain-specific stale warning",
            refs: {
              companyCodes: [],
              fields: [],
              periods: ["2026-06"],
              sourceUrls: ["https://example.test/revenue"],
            },
          },
        ],
      },
      "2026-08-28T00:00:00.000Z",
    );

    expect(meta.quality).toMatchObject({
      status: "partial",
      freshness: "stale",
      freshnessDetails: [
        expect.objectContaining({ policyId: "official.monthly-revenue.latest-common.v1" }),
        expect.objectContaining({ policyId: "official.completed-session.v1" }),
      ],
    });
    expect(
      meta.quality.issues.filter((issue) => issue.code === "DATA_STALE"),
    ).toHaveLength(1);
    expect(
      meta.quality.issues.filter(
        (issue) => issue.code === "FRESHNESS_UNVERIFIED",
      ),
    ).toHaveLength(1);
  });

  it("adds resolver calendar and marker retrieval cutoffs without rewriting provenance", () => {
    const resolverEvidence = completedSessionEvidenceFixture({
      status: "resolved",
      expectedAsOf: "2026-08-27",
    });
    const freshness = evaluateFreshness({
      policy: FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: "2026-08-27",
      expectedAsOf: "2026-08-27",
      sourceUrls: ["https://example.test/market"],
      resolverEvidence,
    });
    const meta = buildResultMeta(
      {
        dataDate: "2026-08-27",
        sources: [
          {
            sourceUrl: "https://example.test/market",
            dataDate: "2026-08-27",
            retrievedAt: "2026-08-28T05:00:00.000Z",
          },
        ],
      },
      { freshnessDetails: [freshness] },
      "2026-08-28T06:05:00.000Z",
    );

    expect(meta.asOf.sourceCutoffs).toHaveLength(3);
    expect(meta.asOf.sourceCutoffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceUrl:
            "https://www.twse.com.tw/holidaySchedule/holidaySchedule?queryYear=115&response=json",
          resolved: {
            granularity: "date",
            from: "2026-01-01",
            through: "2026-12-31",
          },
          retrievedAt: "2026-08-28T06:01:00.000Z",
          cache: resolverEvidence.marketResolutions[0]?.sources[0]?.cache,
        }),
        expect.objectContaining({
          sourceUrl: expect.stringContaining("MI_5MINS_HIST"),
          resolved: {
            granularity: "month",
            from: "2026-08",
            through: "2026-08",
          },
          retrievedAt: "2026-08-28T06:01:00.000Z",
        }),
      ]),
    );
  });

  it("keeps source retrieval in the fingerprint but excludes servedAt and cache caller state", () => {
    const data = (
      cache: {
        status: "miss" | "hit";
        observedAt: string;
        storedAt: string;
        ageMs: number;
        ttlMs: number;
      },
      retrievedAt = "2026-08-28T00:00:00.000Z",
    ) => ({
      dataDate: "2026-08-27",
      sources: [
        {
          sourceUrl: "https://example.test/market",
          dataDate: "2026-08-27",
          retrievedAt,
          cache,
        },
      ],
    });
    const miss = buildResultMeta(
      data({
        status: "miss",
        observedAt: "2026-08-28T00:00:01.000Z",
        storedAt: "2026-08-28T00:00:00.000Z",
        ageMs: 0,
        ttlMs: 300_000,
      }),
      { freshness: "unknown" },
      "2026-08-28T00:00:01.000Z",
    );
    const hit = buildResultMeta(
      data({
        status: "hit",
        observedAt: "2026-08-28T00:02:00.000Z",
        storedAt: "2026-08-28T00:00:00.000Z",
        ageMs: 120_000,
        ttlMs: 300_000,
      }),
      { freshness: "unknown" },
      "2026-08-28T00:02:01.000Z",
    );
    const refetched = buildResultMeta(
      data(
        {
          status: "miss",
          observedAt: "2026-08-28T00:03:00.500Z",
          storedAt: "2026-08-28T00:03:00.000Z",
          ageMs: 0,
          ttlMs: 300_000,
        },
        "2026-08-28T00:03:00.000Z",
      ),
      { freshness: "unknown" },
      "2026-08-28T00:03:01.000Z",
    );

    expect(miss.asOf.snapshotId).toBe(hit.asOf.snapshotId);
    expect(miss.asOf.snapshotId).not.toBe(refetched.asOf.snapshotId);
    expect(miss.asOf.sourceCutoffs[0].cache.status).toBe("miss");
    expect(hit.asOf.sourceCutoffs[0].cache).toMatchObject({
      status: "hit",
      observedAt: "2026-08-28T00:02:00.000Z",
      ageMs: 120_000,
    });
    expect(miss.asOf.servedAt).not.toBe(hit.asOf.servedAt);
    expect(miss.asOf.sourceCutoffs[0].retrievedAt).toBe(
      hit.asOf.sourceCutoffs[0].retrievedAt,
    );
  });
});

describe("stateless company cursor", () => {
  it("binds continuation to the query, page size and source snapshot", () => {
    const first = paginateByCompany({
      tool: "example",
      query: { market: "all" },
      snapshotId: "snapshot-a",
      items: ["1101", "2330", "3105"],
      pageSize: 2,
      maximumPageSize: 2,
    });
    const cursor = first.page.next?.kind === "cursor" ? first.page.next.cursor : "";
    expect(first.items).toEqual(["1101", "2330"]);

    const second = paginateByCompany({
      tool: "example",
      query: { market: "all" },
      snapshotId: "snapshot-a",
      items: ["1101", "2330", "3105"],
      cursor,
      maximumPageSize: 2,
    });
    expect(second.items).toEqual(["3105"]);
    expect(second.page.next).toBeNull();

    let queryMismatch: unknown;
    try {
      paginateByCompany({
        tool: "example",
        query: { market: "listed" },
        snapshotId: "snapshot-a",
        items: ["1101", "2330", "3105"],
        cursor,
        maximumPageSize: 2,
      });
    } catch (error) {
      queryMismatch = error;
    }
    expect(queryMismatch).toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "CURSOR_INVALID",
      category: "pagination",
      retryable: false,
      action: "restart_pagination",
    });

    expect(() =>
      paginateByCompany({
        tool: "example",
        query: { market: "all" },
        snapshotId: "snapshot-b",
        items: ["1101", "2330", "3105"],
        cursor,
        maximumPageSize: 2,
      }),
    ).toThrowError(/快照已變更/);

    for (const attempt of [
      () =>
        paginateByCompany({
          tool: "different-tool",
          query: { market: "all" },
          snapshotId: "snapshot-a",
          items: ["1101", "2330", "3105"],
          cursor,
          maximumPageSize: 2,
        }),
      () =>
        paginateByCompany({
          tool: "example",
          query: { market: "all" },
          snapshotId: "snapshot-a",
          items: ["1101", "2330", "3105"],
          pageSize: 1,
          cursor,
          maximumPageSize: 2,
        }),
      () =>
        paginateByCompany({
          tool: "example",
          query: { market: "all" },
          snapshotId: "snapshot-a",
          items: ["1101", "2330", "3105"],
          cursor: `${cursor}tampered`,
          maximumPageSize: 2,
        }),
    ]) {
      expect(attempt).toThrowError(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          reason: "CURSOR_INVALID",
          action: "restart_pagination",
        }),
      );
    }

    expect(() =>
      paginateByCompany({
        tool: "example",
        query: {},
        snapshotId: "snapshot-a",
        items: ["1101"],
        pageSize: 3,
        maximumPageSize: 2,
      }),
    ).toThrowError(/page_size 必須介於 1 與 2/);
  });

  it("preserves legacy full return when pagination is omitted", () => {
    const page = paginateByCompany({
      tool: "legacy",
      query: {},
      snapshotId: "snapshot",
      items: [1, 2, 3],
      maximumPageSize: 2,
      legacyUnpaged: true,
    });
    expect(page.items).toEqual([1, 2, 3]);
    expect(page.page.mode).toBe("none");
  });
});
