import { describe, expect, it, vi } from "vitest";

import { TaiwanMarketFullUniverseClient } from "@/lib/full-screening/client";

function company(code: string, financial = false) {
  return {
    code,
    name: `Company ${code}`,
    shortName: `C${code}`,
    market: "listed" as const,
    exchange: "TWSE" as const,
    industryCode: financial ? "17" : "24",
    listingDate: "2001-01-01",
    incorporationDate: null,
    paidInCapitalTwd: null,
    issuedCommonShares: null,
    parValueText: null,
    financialReportTypeCode: null,
    profileValueStatus: {
      incorporationDate: "missing" as const,
      paidInCapitalTwd: "missing" as const,
      issuedCommonShares: "missing" as const,
      parValueText: "missing" as const,
      financialReportTypeCode: "missing" as const,
    },
    domicileCode: "TW",
    isKy: false,
    isFinancial: financial,
  };
}

function masterResult(
  companies: ReturnType<typeof company>[],
  retrievedAt = "2026-08-30T00:00:00.000Z",
) {
  return {
    companies,
    coverageVerification: {
      status: "heuristic",
      method: "required_sources_schema_single_report_date_minimum_count",
      officialDeclaredRowCountAvailable: false,
    },
    sources: [{
      market: "listed",
      reportDate: "2026-08-30",
      retrievedAt,
      rawCount: companies.length,
      excludedTdrCount: 0,
      companyCount: companies.length,
    }],
  };
}

function segmentResult(
  codes: string[],
  financial: boolean,
  options: { failed?: boolean; unfinishedReaction?: boolean } = {},
) {
  const candidates = options.unfinishedReaction
    ? []
    : codes.map((code, index) => ({
        rank: index + 1,
        companyCode: code,
        companyName: `Company ${code}`,
        shortName: `C${code}`,
        market: "listed",
        bucket: "research_candidate",
        overallScore: 80,
        ...(financial ? { financialSubtype: "bank" } : {}),
      }));
  return {
    asOf: { masterReportDates: ["2026-08-30"] },
    coverage: { sourceComplete: !options.failed },
    dependencyStatus: options.failed
      ? [{ status: "failed", stage: "deep", dependency: "test" }]
      : [],
    candidates,
    notDeepScored: [],
    notReactionScored: options.unfinishedReaction
      ? codes.map((code) => ({
          companyCode: code,
          companyName: `C${code}`,
          reasonCodes: ["reaction_dependency_not_completed"],
        }))
      : [],
    excluded: [],
  };
}

function fixture(options: {
  companies?: ReturnType<typeof company>[];
  masterImplementation?: () => unknown;
  failedSegment?: "non_financial" | "financial";
  unfinishedReaction?: boolean;
} = {}) {
  const companies = options.companies ?? [
    company("1001"),
    company("1002", true),
    company("1003"),
    company("1004", true),
    company("1005"),
    company("1006", true),
    company("1007"),
  ];
  const listCompanies = vi.fn().mockImplementation(
    options.masterImplementation ?? (() => masterResult(companies)),
  );
  const screenTaiwanStockCandidates = vi.fn().mockImplementation(
    async (query: { companyCodes?: string[] }) =>
      segmentResult(
        query.companyCodes ?? [],
        false,
        {
          failed: options.failedSegment === "non_financial",
          unfinishedReaction: options.unfinishedReaction,
        },
      ),
  );
  const screenTaiwanFinancialCandidates = vi.fn().mockImplementation(
    async (query: { companyCodes?: string[] }) =>
      segmentResult(
        query.companyCodes ?? [],
        true,
        { failed: options.failedSegment === "financial" },
      ),
  );
  return {
    client: new TaiwanMarketFullUniverseClient(
      {
        companyMaster: { listCompanies },
        nonFinancialScreen: { screenTaiwanStockCandidates },
        financialScreen: { screenTaiwanFinancialCandidates },
      } as never,
      () => new Date("2026-08-30T00:00:00.000Z"),
    ),
    listCompanies,
    screenTaiwanStockCandidates,
    screenTaiwanFinancialCandidates,
  };
}

const baseQuery = {
  market: "all" as const,
  includeKy: true,
  pageSize: 3,
  preset: "full_universe_cursor_v1" as const,
};

describe("TaiwanMarketFullUniverseClient", () => {
  it("routes every manifest company exactly once across a complete cursor chain", async () => {
    const setup = fixture();
    const results = [];
    let cursor: string | undefined;
    do {
      const result = await setup.client.screenTaiwanMarketUniversePage({
        ...baseQuery,
        ...(cursor ? { cursor } : {}),
      });
      results.push(result);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.page.companyCodes)).toEqual([
      ["1001", "1002", "1003"],
      ["1004", "1005", "1006"],
      ["1007"],
    ]);
    const terminalCodes = results.flatMap((result) =>
      result.terminalResults.map((terminal) => terminal.companyCode)
    );
    expect(terminalCodes).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
      "1006",
      "1007",
    ]);
    expect(new Set(terminalCodes).size).toBe(7);
    expect(
      results.every(
        (result) =>
          result.coverage.pageTerminalReconciliationComplete &&
          result.executionDefinition.pageValuesPinned === false &&
          result.executionDefinition.globalRankAvailable === false,
      ),
    ).toBe(true);
    expect(results.at(-1)?.coverage.pageEndReached).toBe(true);
    expect(
      setup.screenTaiwanStockCandidates.mock.calls.every(
        ([query]) => query.candidateLimit === query.companyCodes.length,
      ),
    ).toBe(true);
    expect(
      setup.screenTaiwanFinancialCandidates.mock.calls.every(
        ([query]) => query.candidateLimit === query.companyCodes.length,
      ),
    ).toBe(true);
  });

  it("keeps the manifest stable across retrieval-time changes and rejects tampered cursors", async () => {
    let call = 0;
    const companies = [company("1001"), company("1002"), company("1003")];
    const setup = fixture({
      companies,
      masterImplementation: () =>
        masterResult(
          companies,
          `2026-08-30T00:00:0${call++}.000Z`,
        ),
    });
    const first = await setup.client.screenTaiwanMarketUniversePage({
      ...baseQuery,
      pageSize: 2,
    });
    const second = await setup.client.screenTaiwanMarketUniversePage({
      ...baseQuery,
      pageSize: 2,
      cursor: first.page.nextCursor as string,
    });
    expect(second.manifest.snapshotId).toBe(first.manifest.snapshotId);

    const cursor = first.page.nextCursor as string;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    await expect(
      setup.client.screenTaiwanMarketUniversePage({
        ...baseQuery,
        pageSize: 2,
        cursor: tampered,
      }),
    ).rejects.toMatchObject({
      reason: "CURSOR_INVALID",
      action: "restart_pagination",
    });
  });

  it("rejects a changed manifest and shared page failures without advancing", async () => {
    let companies = [company("1001"), company("1002"), company("1003")];
    const changed = fixture({
      masterImplementation: () => masterResult(companies),
    });
    const first = await changed.client.screenTaiwanMarketUniversePage({
      ...baseQuery,
      pageSize: 2,
    });
    companies = [...companies, company("1004")];
    await expect(
      changed.client.screenTaiwanMarketUniversePage({
        ...baseQuery,
        pageSize: 2,
        cursor: first.page.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      reason: "SNAPSHOT_CHANGED",
      action: "restart_pagination",
    });

    const failed = fixture({
      companies: [company("1001")],
      failedSegment: "non_financial",
    });
    await expect(
      failed.client.screenTaiwanMarketUniversePage({
        ...baseQuery,
        pageSize: 1,
      }),
    ).rejects.toMatchObject({
      code: "INCOMPLETE_COVERAGE",
      reason: "FULL_UNIVERSE_PAGE_INCOMPLETE",
      action: "retry",
    });

    const unfinished = fixture({
      companies: [company("1001")],
      unfinishedReaction: true,
    });
    await expect(
      unfinished.client.screenTaiwanMarketUniversePage({
        ...baseQuery,
        pageSize: 1,
      }),
    ).rejects.toMatchObject({
      reason: "FULL_UNIVERSE_PAGE_INCOMPLETE",
    });
  });
});
