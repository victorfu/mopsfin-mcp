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
      { period: "2013Q2", value: 11.9138, status: "C" },
    ]);
    expect(trend.normalizationWarnings).toEqual([
      expect.stringContaining("2 個資料點缺少有效期別索引"),
    ]);
  });
});
