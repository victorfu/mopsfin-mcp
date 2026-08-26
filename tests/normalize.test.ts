import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normalizeTrendJson } from "@/lib/mopsfin/normalize";
import { sliceTrend } from "@/lib/mopsfin/periods";

function jsonFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as unknown;
}

describe("Mopsfin JSON normalization", () => {
  it.each(["data", "fin", "adequacy"])(
    "normalizes the %s line response shape including multiple companies",
    () => {
      const trend = normalizeTrendJson(jsonFixture("trend.json"));

      expect(trend.unit).toBe("%");
      expect(trend.series).toHaveLength(2);
      expect(trend.series[0].points[2]).toEqual({
        period: "2023Q4",
        value: null,
        valueStatus: "missing",
        status: "尚未申報",
      });
      expect(trend.series[0].points[3].value).toBe(-1.5);
    },
  );

  it("normalizes the bcode statistics bar response and preserves negatives", () => {
    const trend = normalizeTrendJson(jsonFixture("industry-statistics.json"));

    expect(trend.year).toBe(2026);
    expect(trend.quarter).toBe(1);
    expect(trend.periods).toEqual(["半導體業", "水泥工業"]);
    expect(trend.series[0].points[1].value).toBe(-2500);
  });

  it("returns only the latest 12 quarters by default", () => {
    const trend = sliceTrend(normalizeTrendJson(jsonFixture("trend.json")), {
      history: "recent_12",
    });

    expect(trend.periods).toHaveLength(12);
    expect(trend.periods[0]).toBe("2023Q3");
    expect(trend.periods.at(-1)).toBe("2026Q2");
    expect(trend.series.every((series) => series.points.length === 12)).toBe(true);
  });

  it("maps upstream no-data messages and malformed JSON structures to errors", () => {
    expect(() => normalizeTrendJson({ message: "查無資料" })).toThrow("查無資料");
    expect(() => normalizeTrendJson({ graphData: [] })).toThrow(/xaxisList/);
  });

  it("drops null and out-of-range point indexes instead of mapping them to the first period", () => {
    const trend = normalizeTrendJson({
      ylabel: "%",
      xaxisList: ["2013Q2", "2013Q4"],
      graphData: [
        {
          label: "銀行業資本適足性",
          data: [
            [0, 11.9138, "C"],
            [null, 15.0622, "C"],
            [2, 99, "C"],
          ],
        },
      ],
    });

    expect(trend.series[0].points).toEqual([
      {
        period: "2013Q2",
        value: 11.9138,
        valueStatus: "reported",
        status: "C",
      },
    ]);
    expect(trend.normalizationWarnings).toEqual([
      expect.stringContaining("2 個資料點缺少有效期別索引"),
    ]);
  });

  it("distinguishes upstream missing markers from malformed numeric values", () => {
    const trend = normalizeTrendJson({
      ylabel: "%",
      xaxisList: ["2025Q1", "2025Q2", "2025Q3", "2025Q4"],
      graphData: [
        {
          label: "2330 台積電",
          data: [[0, "1,234.5"], [1, "N/A"], [2, "oops"], [3, 0]],
        },
      ],
    });

    expect(trend.series[0].points).toEqual([
      { period: "2025Q1", value: 1234.5, valueStatus: "reported" },
      { period: "2025Q2", value: null, valueStatus: "missing" },
      { period: "2025Q3", value: null, valueStatus: "invalid_upstream" },
      { period: "2025Q4", value: 0, valueStatus: "reported" },
    ]);
    expect(trend.normalizationWarnings).toEqual([
      expect.stringContaining("invalid_upstream"),
    ]);
  });

  it("selects recent quarters from reported company data rather than average-only periods", () => {
    const trend = normalizeTrendJson(jsonFixture("company-metric-partial.json"));
    trend.series = trend.series.map((series) =>
      series.label === "TSMC"
        ? {
            label: series.label,
            points: series.points,
            seriesType: "company" as const,
            companyCode: "2330",
            companyName: "台積電",
            displayName: "2330 台積電",
          }
        : {
            label: series.label,
            points: series.points,
            seriesType: "other" as const,
          },
    );

    const sliced = sliceTrend(trend, {
      history: "recent_12",
      recentSeriesTypes: ["company"],
      recentReportedOnly: true,
    });

    expect(sliced.periods).toHaveLength(12);
    expect(sliced.periods[0]).toBe("2022Q2");
    expect(sliced.periods.at(-1)).toBe("2025Q1");
    expect(sliced.periods).not.toContain("2025Q2");
  });

  it("sorts periods chronologically and rejects duplicate upstream axes", () => {
    const trend = normalizeTrendJson({
      ylabel: "%",
      xaxisList: ["2025Q2", "2025Q1"],
      graphData: [
        { label: "2330 台積電", data: [[0, 2], [1, 1]] },
      ],
    });
    const sorted = sliceTrend(trend, { history: "all" });
    expect(sorted.periods).toEqual(["2025Q1", "2025Q2"]);
    expect(sorted.series[0].points.map((point) => point.value)).toEqual([1, 2]);

    const duplicate = normalizeTrendJson({
      ylabel: "%",
      xaxisList: ["2025Q1", "2025Q1"],
      graphData: [{ label: "2330 台積電", data: [[0, 1], [1, 2]] }],
    });
    expect(() => sliceTrend(duplicate, { history: "all" })).toThrow(
      /重複期別/,
    );
  });
});
