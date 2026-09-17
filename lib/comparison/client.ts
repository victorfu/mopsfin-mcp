import { mopsfinClient } from "@/lib/mopsfin/client";
import { companyMetricsBatchClient, type CompanyMetricsBatchResult } from "@/lib/mopsfin/batch";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { fingerprint } from "@/lib/mcp/cursor";
import { planResearchFields, researchFields, RESEARCH_FIELDS_VERSION } from "@/lib/research/fields";
import { financialMeaning } from "@/lib/research/financials";
import { addResearchSources, loadResearchMarketData, researchFailure, researchMarketDependencies, sourceContent, type ResearchFailure, type ResearchMarketDependencies } from "@/lib/research/market-data";
import { projectResearchRows } from "@/lib/research/projection";
import type { CellStatus } from "@/lib/research/types";
import { getCurrentDeadline } from "@/lib/upstream/reliability";
import { alignFinancialPeriods, completedQuarterWindow } from "./alignment";

import type { CompareCompaniesQuery } from "./types";
export type { CompareCompaniesQuery } from "./types";

export class ComparisonClient {
  constructor(
    private readonly marketDependencies: ResearchMarketDependencies = researchMarketDependencies,
    private readonly catalog: Pick<typeof mopsfinClient, "getCatalog"> = mopsfinClient,
    private readonly batch: Pick<typeof companyMetricsBatchClient, "getCompanyMetricsBatch"> = companyMetricsBatchClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async compareCompanies(query: CompareCompaniesQuery) {
    getCurrentDeadline()?.throwIfExpired();
    if (query.companyCodes.length < 1 || query.companyCodes.length > 20 || new Set(query.companyCodes).size !== query.companyCodes.length || query.companyCodes.some((code) => !/^\d{4}$/.test(code))) throw new MopsfinError("INVALID_ARGUMENT", "company_codes 必須是 1–20 個不重複的目前上市櫃公司代碼。");
    if (query.columns.length > 24 || new Set(query.columns).size !== query.columns.length) throw new MopsfinError("INVALID_ARGUMENT", "columns 最多 24 個且不可重複。");
    if (!["full", "compact", "summary"].includes(query.outputMode)) throw new MopsfinError("INVALID_ARGUMENT", "不支援的 output_mode。");
    if (query.marketDate !== "latest" && (!/^\d{4}-\d{2}-\d{2}$/.test(query.marketDate) || !Number.isFinite(Date.parse(query.marketDate)) || new Date(query.marketDate).toISOString().slice(0, 10) !== query.marketDate)) throw new MopsfinError("INVALID_ARGUMENT", "market_date 必須是 latest 或有效 YYYY-MM-DD。");
    if (query.revenueMonth !== "latest" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.revenueMonth)) throw new MopsfinError("INVALID_ARGUMENT", "revenue_month 必須是 latest 或 YYYY-MM。");
    const financialIds = query.columns.filter((id) => id.startsWith("financial."));
    if (financialIds.length > 8) throw new MopsfinError("INVALID_ARGUMENT", "季度財務欄位最多 8 項。");
    if (!financialIds.length && (query.financialPeriodPolicy !== undefined || query.fiscalPeriod !== undefined || query.financialBasis !== undefined)) throw new MopsfinError("INVALID_ARGUMENT", "沒有 financial 欄位時不得指定財務期間或口徑參數。");
    const policy = query.financialPeriodPolicy ?? "common_latest";
    if (!["common_latest", "company_latest", "explicit"].includes(policy) || (query.financialBasis !== undefined && query.financialBasis !== "quarterly")) throw new MopsfinError("INVALID_ARGUMENT", "不支援的財務期間策略或口徑。");
    if (policy === "explicit" ? !query.fiscalPeriod : query.fiscalPeriod !== undefined) throw new MopsfinError("INVALID_ARGUMENT", "只有 explicit 策略可以且必須指定 financial_period。");
    if (query.fiscalPeriod && !/^\d{4}Q[1-4]$/.test(query.fiscalPeriod)) throw new MopsfinError("INVALID_ARGUMENT", "financial_period 必須是 YYYYQn。");
    const evaluatedAt = this.now();
    const window = policy === "explicit" ? [query.fiscalPeriod!] : completedQuarterWindow(evaluatedAt);
    if (query.fiscalPeriod && query.fiscalPeriod > completedQuarterWindow(evaluatedAt).at(-1)!) throw new MopsfinError("INVALID_ARGUMENT", "financial_period 必須是已完成曆季。");
    const catalog = financialIds.length ? await this.catalog.getCatalog() : null;
    const plan = planResearchFields({ registry: researchFields(catalog?.metrics), tool: "compare_companies", columns: query.columns });
    const financialFields = plan.fields.filter((field) => field.domain === "financial");
    const master = await this.marketDependencies.master.listCompanies({ market: "all", includeFinancial: true, includeKy: true });
    getCurrentDeadline()?.throwIfExpired();
    const companies = query.companyCodes.map((code) => {
      const company = master.companies.find((entry) => entry.code === code);
      if (!company) throw new MopsfinError("NOT_FOUND", `目前上市櫃母體沒有公司 ${code}。`);
      return company;
    });
    const meanings = companies.flatMap((company) => financialFields.map((field) => {
      const metric = catalog!.metrics.find((entry) => `financial.${entry.code}` === field.id)!;
      return { companyCode: company.code, metricCode: metric.code, field: field.id, ...financialMeaning(metric, company, catalog!.financialInstitutions) };
    }));
    const metricCodes = financialFields.map((field) => field.id.slice("financial.".length)).filter((code) => meanings.some((item) => item.metricCode === code && item.applicability !== "not_applicable"));
    const market = companies.every((company) => company.market === companies[0].market) ? companies[0].market : "all";
    const [marketOutcome, financialOutcome] = await Promise.allSettled([
      loadResearchMarketData({ master, companies, fields: plan.fields, market, marketDate: query.marketDate, revenueMonth: query.revenueMonth, evaluatedAt }, this.marketDependencies),
      metricCodes.length ? this.batch.getCompanyMetricsBatch({ companyCodes: query.companyCodes, metricCodes, basis: "quarterly", startPeriod: window[0], endPeriod: window.at(-1)! }) : Promise.resolve(null),
    ]);
    getCurrentDeadline()?.throwIfExpired();
    if (marketOutcome.status === "rejected") throw marketOutcome.reason;
    const data = marketOutcome.value;
    const financialData: CompanyMetricsBatchResult | null = financialOutcome.status === "fulfilled" ? financialOutcome.value : null;
    const failures: ResearchFailure[] = [...data.failures];
    if (financialOutcome.status === "rejected") failures.push(researchFailure("financial", financialOutcome.reason));
    const alignment = financialFields.length ? alignFinancialPeriods({ companies: query.companyCodes, metrics: financialFields.map((field) => field.id.slice("financial.".length)), policy, window, fiscalPeriod: query.fiscalPeriod,
      series: meanings.map((meaning) => {
        const metric = financialData?.companies.find((company) => company.companyCode === meaning.companyCode)?.metrics.find((item) => item.metricCode === meaning.metricCode);
        return { companyCode: meaning.companyCode, metricCode: meaning.metricCode, applicability: meaning.applicability, reportedPeriods: metric?.points.filter((point) => point.valueStatus === "reported" && point.value !== null && Number.isFinite(point.value)).map((point) => point.period) ?? [] };
      }),
    }) : null;
    const financialSourceRefs = addResearchSources(data.sources, "financial", financialData?.sources ?? [], () => null);
    for (const row of data.rows) for (const field of financialFields) {
      const meaning = meanings.find((item) => item.companyCode === row.code && item.field === field.id)!;
      const company = financialData?.companies.find((item) => item.companyCode === row.code);
      const metric = company?.metrics.find((item) => item.metricCode === meaning.metricCode);
      const period = alignment!.companies.find((item) => item.companyCode === row.code)!.selectedPeriod;
      const point = metric?.points.find((item) => item.period === period);
      let status: CellStatus = "available";
      let reason: string | undefined;
      if (meaning.applicability === "not_applicable") { status = "not_applicable"; reason = "金融業不適用此財務指標。"; }
      else if (meaning.applicability === "unknown") { status = "missing"; reason = "applicability_unknown"; }
      else if (!financialData || metric?.availability === "unavailable" || company?.evaluationStatus === "unavailable") { status = "source_unavailable"; reason = metric?.failure?.message ?? "財務來源不可用。"; }
      else if (metric && metric.unit !== catalog!.metrics.find((item) => `financial.${item.code}` === field.id && item.family === "data")!.unit) { status = "invalid_upstream"; reason = "財務批次來源單位與欄位目錄不同；不猜測換算。"; }
      else if (!period) { status = "period_unaligned"; reason = "在共同曆季窗中沒有可用共同期間；不回退各自最新值。"; }
      else if (point?.valueStatus === "invalid_upstream" || (typeof point?.value === "number" && !Number.isFinite(point.value))) status = "invalid_upstream";
      else if (!point || point.valueStatus !== "reported" || point.value === null) status = "missing";
      const factor = field.normalization?.factor ?? 1;
      let value = status === "available" ? point!.value! * factor : null;
      if (typeof value === "number" && !Number.isFinite(value)) { value = null; status = "invalid_upstream"; reason = "標準化值不是有限數字。"; }
      row.cells[field.id] = {
        value, status, unit: field.unit, period, basis: "quarterly", definitionId: meaning.definitionId,
        sourceRefs: financialSourceRefs, freshness: "not_applicable",
        ...(reason ? { reason } : !meaning.definitionVerified ? { reason: meaning.meaning } : {}),
        ...(field.normalization && point ? { normalization: { sourceUnit: field.normalization.sourceUnit, sourceValue: point.value, factor } } : {}),
      };
    }
    const columnComparability = plan.fields.map((field) => {
      const cells = data.rows.map((row) => row.cells[field.id]);
      const definitions = [...new Set(cells.map((cell) => cell.definitionId))];
      const periods = [...new Set(cells.map((cell) => cell.period))];
      return { ...field, definitions, periods, definitionMismatch: definitions.length > 1, periodMismatch: periods.length > 1 };
    });
    return {
      query, evaluatedAt: evaluatedAt.toISOString(), registryVersion: RESEARCH_FIELDS_VERSION,
      columns: columnComparability, alignment, financialDefinitions: meanings,
      financialFreshness: { latestFilingVerified: false, periodSelection: "latest observed within calendar window or explicit; not filing vintage" },
      universe: { verification: master.coverageVerification, freshness: data.masterFreshness, currentMasterOnly: true, historicalPointInTime: false },
      resolvedDates: data.resolvedDates, presentation: projectResearchRows(data.rows, query.columns, query.outputMode, "entire_selection"),
      sources: data.sources, failures, financialFailures: financialData?.failures ?? [],
      sourceCoverage: data.domainCoverage, financialCoverage: financialData?.coverage ?? null, resolverEvidence: data.resolverEvidence,
      snapshotId: fingerprint({ registry: RESEARCH_FIELDS_VERSION, market: data.contentFingerprint, financial: sourceContent(financialData), rows: data.rows }),
      workBudget: { orchestrationMasterCalls: 1, catalogCalls: catalog ? 1 : 0, ...data.workBudget, financialBatchCalls: metricCodes.length ? 1 : 0, financialBatch: financialData?.workBudget ?? null, financialBatchDependencyCatalogLookup: metricCodes.length ? "dependency_managed" : "not_requested" },
      warnings: [...master.warnings, ...data.warnings, ...(financialData?.warnings ?? []), "各欄位保留自己的日期；market_date 並非整份比較的歷史 as-of。", ...(financialFields.length ? ["選定季度代表目前來源可觀察資料，不保證最新申報或當時已知 vintage。"] : [])],
    };
  }
}

export const comparisonClient = new ComparisonClient();
