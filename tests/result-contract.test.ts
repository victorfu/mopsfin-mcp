import { describe, expect, it } from "vitest";

import { paginateByCompany } from "@/lib/mcp/cursor";
import { buildResultMeta, structuredError } from "@/lib/mcp/result-contract";
import { MopsfinError } from "@/lib/mopsfin/errors";

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

    expect(meta.quality.universe).toBe("not_applicable");
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
