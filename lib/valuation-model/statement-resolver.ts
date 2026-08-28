import type { MasterCompany } from "@/lib/company-master/types";
import type { StatementKind } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { NormalizedTable } from "@/lib/mopsfin/types";

export interface FinancialStatementResultLike {
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  upstreamRoute: string;
  query: {
    statement: StatementKind;
    companyCodes: string[];
    companies: string[];
    period: string;
  };
  unit: string;
  unitSource?: "response_html" | "catalog" | "unavailable";
  period: string;
  reportNames: string[];
  tables: NormalizedTable[];
  pagination: {
    offset: number;
    limit: number;
    returnedRows: number;
    totalRows: number;
    nextOffset: number | null;
  };
  cache?: import("@/lib/upstream/cache-provenance").CacheProvenance;
}

export interface ResolvedStatementRow {
  label: string;
  rawValue: string;
  valueTwd: number | null;
}

export interface ResolvedStatement {
  statement: StatementKind;
  period: string;
  companyCode: string;
  companyName: string;
  reportName: string;
  rawUnit: string;
  unitSource: "response_html" | "catalog" | "unavailable";
  amountMultiplier: 1000;
  consolidationScope: "consolidated" | "standalone";
  rows: ResolvedStatementRow[];
  source: Pick<
    FinancialStatementResultLike,
    "sourceName" | "sourceUrl" | "retrievedAt" | "upstreamRoute" | "cache"
  >;
}

export type StatementRoleResolution =
  | {
      status: "resolved";
      role: string;
      row: ResolvedStatementRow;
      candidateRowLabels: string[];
    }
  | {
      status: "missing" | "ambiguous" | "invalid";
      role: string;
      row: null;
      candidateRowLabels: string[];
    };

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[－–—]/g, "-")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function fail(
  reason: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason,
    category: "upstream",
    retryable: false,
    action: "none",
    details,
  });
}

function flattenedHeaders(table: NormalizedTable): string[] {
  return table.headers.flat().map((value) => value.trim()).filter(Boolean);
}

function identityMatches(value: string, company: MasterCompany): boolean {
  const normalized = canonical(value);
  const aliases = [company.shortName, company.name]
    .map(canonical)
    .filter(Boolean);
  return normalized.includes(canonical(company.code)) &&
    aliases.some((alias) => normalized.includes(alias));
}

function parseAmount(raw: string): number | null {
  let value = raw
    .replaceAll(",", "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .trim();
  if (!value || /^(?:-|--|---|—|－|N\/?A|null)$/i.test(value)) return null;
  const parenthesized = /^\((\d+(?:\.\d*)?|\.\d+)\)$/.exec(value);
  if (parenthesized) value = `-${parenthesized[1]}`;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const amount = number * 1000;
  return Number.isSafeInteger(amount) ? amount : null;
}

function tableCandidates(
  tables: NormalizedTable[],
  company: MasterCompany,
): { labelTables: NormalizedTable[]; valueTables: NormalizedTable[] } {
  return {
    labelTables: tables.filter((table) =>
      flattenedHeaders(table).some((header) =>
        ["會計科目", "會計項目"].includes(canonical(header)),
      ),
    ),
    valueTables: tables.filter((table) =>
      flattenedHeaders(table).some((header) => identityMatches(header, company)),
    ),
  };
}

function resolveScope(table: NormalizedTable): "consolidated" | "standalone" {
  const headers = flattenedHeaders(table).map(canonical);
  const consolidated = headers.filter((header) => header === "合併").length;
  const standalone = headers.filter((header) =>
    ["個別", "個體"].includes(header),
  ).length;
  if (consolidated === 1 && standalone === 0) return "consolidated";
  if (standalone === 1 && consolidated === 0) return "standalone";
  fail(
    "STATEMENT_CONSOLIDATION_SCOPE_MISMATCH",
    "Mopsfin 報表無法唯一判定合併或個別範圍。",
    { headers: flattenedHeaders(table) },
  );
}

export function resolveFinancialStatement(
  result: FinancialStatementResultLike,
  company: MasterCompany,
  expectedStatement: StatementKind,
  expectedPeriod?: string,
): ResolvedStatement {
  if (
    result.query.statement !== expectedStatement ||
    result.period !== result.query.period ||
    (expectedPeriod !== undefined && result.period !== expectedPeriod)
  ) {
    fail("STATEMENT_CONTRACT_MISMATCH", "Mopsfin 報表種類或期別與請求不一致。", {
      expectedStatement,
      expectedPeriod: expectedPeriod ?? null,
      actualStatement: result.query.statement,
      period: result.period,
      queryPeriod: result.query.period,
    });
  }
  if (
    result.query.companyCodes.length !== 1 ||
    result.query.companyCodes[0] !== company.code ||
    result.query.companies.length !== 1 ||
    !identityMatches(result.query.companies[0], company)
  ) {
    fail("STATEMENT_IDENTITY_MISMATCH", "Mopsfin 報表 query identity 與公司 master 不一致。", {
      companyCode: company.code,
      query: result.query,
    });
  }
  const matchingReports = result.reportNames.filter((name) =>
    identityMatches(name, company),
  );
  if (matchingReports.length !== 1 || result.reportNames.length !== 1) {
    fail("STATEMENT_IDENTITY_MISMATCH", "Mopsfin 報表名稱無法唯一核對公司 identity。", {
      companyCode: company.code,
      reportNames: result.reportNames,
    });
  }
  if (
    result.pagination.offset !== 0 ||
    result.pagination.nextOffset !== null ||
    result.pagination.returnedRows !== result.pagination.totalRows
  ) {
    fail("STATEMENT_CONTRACT_MISMATCH", "估值輸入需要完整未分頁的 Mopsfin 報表。", {
      pagination: result.pagination,
    });
  }
  const unit = canonical(result.unit);
  if (!unit) {
    fail("STATEMENT_UNIT_UNAVAILABLE", "Mopsfin 報表沒有可核對的金額單位。", {
      period: result.period,
      statement: expectedStatement,
    });
  }
  if (!["新台幣仟元", "新台幣千元"].includes(unit)) {
    fail("STATEMENT_UNIT_UNSUPPORTED", "Mopsfin 報表金額單位不支援估值輸入正規化。", {
      period: result.period,
      statement: expectedStatement,
      unit: result.unit,
    });
  }
  if (!result.unitSource || result.unitSource === "unavailable") {
    fail(
      "STATEMENT_UNIT_UNAVAILABLE",
      "Mopsfin 報表金額單位沒有可驗證的 response 或 catalog 來源。",
      {
        period: result.period,
        statement: expectedStatement,
        unit: result.unit,
        unitSource: result.unitSource ?? null,
      },
    );
  }
  const candidates = tableCandidates(result.tables, company);
  if (candidates.labelTables.length !== 1 || candidates.valueTables.length !== 1) {
    fail("STATEMENT_CONTRACT_MISMATCH", "Mopsfin 報表無法唯一解析科目表與公司數值表。", {
      labelTableCount: candidates.labelTables.length,
      valueTableCount: candidates.valueTables.length,
      tableTitles: result.tables.map((table) => table.title),
    });
  }
  const labels = candidates.labelTables[0].rows;
  const values = candidates.valueTables[0].rows;
  if (labels.length === 0 || labels.length !== values.length) {
    fail("STATEMENT_CONTRACT_MISMATCH", "Mopsfin 科目表與數值表列數不一致。", {
      labelRows: labels.length,
      valueRows: values.length,
    });
  }
  const rows = labels.map((labelRow, index): ResolvedStatementRow => {
    const valueRow = values[index];
    const labelsPresent = labelRow.filter((value) => value.trim() !== "");
    const valuesPresent = valueRow.filter((value) => value.trim() !== "");
    if (labelsPresent.length !== 1 || valuesPresent.length !== 1) {
      fail("STATEMENT_CONTRACT_MISMATCH", "Mopsfin 報表列不是單一科目對單一公司值。", {
        index,
        labelRow,
        valueRow,
      });
    }
    const valueTwd = parseAmount(valuesPresent[0]);
    return {
      label: labelsPresent[0].trim(),
      rawValue: valuesPresent[0].trim(),
      valueTwd,
    };
  });
  return {
    statement: expectedStatement,
    period: result.period,
    companyCode: company.code,
    companyName: company.shortName,
    reportName: matchingReports[0],
    rawUnit: result.unit,
    unitSource: result.unitSource ?? "unavailable",
    amountMultiplier: 1000,
    consolidationScope: resolveScope(candidates.valueTables[0]),
    rows,
    source: {
      sourceName: result.sourceName,
      sourceUrl: result.sourceUrl,
      retrievedAt: result.retrievedAt,
      upstreamRoute: result.upstreamRoute,
      ...(result.cache ? { cache: result.cache } : {}),
    },
  };
}

export function resolveStatementRole(
  statement: ResolvedStatement,
  role: string,
  acceptedLabels: readonly string[],
): StatementRoleResolution {
  const accepted = new Set(acceptedLabels.map(canonical));
  const matches = statement.rows.filter((row) => accepted.has(canonical(row.label)));
  const candidateRowLabels = matches.map((row) => row.label);
  if (matches.length === 0) {
    return { status: "missing", role, row: null, candidateRowLabels };
  }
  if (matches.length !== 1) {
    return { status: "ambiguous", role, row: null, candidateRowLabels };
  }
  if (!Number.isSafeInteger(matches[0].valueTwd)) {
    return { status: "invalid", role, row: null, candidateRowLabels };
  }
  return { status: "resolved", role, row: matches[0], candidateRowLabels };
}

export function canonicalStatementLabel(value: string): string {
  return canonical(value);
}
