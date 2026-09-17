import { companyMasterClient } from "@/lib/company-master/client";
import type { CompanyMarket, CompanyMarketSelection, CompanyMasterResult, MasterCompany } from "@/lib/company-master/types";
import { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import { fingerprint } from "@/lib/mcp/cursor";
import { asMopsfinError, MopsfinError } from "@/lib/mopsfin/errors";
import { priceClient } from "@/lib/price/client";
import type { DailyMarketOhlcResult } from "@/lib/price/types";
import { monthlyRevenueClient } from "@/lib/revenue/client";
import type { MonthlyRevenueResult } from "@/lib/revenue/types";
import { valuationClient } from "@/lib/valuation/client";
import type { DailyMarketValuationResult } from "@/lib/valuation/types";
import { getCurrentDeadline } from "@/lib/upstream/reliability";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import type { CellStatus, CellValue, ResearchCell, ResearchDomain, ResearchField, ResearchRow } from "./types";

export interface ResearchSource {
  id: string;
  domain: ResearchDomain;
  sourceUrl: string;
  cutoff: string | null;
  retrievedAt: string;
  cache?: CacheProvenance;
  evidence: object;
}
export interface ResearchFailure { domain: ResearchDomain; code: string; reason: string | null; message: string }
export interface ResearchMarketDependencies {
  master: Pick<typeof companyMasterClient, "listCompanies">;
  resolver: Pick<typeof completedSessionResolver, "resolve">;
  price: Pick<typeof priceClient, "getDailyMarketOhlc">;
  valuation: Pick<typeof valuationClient, "getDailyMarketValuation">;
  revenue: Pick<typeof monthlyRevenueClient, "getMonthlyRevenue">;
}
export const researchMarketDependencies: ResearchMarketDependencies = {
  master: companyMasterClient, resolver: completedSessionResolver, price: priceClient,
  valuation: valuationClient, revenue: monthlyRevenueClient,
};

export function taipeiToday(now: Date): string { return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10); }

export function sourceContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sourceContent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["retrievedAt", "generatedAt", "evaluatedAt", "cache", "servedAt", "assembledAt"].includes(key)).map(([key, item]) => [key, sourceContent(item)]));
}

export function addResearchSources<T extends { sourceUrl: string; retrievedAt: string; cache?: CacheProvenance }>(
  table: ResearchSource[], domain: ResearchDomain, items: T[], cutoff: (item: T) => string | null,
): string[] {
  return [...new Set(items.map((item) => {
    const date = cutoff(item);
    const id = `src_${fingerprint({ domain, sourceUrl: item.sourceUrl, cutoff: date, evidence: sourceContent(item) })}`;
    if (!table.some((entry) => entry.id === id)) table.push({ id, domain, sourceUrl: item.sourceUrl, cutoff: date, retrievedAt: item.retrievedAt, ...(item.cache ? { cache: item.cache } : {}), evidence: item });
    return id;
  }))];
}

export function researchFailure(domain: ResearchDomain, error: unknown): ResearchFailure {
  const normalized = asMopsfinError(error);
  return { domain, code: normalized.code, reason: normalized.reason ?? null, message: normalized.message };
}

function recentMaster(master: CompanyMasterResult, market: CompanyMarket, today: string): ResearchCell["freshness"] {
  const sources = master.sources.filter((source) => source.market === market);
  if (!sources.length) return "unverified";
  const ages = sources.map((source) => (Date.parse(today) - Date.parse(source.reportDate)) / 86400_000);
  if (ages.some((age) => !Number.isFinite(age) || age < 0)) return "unverified";
  return ages.some((age) => age > 7) ? "stale" : "fresh";
}

function makeCell(field: ResearchField, value: CellValue, options: Partial<Omit<ResearchCell, "value">>): ResearchCell {
  const invalid = typeof value === "number" && !Number.isFinite(value);
  return {
    unit: field.unit, period: null, basis: field.basis, definitionId: field.definitionId,
    sourceRefs: [], freshness: "unverified", ...options,
    status: invalid ? "invalid_upstream" : value === null && options.status === "available" ? "missing" : options.status ?? (value === null ? "missing" : "available"),
    value: invalid ? null : value,
  };
}
function byIdentity<T extends { market: CompanyMarket; code: string }>(rows: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.market}:${row.code}`;
    if (result.has(key)) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", `研究來源存在重複公司：${key}`);
    result.set(key, row);
  }
  return result;
}
function reportedStatus(status: string | undefined): CellStatus {
  return status === "invalid_upstream" ? "invalid_upstream" : status === "reported" ? "available" : "missing";
}

/** Bulk-only market joins shared by screening and comparison. */
export async function loadResearchMarketData(options: {
  master: CompanyMasterResult; companies: MasterCompany[]; fields: ResearchField[];
  market: CompanyMarketSelection; marketDate: string; revenueMonth: string; evaluatedAt: Date;
}, dependencies: ResearchMarketDependencies = researchMarketDependencies) {
  const { master, companies, fields, market, marketDate, revenueMonth, evaluatedAt } = options;
  const domains = new Set(fields.map((field) => field.domain));
  const sources: ResearchSource[] = [];
  const failures: ResearchFailure[] = [];
  const warnings: string[] = [];
  let resolverEvidence: CompletedSessionResolverEvidence | null = null;
  let resolvedDate: string | null = marketDate === "latest" ? null : marketDate;
  const needDaily = domains.has("price") || domains.has("valuation");
  if (needDaily) {
    getCurrentDeadline()?.throwIfExpired();
    try {
      resolverEvidence = await dependencies.resolver.resolve({ market, evaluatedAt });
      if (resolverEvidence.status !== "resolved" || !resolverEvidence.expectedAsOf) throw new MopsfinError("INCOMPLETE_COVERAGE", "無法取得所選市場共同完成交易日。", { reason: "COMMON_COMPLETED_DATE_UNRESOLVED" });
      if (marketDate === "latest") resolvedDate = resolverEvidence.expectedAsOf;
      else if (marketDate > resolverEvidence.expectedAsOf) throw new MopsfinError("INVALID_ARGUMENT", "market_date 尚未完成交易。");
    } catch (error) {
      if (error instanceof MopsfinError && error.code === "INVALID_ARGUMENT") throw error;
      resolvedDate = null;
      for (const domain of ["price", "valuation"] as const) if (domains.has(domain)) failures.push(researchFailure(domain, error));
    }
  }
  let price: DailyMarketOhlcResult | null = null;
  let valuation: DailyMarketValuationResult | null = null;
  let revenue: MonthlyRevenueResult | null = null;
  const jobs: Array<{ domain: "price" | "valuation" | "revenue"; run: () => Promise<void> }> = [];
  if (domains.has("price") && resolvedDate) jobs.push({ domain: "price", run: async () => {
    const result = await dependencies.price.getDailyMarketOhlc({ market, date: resolvedDate!, universePolicy: "compatible" });
    if (result.dataDate !== resolvedDate || result.bars.some((bar) => bar.date !== resolvedDate) || result.sources.some((source) => source.dataDate && source.dataDate !== resolvedDate)) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "日行情來源日期不一致。");
    byIdentity(result.bars); price = result;
  } });
  if (domains.has("valuation") && resolvedDate) jobs.push({ domain: "valuation", run: async () => {
    const result = await dependencies.valuation.getDailyMarketValuation({ market, date: resolvedDate!, universePolicy: "compatible" });
    if (result.dataDate !== resolvedDate || result.sources.some((source) => source.dataDate !== resolvedDate)) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "估值來源日期不一致。");
    byIdentity(result.rows); valuation = result;
  } });
  if (domains.has("revenue")) jobs.push({ domain: "revenue", run: async () => {
    const result = await dependencies.revenue.getMonthlyRevenue({ market, dataMonth: revenueMonth, universePolicy: "compatible" });
    if ((revenueMonth !== "latest" && result.dataMonth !== revenueMonth) || result.sources.some((source) => source.dataMonth !== result.dataMonth)) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "月營收月份不一致；請指定共同月份。", { reason: "REVENUE_MONTH_UNALIGNED" });
    byIdentity(result.rows); revenue = result;
  } });
  const outcomes = await Promise.allSettled(jobs.map(async (job) => { getCurrentDeadline()?.throwIfExpired(); await job.run(); }));
  getCurrentDeadline()?.throwIfExpired();
  outcomes.forEach((outcome, index) => { if (outcome.status === "rejected") failures.push(researchFailure(jobs[index].domain, outcome.reason)); });
  // Async callbacks assign these snapshots; explicit type anchors avoid TS narrowing them to null.
  const prices = price as DailyMarketOhlcResult | null;
  const valuations = valuation as DailyMarketValuationResult | null;
  const revenues = revenue as MonthlyRevenueResult | null;
  const priceRows = byIdentity(prices?.bars ?? []), valuationRows = byIdentity(valuations?.rows ?? []), revenueRows = byIdentity(revenues?.rows ?? []);
  const sourceRefsByMarket = new Map<string, string[]>();
  const masterFreshness = (["listed", "otc"] as const).filter((item) => market === "all" || market === item).map((item) => ({ market: item, freshness: recentMaster(master, item, taipeiToday(evaluatedAt)) }));
  for (const companyMarket of ["listed", "otc"] as const) {
    sourceRefsByMarket.set(`company:${companyMarket}`, addResearchSources(sources, "company", master.sources.filter((source) => source.market === companyMarket), (source) => source.reportDate));
    sourceRefsByMarket.set(`price:${companyMarket}`, addResearchSources(sources, "price", (prices?.sources ?? []).filter((source) => source.market === companyMarket), (source) => source.dataDate ?? source.dataMonth ?? null));
    sourceRefsByMarket.set(`valuation:${companyMarket}`, addResearchSources(sources, "valuation", (valuations?.sources ?? []).filter((source) => source.market === companyMarket), (source) => source.dataDate));
    sourceRefsByMarket.set(`revenue:${companyMarket}`, addResearchSources(sources, "revenue", (revenues?.sources ?? []).filter((source) => source.market === companyMarket), (source) => source.dataMonth));
  }
  const rows: ResearchRow[] = companies.map((company) => {
    const identity = `${company.market}:${company.code}`;
    const cells: ResearchRow["cells"] = {};
    for (const field of fields) {
      const { domain, id } = field;
      if (domain === "financial") continue;
      const sourceRefs = sourceRefsByMarket.get(`${domain}:${company.market}`) ?? [];
      const period = domain === "company" ? master.sources.find((source) => source.market === company.market)?.reportDate ?? null : domain === "revenue" ? revenues?.dataMonth ?? null : resolvedDate;
      const freshness: ResearchCell["freshness"] = domain === "company" ? recentMaster(master, company.market, taipeiToday(evaluatedAt)) : !sourceRefs.length ? "unverified" : (domain === "revenue" ? revenueMonth : marketDate) === "latest" ? "fresh" : "not_applicable";
      const meta = { sourceRefs, period, freshness };
      if (failures.some((failure) => failure.domain === domain)) { cells[id] = makeCell(field, null, { ...meta, status: "source_unavailable", reason: failures.find((failure) => failure.domain === domain)!.message }); continue; }
      if (domain === "company") {
        const values: Record<string, CellValue> = { "company.code": company.code, "company.name": company.shortName, "company.market": company.market, "company.industry_code": company.industryCode, "company.is_financial": company.isFinancial, "company.is_ky": company.isKy };
        cells[id] = makeCell(field, values[id] ?? null, meta);
      } else if (domain === "price") {
        const row = priceRows.get(identity);
        const key = ({ "price.open": "open", "price.high": "high", "price.low": "low", "price.close": "close", "price.volume_shares": "volumeShares", "price.turnover_twd": "turnoverTwd" } as const)[id as "price.close"];
        const value = row?.[key] ?? null;
        const normalizationKey = id === "price.volume_shares" ? "volumeShares" : id === "price.turnover_twd" ? "turnoverTwd" : null;
        const normalization = normalizationKey ? prices?.sources.find((source) => source.market === company.market)?.normalization[normalizationKey] : null;
        cells[id] = makeCell(field, value, { ...meta, ...(normalization && typeof value === "number" ? { normalization: { sourceUnit: normalization.sourceUnit, sourceValue: value / normalization.multiplier, factor: normalization.multiplier } } : {}) });
      } else if (domain === "valuation") {
        const row = valuationRows.get(identity);
        const key = ({ "valuation.pe": "peRatio", "valuation.pb": "priceToBookRatio", "valuation.dividend_yield_pct": "dividendYieldPercent" } as const)[id as "valuation.pe"];
        cells[id] = makeCell(field, row?.[key] ?? null, { ...meta, status: reportedStatus(row?.valueStatus[key]) });
      } else {
        const row = revenueRows.get(identity);
        const key = ({ "revenue.month_amount_twd": "currentMonthRevenueTwd", "revenue.mom_pct": "momPercent", "revenue.yoy_pct": "yoyPercent", "revenue.cumulative_amount_twd": "currentYearCumulativeRevenueTwd", "revenue.cumulative_yoy_pct": "cumulativeYoyPercent" } as const)[id as "revenue.yoy_pct"];
        const value = row?.[key] ?? null;
        const amount = id.endsWith("amount_twd");
        const normalization = revenues?.sources.find((source) => source.market === company.market);
        cells[id] = makeCell(field, value, { ...meta, status: reportedStatus(row?.valueStatus[key]),
          ...(company.isFinancial ? { definitionId: `${field.definitionId}.financial_reported.${company.code}`, reason: "金融業月營收申報定義須逐公司核對；不與非金融營收或其他未核對金融公司合併統計。" } : {}),
          ...(amount && normalization && typeof value === "number" ? { normalization: { sourceUnit: normalization.sourceAmountUnit, sourceValue: value / normalization.amountMultiplier, factor: normalization.amountMultiplier } } : {}),
        });
      }
    }
    return { code: company.code, name: company.shortName, market: company.market, cells };
  });
  warnings.push(...(prices?.warnings ?? []), ...(valuations?.warnings ?? []), ...(revenues?.warnings ?? []));
  const domainCoverage = {
    price: prices ? { coverageComplete: prices.coverageComplete, universeCoverageVerified: prices.universeCoverageVerified, selectionComplete: prices.selectionComplete, reconciliation: prices.reconciliation } : null,
    valuation: valuations ? { coverageComplete: valuations.coverageComplete, universeCoverageVerified: valuations.universeCoverageVerified, selectionComplete: valuations.selectionComplete, reconciliation: valuations.reconciliation } : null,
    revenue: revenues ? { sourceCoverage: revenues.sourceCoverage, filingCoverage: revenues.filingCoverage, selectionComplete: revenues.selectionComplete, reconciliation: revenues.reconciliation } : null,
  };
  return {
    rows, sources, failures, warnings, resolverEvidence, domainCoverage, masterFreshness,
    resolvedDates: { marketDate: needDaily ? resolvedDate : null, revenueMonth: revenues?.dataMonth ?? null },
    contentFingerprint: fingerprint(sourceContent({ master: { companies: master.companies, sources: master.sources }, price: prices, valuation: valuations, revenue: revenues, failures })),
    workBudget: {
      resolverCalls: needDaily ? 1 : 0, resolver: resolverEvidence?.workBudget ?? null,
      domainCalls: jobs.map((job) => job.domain), perCompanyMarketCalls: 0,
      dependencyCosts: {
        price: prices ? { sourceLoads: prices.sources.length, masterLookupPolicy: "dependency_managed" } : null,
        valuation: valuations ? { sourceLoads: valuations.sources.length, masterLookupPolicy: "dependency_managed" } : null,
        revenue: revenues ? { sourceLoads: revenues.sources.length, discoveryAndArchiveLoads: "dependency_managed_not_fully_observable", masterLookupPolicy: "dependency_managed" } : null,
      },
      unitDefinition: "domain calls are logical calls; sources describe returned evidence, not all discovery, cache, retry or failed HTTP attempts",
    },
  };
}
