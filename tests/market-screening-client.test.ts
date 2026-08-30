import { describe, expect, it, vi } from "vitest";

import { TaiwanMarketScreenClient } from "@/lib/market-screening/client";
import type { FinancialScreenCandidate } from "@/lib/financial-screening/types";
import type { TaiwanStockScreenCandidate } from "@/lib/screening/types";

function nonFinancialCandidate(
  code: string,
  rank: number,
  bucket: TaiwanStockScreenCandidate["bucket"],
  score: number,
): TaiwanStockScreenCandidate {
  return {
    rank,
    companyCode: code,
    shortName: `N${code}`,
    market: "listed",
    bucket,
    overallScore: score,
  } as TaiwanStockScreenCandidate;
}

function financialCandidate(
  code: string,
  rank: number,
  bucket: FinancialScreenCandidate["bucket"],
  score: number,
): FinancialScreenCandidate {
  return {
    rank,
    companyCode: code,
    shortName: `F${code}`,
    market: "listed",
    financialSubtype: "bank",
    bucket,
    overallScore: score,
  } as FinancialScreenCandidate;
}

function fixture(options: {
  nonFinancial: TaiwanStockScreenCandidate[];
  financial: FinancialScreenCandidate[];
}) {
  const nonFinancialResult = { candidates: options.nonFinancial, marker: "nf" };
  const financialResult = { candidates: options.financial, marker: "fin" };
  const nonFinancialScreen = {
    screenTaiwanStockCandidates: vi.fn().mockResolvedValue(nonFinancialResult),
  };
  const financialScreen = {
    screenTaiwanFinancialCandidates: vi.fn().mockResolvedValue(financialResult),
  };
  return {
    client: new TaiwanMarketScreenClient(
      { nonFinancialScreen, financialScreen } as never,
      () => new Date("2026-08-30T00:00:00.000Z"),
    ),
    nonFinancialResult,
    financialResult,
    nonFinancialScreen,
    financialScreen,
  };
}

const query = {
  market: "all" as const,
  includeKy: true,
  nonFinancialLimit: 2,
  financialLimit: 1,
  preset: "balanced_market_v1" as const,
};

describe("TaiwanMarketScreenClient", () => {
  it("merges by bucket, segment priority and within-model rank without comparing raw scores", async () => {
    const first = fixture({
      nonFinancial: [
        nonFinancialCandidate("2330", 1, "research_candidate", 1),
        nonFinancialCandidate("2454", 2, "watchlist", 99),
      ],
      financial: [financialCandidate("2801", 1, "research_candidate", 100)],
    });
    const result = await first.client.screenTaiwanMarketCandidates(query);

    expect(result.shortlist.map(({ segment, companyCode }) => [segment, companyCode]))
      .toEqual([
        ["non_financial", "2330"],
        ["financial", "2801"],
        ["non_financial", "2454"],
      ]);
    expect(result.screenDefinition).toMatchObject({
      crossModelScoreComparable: false,
      mergePolicy: {
        compareRawOverallScoreAcrossModels: false,
        refillUnusedQuotaAcrossSegments: false,
      },
    });
    expect(result.segments.nonFinancial).toBe(first.nonFinancialResult);
    expect(result.segments.financial).toBe(first.financialResult);

    const reversedScores = fixture({
      nonFinancial: [
        nonFinancialCandidate("2330", 1, "research_candidate", 100),
        nonFinancialCandidate("2454", 2, "watchlist", 1),
      ],
      financial: [financialCandidate("2801", 1, "research_candidate", 0)],
    });
    const second = await reversedScores.client.screenTaiwanMarketCandidates(query);
    expect(second.shortlist.map((candidate) => candidate.companyCode)).toEqual(
      result.shortlist.map((candidate) => candidate.companyCode),
    );
  });

  it("applies each quota before merge and never refills an unused segment", async () => {
    const setup = fixture({
      nonFinancial: [
        nonFinancialCandidate("2330", 1, "research_candidate", 90),
        nonFinancialCandidate("2454", 2, "research_candidate", 80),
        nonFinancialCandidate("2308", 3, "research_candidate", 70),
      ],
      financial: [],
    });
    const result = await setup.client.screenTaiwanMarketCandidates(query);

    expect(result.shortlist).toHaveLength(2);
    expect(result.composition).toMatchObject({
      requested: { nonFinancial: 2, financial: 1, total: 3 },
      returned: { nonFinancial: 2, financial: 0, total: 2 },
      unfilled: { nonFinancial: 0, financial: 1, total: 1 },
    });
    expect(result.shortlist.map((candidate) => candidate.companyCode)).toEqual([
      "2330",
      "2454",
    ]);
  });

  it("fails the combined request when either segment fails", async () => {
    const client = new TaiwanMarketScreenClient({
      nonFinancialScreen: {
        screenTaiwanStockCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
      },
      financialScreen: {
        screenTaiwanFinancialCandidates: vi.fn().mockRejectedValue(
          new Error("financial failed"),
        ),
      },
    } as never);

    await expect(client.screenTaiwanMarketCandidates(query)).rejects.toThrow(
      "financial failed",
    );
  });
});
