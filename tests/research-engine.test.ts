import { describe, expect, it } from "vitest";
import { planResearchFields, researchFields, financialNormalization } from "@/lib/research/fields";
import { projectResearchRows } from "@/lib/research/projection";
import { sampleStandardDeviation, summarizeResearchRows } from "@/lib/research/statistics";
import type { ResearchCell, ResearchRow } from "@/lib/research/types";
import { screenRows } from "@/lib/screener/engine";
import { alignFinancialPeriods, completedQuarterWindow } from "@/lib/comparison/alignment";

const cell = (value: ResearchCell["value"], overrides: Partial<ResearchCell> = {}): ResearchCell => ({
  value, status: value === null ? "missing" : "available", unit: "%", period: "2026Q2",
  basis: "quarterly", definitionId: "roe", sourceRefs: ["official"], freshness: "fresh", ...overrides,
});
const row = (code: string, cells: Record<string, ResearchCell>): ResearchRow => ({ code, name: code, market: "listed", cells });

describe("research planning", () => {
  it("loads only dependencies of selected/filter/sort fields and rejects unknown columns before fetch", () => {
    const registry = researchFields();
    expect(registry.find((field) => field.id === "price.close")?.supportedTools).toContain("get_daily_market_ohlc");
    expect(registry.find((field) => field.id === "company.code")?.supportedTools).toContain("get_monthly_revenue");
    expect(registry.find((field) => field.id === "company.is_financial")?.supportedTools).not.toContain("get_monthly_revenue");
    expect(planResearchFields({ registry, tool: "screen_companies", columns: ["company.code"], filters: [{ field: "valuation.pe", op: "between", value: [10, 25] }], sort: [{ field: "revenue.yoy_pct", direction: "desc" }] }).domains).toEqual(["company", "valuation", "revenue"]);
    expect(() => planResearchFields({ registry, tool: "screen_companies", columns: ["financial.secret"] })).toThrow("不支援");
    for (const value of [[25, 10], [10], [10, Infinity], "10"]) {
      expect(() => planResearchFields({ registry, tool: "screen_companies", columns: [], filters: [{ field: "valuation.pe", op: "between", value }] })).toThrow();
    }
  });
  it("does not guess monetary scale or percentage multipliers", () => {
    expect(financialNormalization("仟元")).toEqual({ sourceUnit: "仟元", outputUnit: "TWD", factor: 1000 });
    expect(financialNormalization("%")).toMatchObject({ factor: 1 });
    expect(financialNormalization("unknown")).toBeNull();
  });
});

describe("screener three-valued AND", () => {
  it("retains unknown counts even when another predicate is false; null is not zero", () => {
    const result = screenRows([
      row("1", { a: cell(21), b: cell(10) }), row("2", { a: cell(20), b: cell(null) }),
      row("3", { a: cell(21), b: cell(null) }), row("4", { a: cell(30, { freshness: "stale" }), b: cell(15) }),
    ], [{ field: "a", op: "gt", value: 20 }, { field: "b", op: "between", value: [10, 25] }], []);
    expect(result.counts).toEqual({ selected: 4, matched: 1, notMatched: 1, undetermined: 2, unknownFilterCells: 3 });
    expect(result.matches[0].evidence.map((item) => item.outcome)).toEqual(["true", "true"]);
  });
  it("sorts null last in either direction and resolves ties by identity", () => {
    const rows = [row("3", { a: cell(null) }), row("2", { a: cell(5) }), row("1", { a: cell(5) }), row("4", { a: cell(9) })];
    expect(screenRows(rows, [], [{ field: "a", direction: "desc" }]).matches.map((item) => item.code)).toEqual(["4", "1", "2", "3"]);
    expect(screenRows(rows, [], [{ field: "a", direction: "asc" }]).matches.map((item) => item.code)).toEqual(["1", "2", "4", "3"]);
    expect(screenRows(rows, [], [{ field: "a", direction: "asc" }]).rankIncomplete).toBe(true);
  });
});

describe("projection and statistics", () => {
  it("separates period, definition, unit and basis instead of pooling unlike values", () => {
    const rows = [row("1", { a: cell(1) }), row("2", { a: cell(3) }), row("3", { a: cell(100, { definitionId: "bank" }) }), row("4", { a: cell(20, { period: "2026Q1" }) }), row("5", { a: cell(9, { freshness: "unverified" }) })];
    const [summary] = summarizeResearchRows(rows, ["a"]);
    expect(summary.groups).toHaveLength(3);
    expect(summary.groups[0]).toMatchObject({ min: 1, max: 3, median: 2, count: 2 });
    expect(summary.usableCount).toBe(4);
    expect(summary).toMatchObject({ missingCount: 0, missingRate: 0, unusableCount: 1, unusableRate: 0.2 });
    expect(summarizeResearchRows([], ["a"])[0]).toMatchObject({ missingRate: null, unusableRate: null });
    expect(summarizeResearchRows([row("1", { a: cell(null) }), row("2", { a: cell(null, { status: "not_applicable" }) })], ["a"])[0]).toMatchObject({ missingCount: 1, missingRate: 0.5, unusableCount: 2, unusableRate: 1 });
    expect(summary.definitionMismatch).toBe(true);
    expect(sampleStandardDeviation([1, 2, 3])).toBe(1);
    expect(sampleStandardDeviation([1])).toBeNull();
  });
  it("compresses 20×8 cells by at least half without losing metadata or source values", () => {
    const columns = Array.from({ length: 8 }, (_, index) => `metric${index}`);
    const rows = Array.from({ length: 20 }, (_, index) => row(String(index), Object.fromEntries(columns.map((key) => [key, cell(index * 1000, { normalization: { sourceUnit: "仟元", sourceValue: index, factor: 1000 } })]))));
    const full = projectResearchRows(rows, columns, "full", "entire_selection");
    const compact = projectResearchRows(rows, columns, "compact", "entire_selection");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)) / 2);
    if (!("cellMetadata" in compact) || !compact.cellMetadata) throw new Error("compact variant absent");
    expect(compact.cellMetadata[0]).toMatchObject({ sourceRefs: ["official"], normalization: { sourceUnit: "仟元", factor: 1000 } });
    expect(compact.rows?.[1]).toMatchObject({ values: Array.from({ length: 8 }, () => [1000, 0, 1]) });
    expect(projectResearchRows(rows, columns, "summary", "current_page")).toMatchObject({ rowsOmitted: true, scope: "current_page", rowCount: 20 });
  });
});

describe("financial quarter alignment", () => {
  it("uses the last twelve completed Taipei calendar quarters", () => {
    const window = completedQuarterWindow(new Date("2026-06-30T16:00:00Z"));
    expect(window).toHaveLength(12);
    expect(window[0]).toBe("2023Q3");
    expect(window[11]).toBe("2026Q2");
    expect(completedQuarterWindow(new Date("2026-06-30T15:59:59Z"))[11]).toBe("2026Q1");
  });
  it("never drops an unavailable company or metric from common-latest constraints", () => {
    const base = { companies: ["1", "2"], metrics: ["EPS"], window: ["2026Q1", "2026Q2"], policy: "common_latest" as const };
    const series = [{ companyCode: "1", metricCode: "EPS", applicability: "applicable" as const, reportedPeriods: ["2026Q1", "2026Q2"] }];
    expect(alignFinancialPeriods({ ...base, series }).status).toBe("no_common_period");
    expect(alignFinancialPeriods({ ...base, series: [...series, { ...series[0], companyCode: "2", reportedPeriods: ["2026Q1"] }] }).commonPeriod).toBe("2026Q1");
  });
  it("excludes only confirmed not-applicable metrics and never falls back from explicit", () => {
    const base = { companies: ["1"], metrics: ["EPS", "GrossMargin"], window: ["2026Q1", "2026Q2"], series: [
      { companyCode: "1", metricCode: "EPS", applicability: "applicable" as const, reportedPeriods: ["2026Q1"] },
      { companyCode: "1", metricCode: "GrossMargin", applicability: "not_applicable" as const, reportedPeriods: [] },
    ] };
    expect(alignFinancialPeriods({ ...base, policy: "company_latest" }).companies[0].selectedPeriod).toBe("2026Q1");
    expect(alignFinancialPeriods({ ...base, policy: "explicit", fiscalPeriod: "2026Q2" }).companies[0].selectedPeriod).toBe("2026Q2");
    expect(() => alignFinancialPeriods({ ...base, policy: "common_latest", fiscalPeriod: "2026Q2" })).toThrow();
  });
});
