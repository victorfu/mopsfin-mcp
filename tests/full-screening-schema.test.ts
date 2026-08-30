import { describe, expect, it } from "vitest";

import {
  screenTaiwanMarketUniversePageDataSchema,
  screenTaiwanMarketUniversePageInputSchema,
  screenTaiwanMarketUniversePageOutputSchema,
} from "@/lib/mcp/schema/full-screening";

describe("full-universe screening schemas", () => {
  it("defaults a five-company manifest page", () => {
    expect(screenTaiwanMarketUniversePageInputSchema.parse({})).toEqual({
      market: "all",
      include_ky: true,
      page_size: 5,
      preset: "full_universe_cursor_v1",
    });
  });

  it("keeps cursor input strict and page_size bounded", () => {
    expect(
      screenTaiwanMarketUniversePageInputSchema.safeParse({ extra: true }).success,
    ).toBe(false);
    expect(
      screenTaiwanMarketUniversePageInputSchema.safeParse({ page_size: 0 }).success,
    ).toBe(false);
    expect(
      screenTaiwanMarketUniversePageInputSchema.safeParse({ page_size: 6 }).success,
    ).toBe(false);
    expect(
      screenTaiwanMarketUniversePageInputSchema.safeParse({
        cursor: "x".repeat(1001),
      }).success,
    ).toBe(false);
  });

  it("separates the domain result from the MCP success envelope", () => {
    expect(screenTaiwanMarketUniversePageDataSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      Object.hasOwn(screenTaiwanMarketUniversePageDataSchema.shape, "ok"),
    ).toBe(false);
    expect(
      Object.hasOwn(screenTaiwanMarketUniversePageOutputSchema.shape, "ok"),
    ).toBe(true);
    expect(
      Object.hasOwn(
        screenTaiwanMarketUniversePageOutputSchema.shape,
        "terminalResults",
      ),
    ).toBe(true);
  });
});
