import { fingerprint, paginateByCompany } from "@/lib/mcp/cursor";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { getCurrentDeadline } from "@/lib/upstream/reliability";
import { planResearchFields, RESEARCH_FIELDS_VERSION, researchFields } from "@/lib/research/fields";
import { loadResearchMarketData, researchMarketDependencies, type ResearchMarketDependencies } from "@/lib/research/market-data";
import { projectResearchRows } from "@/lib/research/projection";
import { cellUsable } from "@/lib/research/statistics";
import { screenRows } from "./engine";

import type { ScreenCompaniesQuery } from "./types";
export type { ScreenCompaniesQuery } from "./types";

export class ScreenerClient {
  constructor(
    private readonly dependencies: ResearchMarketDependencies = researchMarketDependencies,
    private readonly catalog: Pick<typeof mopsfinClient, "getCatalog"> = mopsfinClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async screenCompanies(input: ScreenCompaniesQuery) {
    getCurrentDeadline()?.throwIfExpired();
    if (!input.filters.length) throw new MopsfinError("INVALID_ARGUMENT", "篩選至少需要一個明確條件；列出公司母體請使用 list_companies。");
    if (input.asOf !== "latest") throw new MopsfinError("INVALID_ARGUMENT", "篩選第一版僅支援 as_of=latest。");
    if (!["all", "listed", "otc"].includes(input.market) || !["full", "compact", "summary"].includes(input.outputMode)) throw new MopsfinError("INVALID_ARGUMENT", "不支援的市場或輸出模式。");
    if (input.revenueMonth !== "latest" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.revenueMonth)) throw new MopsfinError("INVALID_ARGUMENT", "revenue_month 必須是 latest 或 YYYY-MM。");
    if (input.companyCodes && (!input.companyCodes.length || input.companyCodes.length > 500 || input.companyCodes.some((code) => !/^\d{4}$/.test(code)))) throw new MopsfinError("INVALID_ARGUMENT", "company_codes 必須包含 1–500 個四位代碼。");
    if (input.industryCodes && (!input.industryCodes.length || input.industryCodes.length > 100)) throw new MopsfinError("INVALID_ARGUMENT", "industry_codes 必須包含 1–100 個產業代碼。");
    if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100)) throw new MopsfinError("INVALID_ARGUMENT", "page_size 必須介於 1 與 100。");
    const query = {
      ...input, columns: [...new Set(input.columns)],
      ...(input.companyCodes ? { companyCodes: [...new Set(input.companyCodes)].sort() } : {}),
      ...(input.industryCodes ? { industryCodes: [...new Set(input.industryCodes)].sort() } : {}),
    };
    const plan = planResearchFields({ registry: researchFields(), tool: "screen_companies", columns: query.columns, filters: query.filters, sort: query.sort });
    const evaluatedAt = this.now();
    // Catalog validation precedes bulk acquisition. Only queries using industries need it.
    if (query.industryCodes) {
      const catalog = await this.catalog.getCatalog();
      const valid = new Set(catalog.industries.map((industry) => industry.code));
      const invalid = query.industryCodes.filter((code) => !valid.has(code));
      if (invalid.length) throw new MopsfinError("INVALID_ARGUMENT", `未知產業代碼：${invalid.join(", ")}`);
    }
    const master = await this.dependencies.master.listCompanies({ market: query.market, includeFinancial: true, includeKy: true });
    getCurrentDeadline()?.throwIfExpired();
    const known = new Set(master.companies.map((company) => company.code));
    const unknownCodes = query.companyCodes?.filter((code) => !known.has(code)) ?? [];
    if (unknownCodes.length) throw new MopsfinError("NOT_FOUND", "指定公司不在目前所選市場母體。", { details: { companyCodes: unknownCodes } });
    const companies = master.companies.filter((company) =>
      (query.includeFinancial || !company.isFinancial) && (query.includeKy || !company.isKy) &&
      (!query.companyCodes || query.companyCodes.includes(company.code)) &&
      (!query.industryCodes || query.industryCodes.includes(company.industryCode)),
    );
    const data = await loadResearchMarketData({ master, companies, fields: plan.fields, market: query.market, marketDate: "latest", revenueMonth: query.revenueMonth, evaluatedAt }, this.dependencies);
    const evaluated = screenRows(data.rows, query.filters, query.sort);
    const { cursor: _cursor, pageSize: _pageSize, ...cursorQuery } = query;
    void _cursor; void _pageSize;
    const snapshotId = fingerprint({ version: RESEARCH_FIELDS_VERSION, content: data.contentFingerprint, selected: companies.map((company) => [company.market, company.code]) });
    const page = paginateByCompany({ tool: "screen_companies", query: cursorQuery, snapshotId, items: evaluated.matches, maximumPageSize: 100, pageSize: query.pageSize ?? (query.cursor ? undefined : 50), cursor: query.cursor });
    const fieldCoverage = plan.fields.map((field) => ({
      field: field.id,
      usable: data.rows.filter((row) => cellUsable(row.cells[field.id])).length,
      unavailable: data.rows.filter((row) => !cellUsable(row.cells[field.id])).length,
      statuses: Object.fromEntries([...new Set(data.rows.map((row) => row.cells[field.id]?.status ?? "missing"))].map((status) => [status, data.rows.filter((row) => (row.cells[field.id]?.status ?? "missing") === status).length])),
    }));
    const complete = data.failures.length === 0 && evaluated.counts.undetermined === 0 && data.masterFreshness.every((item) => item.freshness === "fresh");
    return {
      query, evaluatedAt: evaluatedAt.toISOString(), registryVersion: RESEARCH_FIELDS_VERSION,
      snapshotId, resolvedDates: data.resolvedDates,
      universe: { market: query.market, verification: master.coverageVerification, freshness: data.masterFreshness, masterCount: master.companies.length, selectedCount: companies.length, excludedCount: master.companies.length - companies.length, currentMasterOnly: true, historicalPointInTime: false },
      counts: evaluated.counts, resultComplete: complete, rankIncomplete: evaluated.rankIncomplete,
      fieldCoverage, sources: data.sources, failures: data.failures, sourceCoverage: data.domainCoverage,
      resolverEvidence: data.resolverEvidence,
      presentation: projectResearchRows(query.outputMode === "summary" ? evaluated.matches : page.items, query.columns, query.outputMode, query.outputMode === "summary" ? "entire_selection" : "current_page"),
      filterEvidence: page.items.map((row) => ({ code: row.code, market: row.market, evidence: row.evidence })),
      unresolved: {
        total: evaluated.unresolved.length, returned: Math.min(100, evaluated.unresolved.length),
        omitted: Math.max(0, evaluated.unresolved.length - 100),
        companies: evaluated.unresolved.slice(0, 100).map((row) => ({ code: row.code, market: row.market, evidence: row.evidence })),
      },
      page: page.page,
      workBudget: { orchestrationMasterCalls: 1, catalogCalls: query.industryCodes ? 1 : 0, ...data.workBudget },
      warnings: [...master.warnings, ...data.warnings, "母體完整性為 heuristic；價格、月營收與當前公司分類不構成歷史 point-in-time 資料。"],
    };
  }
}

export const screenerClient = new ScreenerClient();
