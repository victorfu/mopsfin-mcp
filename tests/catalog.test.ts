import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCatalogHtml } from "@/lib/mopsfin/catalog";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);

describe("parseCatalogHtml", () => {
  it("classifies all 53 compareItem definitions into endpoint families", () => {
    const catalog = parseCatalogHtml(fixture, new Date("2026-08-24T00:00:00Z"));

    expect(catalog.metrics).toHaveLength(53);
    expect(
      Object.fromEntries(
        ["data", "report", "bcode", "xb", "fin", "adequacy"].map(
          (family) => [
            family,
            catalog.metrics.filter((metric) => metric.family === family).length,
          ],
        ),
      ),
    ).toEqual({
      data: 34,
      report: 3,
      bcode: 2,
      xb: 5,
      fin: 6,
      adequacy: 3,
    });
  });

  it("extracts industries, financial institution sectors and periods", () => {
    const catalog = parseCatalogHtml(fixture);

    expect(catalog.industries).toContainEqual({ code: "24", name: "半導體業" });
    expect(catalog.financialInstitutions).toEqual([
      { code: "2881", name: "富邦金", sector: "holding" },
      { code: "0040000", name: "臺銀", sector: "bank" },
      { code: "2872", name: "台灣票券", sector: "bills" },
    ]);
    expect(catalog.years).toEqual([2025, 2026]);
    expect(catalog.quarters).toEqual([1, 2, 3, 4]);
  });

  it("fails loudly when the upstream DOM structure no longer has a catalog", () => {
    expect(() => parseCatalogHtml("<html><body>changed</body></html>"))
      .toThrow(/網站結構可能已變更/);
  });
});
