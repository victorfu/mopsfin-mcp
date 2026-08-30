import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FINANCIAL_SCREEN_METRIC_ROLES,
  isFinancialMetricApplicable,
  resolveFinancialScreenMetricRoles,
} from "@/lib/financial-screening/metric-roles";
import { parseCatalogHtml } from "@/lib/mopsfin/catalog";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);

describe("financial screening metric roles", () => {
  it("resolves all profitability, asset-quality and capital roles by exact catalog names", () => {
    const resolution = resolveFinancialScreenMetricRoles(
      parseCatalogHtml(catalogHtml, new Date("2026-08-30T00:00:00.000Z")),
    );

    expect(resolution.requiredMetricRoles).toEqual(FINANCIAL_SCREEN_METRIC_ROLES);
    expect(resolution.resolvedMetrics).toHaveLength(12);
    expect(resolution.catalogSnapshotId).toMatch(
      /^mopsfin-financial-catalog-[a-f0-9]{64}$/,
    );
    expect(resolution.resolvedMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "roe",
          metricCode: "ROE",
          family: "data",
          applicableSectors: ["holding", "bank", "bills"],
        }),
        expect.objectContaining({
          role: "loan_overdue_ratio",
          metricCode: "Fin01",
          family: "fin",
          applicableSectors: ["bank"],
        }),
        expect.objectContaining({
          role: "holding_capital_adequacy_ratio",
          metricCode: "HoldingCAR",
          family: "adequacy",
          applicableSectors: ["holding"],
        }),
      ]),
    );
  });

  it("enforces the holding, bank and bills applicability matrix", () => {
    const resolution = resolveFinancialScreenMetricRoles(parseCatalogHtml(catalogHtml));

    expect(
      isFinancialMetricApplicable(
        resolution,
        "holding_capital_adequacy_ratio",
        "holding",
      ),
    ).toBe(true);
    expect(
      isFinancialMetricApplicable(
        resolution,
        "holding_capital_adequacy_ratio",
        "bank",
      ),
    ).toBe(false);
    expect(
      isFinancialMetricApplicable(resolution, "loan_overdue_ratio", "bank"),
    ).toBe(true);
    expect(
      isFinancialMetricApplicable(resolution, "loan_overdue_ratio", "bills"),
    ).toBe(false);
  });

  it("fails closed when a required role is missing or has a wrong unit", () => {
    const missing = parseCatalogHtml(catalogHtml);
    missing.metrics = missing.metrics.filter((metric) => metric.code !== "BankCAR");
    expect(() => resolveFinancialScreenMetricRoles(missing)).toThrow(
      expect.objectContaining({
        code: "UPSTREAM_BAD_RESPONSE",
        reason: "FINANCIAL_CATALOG_CONTRACT_MISMATCH",
      }),
    );

    const wrongUnit = parseCatalogHtml(catalogHtml);
    wrongUnit.metrics = wrongUnit.metrics.map((metric) =>
      metric.code === "Fin01" ? { ...metric, unit: "元" } : metric
    );
    expect(() => resolveFinancialScreenMetricRoles(wrongUnit)).toThrow(
      expect.objectContaining({
        reason: "FINANCIAL_CATALOG_CONTRACT_MISMATCH",
      }),
    );
  });
});
