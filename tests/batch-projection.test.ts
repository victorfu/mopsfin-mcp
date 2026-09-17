import { describe, expect, it } from "vitest";
import { compactFinancialBatch, decodeBatchPoints, summarizeFinancialBatch } from "@/lib/research/batch-projection";
import { comparisonFixture } from "./fixtures/research-comparison";
import { buildResultMeta } from "@/lib/mcp/result-contract";

describe("financial batch presentations", () => {
  it("round-trips every original metric, point status and coverage with at least 50% savings for 20 × 8 × 12", () => {
    const { data } = comparisonFixture();
    const base = data.companies[0];
    const periods = Array.from({ length: 12 }, (_, index) => `${2023 + Math.floor(index / 4)}Q${1 + index % 4}`);
    data.companies = Array.from({ length: 20 }, (_, companyIndex) => ({
      ...base, companyCode: String(2000 + companyIndex),
      metrics: Array.from({ length: 8 }, (_, metricIndex) => ({
        ...base.metrics[0], metricCode: `Metric${metricIndex}`, periods,
        points: periods.map((period, index) => ({ period, value: index === 0 ? null : companyIndex + metricIndex + index / 10, valueStatus: index === 0 ? "missing" as const : "reported" as const, ...(index === 0 ? { status: "--" } : {}) })),
        coverage: { ...base.metrics[0].coverage, nonNullPoints: 11, missingPoints: 1, firstReportedPeriod: periods[1], latestReportedPeriod: periods[11], missingPeriods: [periods[0]] },
      })),
    }));
    const compact = compactFinancialBatch(data);
    const restored = compact.companies.map(({ metrics, ...company }) => ({
      ...company, metrics: metrics.map((metric) => ({
        ...compact.metricMetadata[metric.metadataIndex],
        periods: metric.periodIndexes.map((index) => compact.periods[index]),
        points: decodeBatchPoints(metric.points, compact.periods),
      })),
    }));
    expect(restored).toEqual(data.companies);
    const { companies: removed, ...metadata } = data;
    void removed;
    const meta = buildResultMeta(data);
    const fullBytes = Buffer.byteLength(JSON.stringify({ ...data, ok: true, meta }));
    const compactBytes = Buffer.byteLength(JSON.stringify({ ...metadata, ok: true, meta, outputMode: "compact", rawCompaniesOmitted: true, presentation: compact }));
    expect(compactBytes / fullBytes).toBeLessThan(0.5);
  });

  it("separates industry-dependent definitions and quarters without suppressing missing values", () => {
    const { data } = comparisonFixture();
    const eps = data.companies[0].metrics[1];
    eps.points[1] = { period: "2026Q2", value: null, valueStatus: "invalid_upstream", status: "bad" };
    const summary = summarizeFinancialBatch(data);
    expect(summary.scope).toBe("current_page");
    expect(summary.evaluatedCompanyCodes).toEqual(data.coverage.requestedCompanyCodes);
    expect(summary.groups.filter((group) => group.metricCode === "Revenue").every((group) => group.companyCodes.length === 1)).toBe(true);
    expect(summary.groups.find((group) => group.metricCode === "EPS" && group.period === "2026Q1")).toMatchObject({ count: 3, min: 2.5, max: 2.5, median: 2.5 });
    expect(summary.groups.find((group) => group.metricCode === "EPS" && group.period === "2026Q2")).toMatchObject({ companyCodes: ["2881"], count: 1 });
    expect(summary.metricCoverage.find((item) => item.metricCode === "EPS")).toMatchObject({ pointStatuses: { reported: 4, invalid_upstream: 1 } });
    const compact = compactFinancialBatch(data);
    expect(decodeBatchPoints(compact.companies[0].metrics[1].points, compact.periods)).toEqual(eps.points);
  });
});
