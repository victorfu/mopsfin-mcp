import { createHash } from "node:crypto";

import type { CompanyMetricsBatchResult } from "@/lib/mopsfin/batch";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { Catalog, MetricDefinition } from "@/lib/mopsfin/types";

export const SCREEN_METRIC_ROLES = [
  "roe",
  "net_profit",
  "operating_cashflow",
  "debt_ratio",
  "gross_margin",
  "operating_margin",
  "eps",
] as const;

export type ScreenMetricRole = (typeof SCREEN_METRIC_ROLES)[number];

type ScreenMetricUnitSemantic = "percent" | "twd_thousand" | "twd_per_share";

export const SCREEN_METRIC_ROLE_DEFINITIONS = {
  roe: {
    acceptedNames: ["權益報酬率"],
    acceptedCodes: ["ROE"],
    unitSemantic: "percent",
  },
  net_profit: {
    acceptedNames: ["稅後純益"],
    acceptedCodes: ["NetProfit", "NetIncome"],
    unitSemantic: "twd_thousand",
  },
  operating_cashflow: {
    acceptedNames: ["營業活動現金流量"],
    acceptedCodes: ["OperatingCashflow", "OperatingCashFlow"],
    unitSemantic: "twd_thousand",
  },
  debt_ratio: {
    acceptedNames: ["負債佔資產比率"],
    acceptedCodes: ["DebtRatio"],
    unitSemantic: "percent",
  },
  gross_margin: {
    acceptedNames: ["毛利率"],
    acceptedCodes: ["GrossMargin"],
    unitSemantic: "percent",
  },
  operating_margin: {
    acceptedNames: ["營業利益率"],
    acceptedCodes: ["OperatingMargin"],
    unitSemantic: "percent",
  },
  eps: {
    acceptedNames: ["每股盈餘"],
    acceptedCodes: ["EPS"],
    unitSemantic: "twd_per_share",
  },
} as const satisfies Record<
  ScreenMetricRole,
  {
    acceptedNames: readonly string[];
    acceptedCodes: readonly string[];
    unitSemantic: ScreenMetricUnitSemantic;
  }
>;

export interface ResolvedScreenFinancialMetric {
  role: ScreenMetricRole;
  metricCode: string;
  metricName: string;
  family: "data";
  unit: string;
  category: string;
  resolutionBasis: "exact_name" | "known_code_alias";
}

export interface ScreenMetricCatalogResolution {
  requiredFinancialMetricRoles: ScreenMetricRole[];
  resolvedFinancialMetrics: ResolvedScreenFinancialMetric[];
  catalogDiscoveredAt: string;
  catalogSnapshotId: string;
}

interface ResolutionIssue {
  role: ScreenMetricRole | "cross_role";
  kind:
    | "missing"
    | "ambiguous_name"
    | "ambiguous_code"
    | "name_code_conflict"
    | "unit_mismatch"
    | "cross_role_conflict";
  candidateCodes: string[];
  candidateUnits?: string[];
}

function unitSemantic(unit: string): ScreenMetricUnitSemantic | "unknown" {
  const normalized = unit
    .trim()
    .replaceAll(" ", "")
    .replaceAll("％", "%")
    .replace(/^新[臺台]幣/, "")
    .replaceAll("／", "/");
  if (normalized === "%") return "percent";
  if (normalized === "仟元" || normalized === "千元") return "twd_thousand";
  if (normalized === "元" || normalized === "元/股") return "twd_per_share";
  return "unknown";
}

function catalogSnapshotId(catalog: Catalog): string {
  const canonical = JSON.stringify({
    metrics: [...catalog.metrics]
      .map(({ code, name, unit, category, family }) => ({
        code,
        name,
        unit,
        category,
        family,
      }))
      .sort((left, right) =>
        left.family.localeCompare(right.family) ||
        left.code.localeCompare(right.code) ||
        left.name.localeCompare(right.name) ||
        left.unit.localeCompare(right.unit) ||
        left.category.localeCompare(right.category),
      ),
    industries: [...catalog.industries].sort((left, right) =>
      left.code.localeCompare(right.code) || left.name.localeCompare(right.name),
    ),
    financialInstitutions: [...catalog.financialInstitutions].sort((left, right) =>
      left.code.localeCompare(right.code) ||
      left.name.localeCompare(right.name) ||
      left.sector.localeCompare(right.sector),
    ),
    years: [...catalog.years].sort((left, right) => left - right),
    quarters: [...catalog.quarters].sort((left, right) => left - right),
  });
  return `mopsfin-catalog-${createHash("sha256").update(canonical).digest("hex")}`;
}

function resolvedMetric(
  role: ScreenMetricRole,
  metric: MetricDefinition,
  resolutionBasis: ResolvedScreenFinancialMetric["resolutionBasis"],
): ResolvedScreenFinancialMetric {
  return {
    role,
    metricCode: metric.code,
    metricName: metric.name,
    family: "data",
    unit: metric.unit,
    category: metric.category,
    resolutionBasis,
  };
}

function mismatch(catalog: Catalog, issues: ResolutionIssue[]): never {
  throwCatalogContractMismatch(
    {
      catalogDiscoveredAt: catalog.discoveredAt,
      catalogSnapshotId: catalogSnapshotId(catalog),
      requiredFinancialMetricRoles: [...SCREEN_METRIC_ROLES],
    },
    issues,
  );
}

export function throwCatalogContractMismatch(
  resolution: Pick<
    ScreenMetricCatalogResolution,
    "catalogDiscoveredAt" | "catalogSnapshotId" | "requiredFinancialMetricRoles"
  >,
  issues: unknown[],
): never {
  throw new MopsfinError(
    "UPSTREAM_BAD_RESPONSE",
    "Mopsfin 即時目錄不符合 screening 所需的七項財務語意契約。",
    {
      reason: "CATALOG_CONTRACT_MISMATCH",
      retryable: false,
      action: "none",
      details: {
        catalogDiscoveredAt: resolution.catalogDiscoveredAt,
        catalogSnapshotId: resolution.catalogSnapshotId,
        requiredFinancialMetricRoles: resolution.requiredFinancialMetricRoles,
        issues,
      },
    },
  );
}

export function resolveScreenMetricRoles(
  catalog: Catalog,
): ScreenMetricCatalogResolution {
  const dataMetrics = catalog.metrics.filter((metric) => metric.family === "data");
  const resolved: ResolvedScreenFinancialMetric[] = [];
  const issues: ResolutionIssue[] = [];

  for (const role of SCREEN_METRIC_ROLES) {
    const definition = SCREEN_METRIC_ROLE_DEFINITIONS[role];
    const nameMatches = dataMetrics.filter((metric) =>
      (definition.acceptedNames as readonly string[]).includes(metric.name),
    );
    const codeMatches = dataMetrics.filter((metric) =>
      (definition.acceptedCodes as readonly string[]).includes(metric.code),
    );
    if (nameMatches.length === 1) {
      const nameMatch = nameMatches[0] as MetricDefinition;
      const conflictingCodeMatches = codeMatches.filter(
        (metric) => metric.code !== nameMatch.code,
      );
      if (conflictingCodeMatches.length > 0) {
        issues.push({
          role,
          kind: "name_code_conflict",
          candidateCodes: [
            nameMatch.code,
            ...conflictingCodeMatches.map((metric) => metric.code),
          ].sort(),
        });
        continue;
      }
      if (unitSemantic(nameMatch.unit) !== definition.unitSemantic) {
        issues.push({
          role,
          kind: "unit_mismatch",
          candidateCodes: [nameMatch.code],
          candidateUnits: [nameMatch.unit],
        });
        continue;
      }
      resolved.push(resolvedMetric(role, nameMatch, "exact_name"));
      continue;
    }
    if (nameMatches.length > 1) {
      issues.push({
        role,
        kind: "ambiguous_name",
        candidateCodes: nameMatches.map((metric) => metric.code).sort(),
      });
      continue;
    }
    if (codeMatches.length === 1) {
      const codeMatch = codeMatches[0] as MetricDefinition;
      if (unitSemantic(codeMatch.unit) !== definition.unitSemantic) {
        issues.push({
          role,
          kind: "unit_mismatch",
          candidateCodes: [codeMatch.code],
          candidateUnits: [codeMatch.unit],
        });
        continue;
      }
      resolved.push(
        resolvedMetric(role, codeMatch, "known_code_alias"),
      );
      continue;
    }
    issues.push({
      role,
      kind: codeMatches.length === 0 ? "missing" : "ambiguous_code",
      candidateCodes: codeMatches.map((metric) => metric.code).sort(),
    });
  }

  const rolesByCode = new Map<string, ScreenMetricRole[]>();
  for (const metric of resolved) {
    const roles = rolesByCode.get(metric.metricCode) ?? [];
    roles.push(metric.role);
    rolesByCode.set(metric.metricCode, roles);
  }
  for (const [code, roles] of rolesByCode) {
    if (roles.length > 1) {
      issues.push({
        role: "cross_role",
        kind: "cross_role_conflict",
        candidateCodes: [code],
      });
    }
  }

  if (issues.length > 0 || resolved.length !== SCREEN_METRIC_ROLES.length) {
    mismatch(catalog, issues);
  }

  return {
    requiredFinancialMetricRoles: [...SCREEN_METRIC_ROLES],
    resolvedFinancialMetrics: resolved,
    catalogDiscoveredAt: catalog.discoveredAt,
    catalogSnapshotId: catalogSnapshotId(catalog),
  };
}

export function resolvedMetricCodes(
  resolution: ScreenMetricCatalogResolution,
): string[] {
  return resolution.resolvedFinancialMetrics.map((metric) => metric.metricCode);
}

export function assertScreenMetricBatchContract(
  resolution: ScreenMetricCatalogResolution,
  batch: Pick<
    CompanyMetricsBatchResult,
    "query" | "metricDefinitions" | "companies"
  >,
): void {
  const expectedCodes = resolvedMetricCodes(resolution);
  const expectedByCode = new Map(
    resolution.resolvedFinancialMetrics.map((metric) => [metric.metricCode, metric]),
  );
  const actualCodes = batch.metricDefinitions.map((metric) => metric.code);
  const issues: Array<Record<string, unknown>> = [];

  if (
    batch.query.metricCodes.length !== expectedCodes.length ||
    batch.query.metricCodes.some((code, index) => code !== expectedCodes[index])
  ) {
    issues.push({
      kind: "batch_query_metric_codes_mismatch",
      expectedCodes,
      actualCodes: batch.query.metricCodes,
    });
  }
  if (
    actualCodes.length !== expectedCodes.length ||
    new Set(actualCodes).size !== actualCodes.length ||
    actualCodes.some((code, index) => code !== expectedCodes[index])
  ) {
    issues.push({
      kind: "batch_metric_definitions_mismatch",
      expectedCodes,
      actualCodes,
    });
  }
  for (const definition of batch.metricDefinitions) {
    const expected = expectedByCode.get(definition.code);
    if (
      !expected ||
      definition.name !== expected.metricName ||
      definition.unit !== expected.unit
    ) {
      issues.push({
        kind: "batch_metric_definition_semantic_mismatch",
        metricCode: definition.code,
        expectedName: expected?.metricName ?? null,
        actualName: definition.name,
        expectedUnit: expected?.unit ?? null,
        actualUnit: definition.unit,
        expectedFamily: "data",
        actualFamily: "data_by_batch_contract",
      });
    }
  }
  for (const company of batch.companies) {
    const companyCodes = company.metrics.map((metric) => metric.metricCode);
    if (
      companyCodes.length !== expectedCodes.length ||
      new Set(companyCodes).size !== companyCodes.length ||
      expectedCodes.some((code) => !companyCodes.includes(code))
    ) {
      issues.push({
        kind: "batch_company_metric_set_mismatch",
        companyCode: company.companyCode,
        expectedCodes,
        actualCodes: companyCodes,
      });
    }
    for (const metric of company.metrics) {
      const expected = expectedByCode.get(metric.metricCode);
      const roleDefinition = expected
        ? SCREEN_METRIC_ROLE_DEFINITIONS[expected.role]
        : null;
      if (
        !expected ||
        !roleDefinition ||
        metric.metricName !== expected.metricName ||
        unitSemantic(metric.unit) !== roleDefinition.unitSemantic
      ) {
        issues.push({
          kind: "batch_company_metric_semantic_mismatch",
          companyCode: company.companyCode,
          metricCode: metric.metricCode,
          expectedName: expected?.metricName ?? null,
          actualName: metric.metricName,
          expectedUnitSemantic: roleDefinition?.unitSemantic ?? null,
          actualUnit: metric.unit,
        });
      }
    }
  }

  if (issues.length > 0) {
    throwCatalogContractMismatch(resolution, issues);
  }
}
