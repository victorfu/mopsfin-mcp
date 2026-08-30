import { createHash } from "node:crypto";

import { MopsfinError } from "@/lib/mopsfin/errors";
import type { Catalog, EndpointFamily, MetricDefinition } from "@/lib/mopsfin/types";

import type { SupportedFinancialSector } from "./types";

export const FINANCIAL_SCREEN_METRIC_ROLES = [
  "roe",
  "net_profit",
  "eps",
  "loan_overdue_ratio",
  "loan_loss_reserve_coverage_ratio",
  "credit_card_overdue_ratio",
  "credit_card_loss_reserve_coverage_ratio",
  "factoring_overdue_ratio",
  "factoring_loss_reserve_coverage_ratio",
  "holding_capital_adequacy_ratio",
  "bank_capital_adequacy_ratio",
  "bills_capital_adequacy_ratio",
] as const;

export type FinancialScreenMetricRole =
  (typeof FINANCIAL_SCREEN_METRIC_ROLES)[number];

type UnitSemantic = "percent" | "twd_thousand" | "twd_per_share";

interface RoleDefinition {
  acceptedNames: readonly string[];
  acceptedCodes: readonly string[];
  family: Extract<EndpointFamily, "data" | "fin" | "adequacy">;
  unitSemantic: UnitSemantic;
  applicableSectors: readonly SupportedFinancialSector[];
}

const ALL_SUPPORTED_SECTORS = ["holding", "bank", "bills"] as const;

export const FINANCIAL_SCREEN_METRIC_ROLE_DEFINITIONS = {
  roe: {
    acceptedNames: ["權益報酬率"],
    acceptedCodes: ["ROE"],
    family: "data",
    unitSemantic: "percent",
    applicableSectors: ALL_SUPPORTED_SECTORS,
  },
  net_profit: {
    acceptedNames: ["稅後純益"],
    acceptedCodes: ["NetProfit", "NetIncome"],
    family: "data",
    unitSemantic: "twd_thousand",
    applicableSectors: ALL_SUPPORTED_SECTORS,
  },
  eps: {
    acceptedNames: ["每股盈餘"],
    acceptedCodes: ["EPS"],
    family: "data",
    unitSemantic: "twd_per_share",
    applicableSectors: ALL_SUPPORTED_SECTORS,
  },
  loan_overdue_ratio: {
    acceptedNames: ["放款業務逾放比率"],
    acceptedCodes: ["Fin01"],
    family: "fin",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  loan_loss_reserve_coverage_ratio: {
    acceptedNames: ["放款備抵呆帳覆蓋率"],
    acceptedCodes: ["Fin02"],
    family: "fin",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  credit_card_overdue_ratio: {
    acceptedNames: ["信用卡逾期帳款比率"],
    acceptedCodes: ["Fin03"],
    family: "fin",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  credit_card_loss_reserve_coverage_ratio: {
    acceptedNames: ["信用卡備抵呆帳覆蓋率"],
    acceptedCodes: ["Fin04"],
    family: "fin",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  factoring_overdue_ratio: {
    acceptedNames: ["應收帳款承購逾期比率"],
    acceptedCodes: ["Fin05"],
    family: "fin",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  factoring_loss_reserve_coverage_ratio: {
    acceptedNames: ["應收帳款承購覆蓋率"],
    acceptedCodes: ["Fin06"],
    family: "fin",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  holding_capital_adequacy_ratio: {
    acceptedNames: ["金控業集團資本適足率"],
    acceptedCodes: ["HoldingCAR"],
    family: "adequacy",
    unitSemantic: "percent",
    applicableSectors: ["holding"],
  },
  bank_capital_adequacy_ratio: {
    acceptedNames: ["銀行業資本適足率"],
    acceptedCodes: ["BankCAR"],
    family: "adequacy",
    unitSemantic: "percent",
    applicableSectors: ["bank"],
  },
  bills_capital_adequacy_ratio: {
    acceptedNames: ["票券業資本適足率"],
    acceptedCodes: ["BillsCAR"],
    family: "adequacy",
    unitSemantic: "percent",
    applicableSectors: ["bills"],
  },
} as const satisfies Record<FinancialScreenMetricRole, RoleDefinition>;

export interface ResolvedFinancialScreenMetric {
  role: FinancialScreenMetricRole;
  metricCode: string;
  metricName: string;
  family: Extract<EndpointFamily, "data" | "fin" | "adequacy">;
  unit: string;
  category: string;
  applicableSectors: SupportedFinancialSector[];
  resolutionBasis: "exact_name" | "known_code_alias";
}

export interface FinancialScreenMetricCatalogResolution {
  requiredMetricRoles: FinancialScreenMetricRole[];
  resolvedMetrics: ResolvedFinancialScreenMetric[];
  catalogDiscoveredAt: string;
  catalogSnapshotId: string;
}

interface ResolutionIssue {
  role: FinancialScreenMetricRole | "cross_role";
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

function unitSemantic(unit: string): UnitSemantic | "unknown" {
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

export function financialCatalogSnapshotId(catalog: Catalog): string {
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
        left.name.localeCompare(right.name)
      ),
    financialInstitutions: [...catalog.financialInstitutions].sort((left, right) =>
      left.code.localeCompare(right.code) ||
      left.name.localeCompare(right.name) ||
      left.sector.localeCompare(right.sector)
    ),
    periods: catalog.years.flatMap((year) =>
      catalog.quarters.map((quarter) => `${year}Q${quarter}`)
    ),
  });
  return `mopsfin-financial-catalog-${createHash("sha256").update(canonical).digest("hex")}`;
}

function mismatch(catalog: Catalog, issues: ResolutionIssue[]): never {
  throw new MopsfinError(
    "UPSTREAM_BAD_RESPONSE",
    "Mopsfin 即時目錄不符合金融 screening 所需的語意契約。",
    {
      reason: "FINANCIAL_CATALOG_CONTRACT_MISMATCH",
      retryable: false,
      action: "none",
      details: {
        catalogDiscoveredAt: catalog.discoveredAt,
        catalogSnapshotId: financialCatalogSnapshotId(catalog),
        requiredMetricRoles: [...FINANCIAL_SCREEN_METRIC_ROLES],
        issues,
      },
    },
  );
}

function resolvedMetric(
  role: FinancialScreenMetricRole,
  metric: MetricDefinition,
  resolutionBasis: ResolvedFinancialScreenMetric["resolutionBasis"],
): ResolvedFinancialScreenMetric {
  const definition = FINANCIAL_SCREEN_METRIC_ROLE_DEFINITIONS[role];
  return {
    role,
    metricCode: metric.code,
    metricName: metric.name,
    family: definition.family,
    unit: metric.unit,
    category: metric.category,
    applicableSectors: [...definition.applicableSectors],
    resolutionBasis,
  };
}

export function resolveFinancialScreenMetricRoles(
  catalog: Catalog,
): FinancialScreenMetricCatalogResolution {
  const resolved: ResolvedFinancialScreenMetric[] = [];
  const issues: ResolutionIssue[] = [];
  for (const role of FINANCIAL_SCREEN_METRIC_ROLES) {
    const definition = FINANCIAL_SCREEN_METRIC_ROLE_DEFINITIONS[role];
    const familyMetrics = catalog.metrics.filter(
      (metric) => metric.family === definition.family,
    );
    const nameMatches = familyMetrics.filter((metric) =>
      (definition.acceptedNames as readonly string[]).includes(metric.name)
    );
    const codeMatches = familyMetrics.filter((metric) =>
      (definition.acceptedCodes as readonly string[]).includes(metric.code)
    );
    if (nameMatches.length === 1) {
      const nameMatch = nameMatches[0];
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
      } else if (unitSemantic(nameMatch.unit) !== definition.unitSemantic) {
        issues.push({
          role,
          kind: "unit_mismatch",
          candidateCodes: [nameMatch.code],
          candidateUnits: [nameMatch.unit],
        });
      } else {
        resolved.push(resolvedMetric(role, nameMatch, "exact_name"));
      }
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
      const codeMatch = codeMatches[0];
      if (unitSemantic(codeMatch.unit) !== definition.unitSemantic) {
        issues.push({
          role,
          kind: "unit_mismatch",
          candidateCodes: [codeMatch.code],
          candidateUnits: [codeMatch.unit],
        });
      } else {
        resolved.push(resolvedMetric(role, codeMatch, "known_code_alias"));
      }
      continue;
    }
    issues.push({
      role,
      kind: codeMatches.length === 0 ? "missing" : "ambiguous_code",
      candidateCodes: codeMatches.map((metric) => metric.code).sort(),
    });
  }

  const rolesByCode = new Map<string, FinancialScreenMetricRole[]>();
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
  if (issues.length > 0 || resolved.length !== FINANCIAL_SCREEN_METRIC_ROLES.length) {
    mismatch(catalog, issues);
  }
  return {
    requiredMetricRoles: [...FINANCIAL_SCREEN_METRIC_ROLES],
    resolvedMetrics: resolved,
    catalogDiscoveredAt: catalog.discoveredAt,
    catalogSnapshotId: financialCatalogSnapshotId(catalog),
  };
}

export function resolvedFinancialMetric(
  resolution: FinancialScreenMetricCatalogResolution,
  role: FinancialScreenMetricRole,
): ResolvedFinancialScreenMetric {
  const metric = resolution.resolvedMetrics.find((candidate) => candidate.role === role);
  if (!metric) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `金融 screening metric resolution 缺少 ${role}。`,
      { reason: "FINANCIAL_CATALOG_CONTRACT_MISMATCH" },
    );
  }
  return metric;
}

export function isFinancialMetricApplicable(
  resolution: FinancialScreenMetricCatalogResolution,
  role: FinancialScreenMetricRole,
  sector: SupportedFinancialSector,
): boolean {
  return resolvedFinancialMetric(resolution, role).applicableSectors.includes(sector);
}
