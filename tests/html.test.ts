import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { paginateTables, parseHtmlTables } from "@/lib/mopsfin/html";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/report.html", import.meta.url)),
  "utf8",
);

describe("Mopsfin HTML table normalization", () => {
  it("expands rowspan and colspan into complete two-dimensional cells", () => {
    const parsed = parseHtmlTables(fixture);

    expect(parsed.period).toBe("20261");
    expect(parsed.unit).toBe("新台幣仟元");
    expect(parsed.reportNames).toEqual(["資產負債表"]);
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0].headers).toEqual([
      ["會計項目", "2026Q1", "2026Q1"],
      ["會計項目", "2330 台積電", "2454 聯發科"],
    ]);
    expect(parsed.tables[0].rows).toEqual([
      ["資產", "100", "80"],
      ["資產", "-20", "—"],
    ]);
  });

  it("paginates across normalized table rows", () => {
    const page = paginateTables(parseHtmlTables(fixture), 1, 1);

    expect(page.tables[0].rows).toEqual([["資產", "-20", "—"]]);
    expect(page.pagination).toEqual({
      offset: 1,
      limit: 1,
      returnedRows: 1,
      totalRows: 2,
      nextOffset: null,
    });
  });

  it("rejects span amplification before expanding the table", () => {
    expect(() =>
      parseHtmlTables("<table><tr><td colspan='1001'>x</td></tr></table>"),
    ).toThrowError(/colspan 超出安全範圍/);
  });

  it("rejects oversized HTML before parsing", () => {
    expect(() => parseHtmlTables("x".repeat(8_000_001))).toThrowError(
      /回應大小超出安全上限/,
    );
  });

  it("rejects conflicting units rendered in one upstream response", () => {
    expect(() =>
      parseHtmlTables(
        "<body><span>金額單位：新台幣仟元</span><span>金額單位：美元</span></body>",
      ),
    ).toThrowError(/多個互相衝突的報表單位/);
  });

  it("does not mistake unrelated note units for the report amount unit", () => {
    const parsed = parseHtmlTables(
      "<body><p>數量單位：股</p><p>比率單位：%</p><table><tr><td>x</td></tr></table></body>",
    );

    expect(parsed.unit).toBeUndefined();
  });
});
