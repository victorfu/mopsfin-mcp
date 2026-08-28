import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCatalogHtml } from "@/lib/mopsfin/catalog";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { Catalog } from "@/lib/mopsfin/types";
import {
  assertScreenMetricBatchContract,
  resolveScreenMetricRoles,
  SCREEN_METRIC_ROLES,
} from "@/lib/screening/metric-roles";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);

function currentCatalog(): Catalog {
  return parseCatalogHtml(fixture, new Date("2026-08-28T00:00:00.000Z"));
}

function expectCatalogMismatch(callback: () => unknown): MopsfinError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(MopsfinError);
    expect(error).toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CATALOG_CONTRACT_MISMATCH",
      retryable: false,
      action: "none",
    });
    return error as MopsfinError;
  }
  throw new Error("Expected CATALOG_CONTRACT_MISMATCH");
}

describe("screening semantic metric roles", () => {
  it("resolves all seven roles from the current catalog fixture by exact official name", () => {
    const result = resolveScreenMetricRoles(currentCatalog());

    expect(result.requiredFinancialMetricRoles).toEqual([...SCREEN_METRIC_ROLES]);
    expect(result.resolvedFinancialMetrics).toEqual([
      expect.objectContaining({ role: "roe", metricCode: "ROE" }),
      expect.objectContaining({ role: "net_profit", metricCode: "NetProfit" }),
      expect.objectContaining({
        role: "operating_cashflow",
        metricCode: "OperatingCashflow",
      }),
      expect.objectContaining({ role: "debt_ratio", metricCode: "DebtRatio" }),
      expect.objectContaining({ role: "gross_margin", metricCode: "GrossMargin" }),
      expect.objectContaining({
        role: "operating_margin",
        metricCode: "OperatingMargin",
      }),
      expect.objectContaining({ role: "eps", metricCode: "EPS" }),
    ]);
    expect(
      result.resolvedFinancialMetrics.every(
        (metric) => metric.family === "data" && metric.resolutionBasis === "exact_name",
      ),
    ).toBe(true);
    expect(result.catalogSnapshotId).toMatch(/^mopsfin-catalog-[a-f0-9]{64}$/);
  });

  it("uses known historical codes only as fallback when the formal names are absent", () => {
    const catalog = currentCatalog();
    catalog.metrics = catalog.metrics.map((metric) => {
      if (metric.code === "NetProfit") {
        return { ...metric, code: "NetIncome", name: "歷史獲利標籤" };
      }
      if (metric.code === "OperatingCashflow") {
        return {
          ...metric,
          code: "OperatingCashFlow",
          name: "歷史現金流標籤",
        };
      }
      return metric;
    });

    const result = resolveScreenMetricRoles(catalog);

    expect(result.resolvedFinancialMetrics).toContainEqual(
      expect.objectContaining({
        role: "net_profit",
        metricCode: "NetIncome",
        resolutionBasis: "known_code_alias",
      }),
    );
    expect(result.resolvedFinancialMetrics).toContainEqual(
      expect.objectContaining({
        role: "operating_cashflow",
        metricCode: "OperatingCashFlow",
        resolutionBasis: "known_code_alias",
      }),
    );
  });

  it("fails closed on missing, wrong-family, duplicate-name, and name/code conflicts", () => {
    const missing = currentCatalog();
    missing.metrics = missing.metrics.filter(
      (metric) => metric.code !== "NetProfit",
    );
    expectCatalogMismatch(() => resolveScreenMetricRoles(missing));

    const wrongFamily = currentCatalog();
    wrongFamily.metrics = wrongFamily.metrics.map((metric) =>
      metric.code === "NetProfit" ? { ...metric, family: "report" as const } : metric,
    );
    expectCatalogMismatch(() => resolveScreenMetricRoles(wrongFamily));

    const duplicateName = currentCatalog();
    duplicateName.metrics.push({
      code: "AnotherNetProfit",
      name: "稅後純益",
      unit: "新台幣仟元",
      category: "一般公司指標",
      family: "data",
    });
    const duplicateError = expectCatalogMismatch(() =>
      resolveScreenMetricRoles(duplicateName),
    );
    expect(duplicateError.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "net_profit", kind: "ambiguous_name" }),
      ]),
    );

    const nameCodeConflict = currentCatalog();
    nameCodeConflict.metrics.push({
      code: "NetIncome",
      name: "歷史獲利標籤",
      unit: "新台幣仟元",
      category: "一般公司指標",
      family: "data",
    });
    const conflictError = expectCatalogMismatch(() =>
      resolveScreenMetricRoles(nameCodeConflict),
    );
    expect(conflictError.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "net_profit", kind: "name_code_conflict" }),
      ]),
    );

    const ambiguousCode = currentCatalog();
    ambiguousCode.metrics = ambiguousCode.metrics.map((metric) =>
      metric.code === "NetProfit"
        ? { ...metric, name: "歷史獲利標籤" }
        : metric,
    );
    ambiguousCode.metrics.push({
      code: "NetIncome",
      name: "另一個歷史獲利標籤",
      unit: "新台幣仟元",
      category: "一般公司指標",
      family: "data",
    });
    const ambiguousCodeError = expectCatalogMismatch(() =>
      resolveScreenMetricRoles(ambiguousCode),
    );
    expect(ambiguousCodeError.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "net_profit", kind: "ambiguous_code" }),
      ]),
    );

    const wrongUnit = currentCatalog();
    wrongUnit.metrics = wrongUnit.metrics.map((metric) =>
      metric.code === "ROE" ? { ...metric, unit: "倍" } : metric,
    );
    const unitError = expectCatalogMismatch(() =>
      resolveScreenMetricRoles(wrongUnit),
    );
    expect(unitError.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "roe", kind: "unit_mismatch" }),
      ]),
    );
  });

  it("uses a content identity that is stable across discovery times and input ordering", () => {
    const first = currentCatalog();
    const second = {
      ...currentCatalog(),
      metrics: [...currentCatalog().metrics].reverse(),
      discoveredAt: "2026-08-29T00:00:00.000Z",
    };

    expect(resolveScreenMetricRoles(first).catalogSnapshotId).toBe(
      resolveScreenMetricRoles(second).catalogSnapshotId,
    );
  });

  it("rejects a fulfilled batch whose returned metric definitions drift from the resolution", () => {
    const resolution = resolveScreenMetricRoles(currentCatalog());
    const metricCodes = resolution.resolvedFinancialMetrics.map(
      (metric) => metric.metricCode,
    );
    const metricDefinitions = resolution.resolvedFinancialMetrics.map(
      ({ metricCode: code, metricName: name, unit, category }) => ({
        code,
        name,
        unit,
        category,
      }),
    );

    assertScreenMetricBatchContract(resolution, {
      query: {
        companyCodes: [],
        metricCodes,
        basis: "quarterly",
        history: "recent_12",
      },
      metricDefinitions,
      companies: [],
    });

    const error = expectCatalogMismatch(() =>
      assertScreenMetricBatchContract(resolution, {
        query: {
          companyCodes: [],
          metricCodes,
          basis: "quarterly",
          history: "recent_12",
        },
        metricDefinitions: metricDefinitions.map((definition) =>
          definition.code === "NetProfit"
            ? { ...definition, name: "漂移後名稱" }
            : definition,
        ),
        companies: [],
      }),
    );
    expect(error.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "batch_metric_definition_semantic_mismatch",
          metricCode: "NetProfit",
        }),
      ]),
    );

    const unitError = expectCatalogMismatch(() =>
      assertScreenMetricBatchContract(resolution, {
        query: {
          companyCodes: [],
          metricCodes,
          basis: "quarterly",
          history: "recent_12",
        },
        metricDefinitions: metricDefinitions.map((definition) =>
          definition.code === "ROE"
            ? { ...definition, unit: "倍" }
            : definition,
        ),
        companies: [],
      }),
    );
    expect(unitError.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "batch_metric_definition_semantic_mismatch",
          metricCode: "ROE",
        }),
      ]),
    );
  });
});
