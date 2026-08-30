import { describe, expect, it } from "vitest";

import {
  screenTaiwanMarketCandidatesDataSchema,
  screenTaiwanMarketCandidatesInputSchema,
  screenTaiwanMarketCandidatesOutputSchema,
} from "@/lib/mcp/schema/market-screening";

describe("market screening schemas", () => {
  it("defaults the fixed segment quotas and market preset", () => {
    expect(screenTaiwanMarketCandidatesInputSchema.parse({})).toEqual({
      market: "all",
      include_ky: true,
      non_financial_limit: 4,
      financial_limit: 1,
      preset: "balanced_market_v1",
    });
  });

  it("keeps the input strict and both quotas independently bounded", () => {
    expect(
      screenTaiwanMarketCandidatesInputSchema.safeParse({ extra: true }).success,
    ).toBe(false);
    expect(
      screenTaiwanMarketCandidatesInputSchema.safeParse({
        non_financial_limit: 0,
      }).success,
    ).toBe(false);
    expect(
      screenTaiwanMarketCandidatesInputSchema.safeParse({
        financial_limit: 6,
      }).success,
    ).toBe(false);
  });

  it("requires both complete segment results and a separate success envelope", () => {
    expect(screenTaiwanMarketCandidatesDataSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      Object.hasOwn(screenTaiwanMarketCandidatesDataSchema.shape, "segments"),
    ).toBe(true);
    expect(
      Object.hasOwn(screenTaiwanMarketCandidatesDataSchema.shape, "ok"),
    ).toBe(false);
    expect(Object.hasOwn(screenTaiwanMarketCandidatesOutputSchema.shape, "ok"))
      .toBe(true);
    expect(
      Object.hasOwn(screenTaiwanMarketCandidatesOutputSchema.shape, "segments"),
    ).toBe(true);
  });
});
