import { companyMasterClient, type CompanyMasterClient } from "@/lib/company-master/client";
import type { MasterCompany } from "@/lib/company-master/types";
import { taiwanFinancialScreenClient, type TaiwanFinancialScreenClient } from "@/lib/financial-screening/client";
import { fingerprint, paginateByCompany } from "@/lib/mcp/cursor";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { taiwanStockScreenClient, type TaiwanStockScreenClient } from "@/lib/screening/client";

import {
  TAIWAN_MARKET_FULL_UNIVERSE_EXECUTION,
  TAIWAN_MARKET_FULL_UNIVERSE_PRESET,
  type TaiwanMarketUniversePageQuery,
  type TaiwanMarketUniversePageResult,
  type UniverseManifestCompany,
  type UniverseTerminalResult,
} from "./types";

type CompanyMasterLike = Pick<CompanyMasterClient, "listCompanies">;
type NonFinancialScreenLike = Pick<TaiwanStockScreenClient, "screenTaiwanStockCandidates">;
type FinancialScreenLike = Pick<TaiwanFinancialScreenClient, "screenTaiwanFinancialCandidates">;

export interface FullUniverseClientDependencies {
  companyMaster?: CompanyMasterLike;
  nonFinancialScreen?: NonFinancialScreenLike;
  financialScreen?: FinancialScreenLike;
}

function normalizeQuery(
  query: TaiwanMarketUniversePageQuery,
): TaiwanMarketUniversePageQuery {
  if (!( ["all", "listed", "otc"] as const).includes(query.market)) {
    throw new MopsfinError("INVALID_ARGUMENT", "market 必須是 all、listed 或 otc。");
  }
  if (query.preset !== TAIWAN_MARKET_FULL_UNIVERSE_PRESET) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `preset 目前只支援 ${TAIWAN_MARKET_FULL_UNIVERSE_PRESET}。`,
    );
  }
  if (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 5) {
    throw new MopsfinError("INVALID_ARGUMENT", "page_size 必須是 1 至 5 的整數。");
  }
  if (typeof query.includeKy !== "boolean") {
    throw new MopsfinError("INVALID_ARGUMENT", "include_ky 必須是 boolean。");
  }
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 1_000)) {
    throw new MopsfinError("INVALID_ARGUMENT", "cursor 格式或長度無效。", {
      reason: "CURSOR_INVALID",
      category: "pagination",
      action: "restart_pagination",
    });
  }
  return { ...query };
}

function manifestCompany(
  company: MasterCompany,
  includeKy: boolean,
): UniverseManifestCompany {
  return {
    companyCode: company.code,
    companyName: company.name,
    shortName: company.shortName,
    market: company.market,
    industryCode: company.industryCode,
    listingDate: company.listingDate,
    isFinancial: company.isFinancial,
    isKy: company.isKy,
    policyRoute: !includeKy && company.isKy ? "excluded_ky" : "screen",
  };
}

function failSnapshotChanged(message: string): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    reason: "SNAPSHOT_CHANGED",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

function failPage(message: string, details: Record<string, unknown>): never {
  throw new MopsfinError("INCOMPLETE_COVERAGE", message, {
    reason: "FULL_UNIVERSE_PAGE_INCOMPLETE",
    category: "coverage",
    retryable: true,
    action: "retry",
    details,
  });
}

function assertSegmentReady(
  segment: "non_financial" | "financial",
  result: {
    dependencyStatus: Array<{ status: string; stage: string; dependency: string }>;
    notDeepScored: Array<{ companyCode: string }>;
    notReactionScored: Array<{ companyCode: string; reasonCodes: string[] }>;
  },
): void {
  const failed = result.dependencyStatus.filter((dependency) => dependency.status === "failed");
  if (failed.length > 0) {
    failPage(`${segment} segment 有 shared dependency failure；本頁不前進 cursor。`, {
      segment,
      failedDependencies: failed,
    });
  }
  if (result.notDeepScored.length > 0) {
    failPage(`${segment} segment 在 page_size<=5 仍出現 bounded deep omission。`, {
      segment,
      companyCodes: result.notDeepScored.map((company) => company.companyCode),
    });
  }
  const unfinished = result.notReactionScored.filter((company) =>
    company.reasonCodes.some((reason) =>
      reason === "reaction_dependency_not_completed" ||
      reason === "bounded_reaction_limit"
    )
  );
  if (unfinished.length > 0) {
    failPage(`${segment} segment reaction 未完成連續 page scope；本頁不前進 cursor。`, {
      segment,
      companyCodes: unfinished.map((company) => company.companyCode),
    });
  }
}

function terminalResultsForSegment(options: {
  segment: "non_financial" | "financial";
  pageCompanies: UniverseManifestCompany[];
  manifestIndexByCode: Map<string, number>;
  result: {
    candidates: Array<{
      companyCode: string;
      companyName: string;
      market: "listed" | "otc";
      bucket: "research_candidate" | "watchlist" | "insufficient_data" | "deprioritized";
    }>;
    notReactionScored: Array<{
      companyCode: string;
      companyName: string;
      reasonCodes: string[];
    }>;
    excluded: Array<{
      companyCode: string;
      companyName: string;
      reasonCodes: string[];
    }>;
  };
}): UniverseTerminalResult[] {
  const rows: UniverseTerminalResult[] = [];
  options.result.candidates.forEach((candidate, detailIndex) => {
    rows.push({
      manifestIndex: options.manifestIndexByCode.get(candidate.companyCode) as number,
      companyCode: candidate.companyCode,
      companyName: candidate.companyName,
      market: candidate.market,
      segment: options.segment,
      route: "candidate",
      bucket: candidate.bucket,
      reasonCodes: [],
      detailCollection: "candidates",
      detailIndex,
      rankScope: "page_segment_only",
    });
  });
  options.result.notReactionScored.forEach((company, detailIndex) => {
    const manifest = options.pageCompanies.find(
      (candidate) => candidate.companyCode === company.companyCode,
    ) as UniverseManifestCompany;
    rows.push({
      manifestIndex: options.manifestIndexByCode.get(company.companyCode) as number,
      companyCode: company.companyCode,
      companyName: company.companyName,
      market: manifest.market,
      segment: options.segment,
      route: "not_reaction_scored",
      bucket: null,
      reasonCodes: company.reasonCodes,
      detailCollection: "notReactionScored",
      detailIndex,
      rankScope: "page_segment_only",
    });
  });
  options.result.excluded.forEach((company, detailIndex) => {
    const manifest = options.pageCompanies.find(
      (candidate) => candidate.companyCode === company.companyCode,
    ) as UniverseManifestCompany;
    rows.push({
      manifestIndex: options.manifestIndexByCode.get(company.companyCode) as number,
      companyCode: company.companyCode,
      companyName: company.companyName,
      market: manifest.market,
      segment: options.segment,
      route: "excluded",
      bucket: null,
      reasonCodes: company.reasonCodes,
      detailCollection: "excluded",
      detailIndex,
      rankScope: "page_segment_only",
    });
  });
  return rows;
}

export class TaiwanMarketFullUniverseClient {
  private readonly companyMaster: CompanyMasterLike;
  private readonly nonFinancialScreen: NonFinancialScreenLike;
  private readonly financialScreen: FinancialScreenLike;

  constructor(
    dependencies: FullUniverseClientDependencies = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.companyMaster = dependencies.companyMaster ?? companyMasterClient;
    this.nonFinancialScreen =
      dependencies.nonFinancialScreen ?? taiwanStockScreenClient;
    this.financialScreen =
      dependencies.financialScreen ?? taiwanFinancialScreenClient;
  }

  async screenTaiwanMarketUniversePage(
    rawQuery: TaiwanMarketUniversePageQuery,
  ): Promise<TaiwanMarketUniversePageResult> {
    const query = normalizeQuery(rawQuery);
    const master = await this.companyMaster.listCompanies({
      market: query.market,
      includeFinancial: true,
      includeKy: true,
    });
    const companies = master.companies
      .map((company) => manifestCompany(company, query.includeKy))
      .sort((left, right) => left.companyCode.localeCompare(right.companyCode));
    const masterReportDates = [
      ...new Set(master.sources.map((source) => source.reportDate)),
    ].sort();
    const manifestSnapshotId = `market-universe-${fingerprint({
      executionId: TAIWAN_MARKET_FULL_UNIVERSE_EXECUTION,
      preset: query.preset,
      market: query.market,
      includeKy: query.includeKy,
      masterReportDates,
      coverageVerification: master.coverageVerification,
      sourceCounts: master.sources.map((source) => ({
        market: source.market,
        rawCount: source.rawCount,
        excludedTdrCount: source.excludedTdrCount,
        companyCount: source.companyCount,
      })),
      companies,
    })}`;
    const pagination = paginateByCompany({
      tool: "screen_taiwan_market_universe_page",
      query: {
        executionId: TAIWAN_MARKET_FULL_UNIVERSE_EXECUTION,
        market: query.market,
        includeKy: query.includeKy,
        preset: query.preset,
      },
      snapshotId: manifestSnapshotId,
      items: companies,
      pageSize: query.pageSize,
      cursor: query.cursor,
      maximumPageSize: 5,
    });
    const pageCompanies = pagination.items;
    const manifestIndexByCode = new Map(
      companies.map((company, index) => [company.companyCode, index]),
    );
    const startIndex = pageCompanies.length > 0
      ? manifestIndexByCode.get(pageCompanies[0].companyCode) as number
      : companies.length;
    const nonFinancialCodes = pageCompanies
      .filter((company) => !company.isFinancial)
      .map((company) => company.companyCode);
    const financialCodes = pageCompanies
      .filter((company) => company.isFinancial)
      .map((company) => company.companyCode);
    const [nonFinancial, financial] = await Promise.all([
      nonFinancialCodes.length > 0
        ? this.nonFinancialScreen.screenTaiwanStockCandidates({
            market: query.market,
            companyCodes: nonFinancialCodes,
            includeKy: query.includeKy,
            candidateLimit: nonFinancialCodes.length,
            preset: "balanced_non_financial_v2",
          })
        : null,
      financialCodes.length > 0
        ? this.financialScreen.screenTaiwanFinancialCandidates({
            market: query.market,
            companyCodes: financialCodes,
            includeKy: query.includeKy,
            candidateLimit: financialCodes.length,
            preset: "balanced_financial_v1",
          })
        : null,
    ]);
    if (nonFinancial) assertSegmentReady("non_financial", nonFinancial);
    if (financial) assertSegmentReady("financial", financial);
    for (const result of [nonFinancial, financial]) {
      if (
        result &&
        JSON.stringify(result.asOf.masterReportDates) !==
          JSON.stringify(masterReportDates)
      ) {
        failSnapshotChanged(
          "page segment 使用的 company master report dates 與 manifest 不一致，請從第一頁重啟。",
        );
      }
    }
    const terminalResults = [
      ...(nonFinancial
        ? terminalResultsForSegment({
            segment: "non_financial",
            pageCompanies,
            manifestIndexByCode,
            result: nonFinancial,
          })
        : []),
      ...(financial
        ? terminalResultsForSegment({
            segment: "financial",
            pageCompanies,
            manifestIndexByCode,
            result: financial,
          })
        : []),
    ].sort((left, right) => left.manifestIndex - right.manifestIndex);
    const pageCodes = pageCompanies.map((company) => company.companyCode);
    const terminalCodes = terminalResults.map((result) => result.companyCode);
    const terminalCodeSet = new Set(terminalCodes);
    if (
      terminalCodes.length !== pageCodes.length ||
      terminalCodeSet.size !== terminalCodes.length ||
      pageCodes.some((code) => !terminalCodeSet.has(code))
    ) {
      failPage("page terminal reconciliation 無法讓每家公司恰好落入一個結果。", {
        pageCodes,
        terminalCodes,
      });
    }
    const nextCursor = pagination.page.next?.kind === "cursor"
      ? pagination.page.next.cursor
      : null;
    const pageSourceComplete =
      (nonFinancial?.coverage.sourceComplete ?? true) &&
      (financial?.coverage.sourceComplete ?? true);

    return {
      query: {
        market: query.market,
        includeKy: query.includeKy,
        pageSize: query.pageSize,
        cursorProvided: query.cursor !== undefined,
        preset: query.preset,
      },
      generatedAt: this.now().toISOString(),
      timezone: "Asia/Taipei",
      executionDefinition: {
        id: TAIWAN_MARKET_FULL_UNIVERSE_EXECUTION,
        preset: TAIWAN_MARKET_FULL_UNIVERSE_PRESET,
        posture: "research_triage_not_recommendation",
        mode: "full_universe_cursor",
        pageCompanyLimit: 5,
        underlyingModels: [
          "taiwan_stock_screen.v2",
          "taiwan_financial_screen.v1",
        ],
        snapshotScope: "manifest_company_identity_only",
        pageValuesPinned: false,
        pointInTime: false,
        globalRankAvailable: false,
        sharedDependencyFailurePolicy: "fail_page_without_advancing_cursor",
      },
      manifest: {
        snapshotId: manifestSnapshotId,
        companyCount: companies.length,
        listedCount: companies.filter((company) => company.market === "listed").length,
        otcCount: companies.filter((company) => company.market === "otc").length,
        financialCount: companies.filter((company) => company.isFinancial).length,
        nonFinancialCount: companies.filter((company) => !company.isFinancial).length,
        excludedKyCount: query.includeKy
          ? 0
          : companies.filter((company) => company.isKy).length,
        masterReportDates,
        coverageVerification: {
          status: "heuristic",
          officialDeclaredRowCountAvailable: false,
        },
      },
      page: {
        startIndex,
        endIndexExclusive: startIndex + pageCompanies.length,
        companyCodes: pageCodes,
        hasMore: nextCursor !== null,
        nextCursor,
        meta: pagination.page,
      },
      coverage: {
        pageSelectionComplete: true,
        pageTerminalReconciliationComplete: true,
        pageSourceComplete,
        manifestIdentityPinned: true,
        pageValuesPinned: false,
        pointInTime: false,
        globalRankAvailable: false,
        pageEndReached: nextCursor === null,
      },
      segments: { nonFinancial, financial },
      terminalResults,
      warnings: [
        "本 execution 沿 current-master manifest cursor 讓每家公司恰好路由一次，不再使用全母體 top-10/top-5 作總量截斷。",
        "snapshotScope=manifest_company_identity_only；尚未讀取頁面的財務、估值、營收與 OHLC 不在 snapshot 內。",
        "pageValuesPinned=false、pointInTime=false；跨頁上游值可能更新或重編，不能宣稱可回放的單一 vintage。",
        "page 內 candidate rank 只屬 page_segment_only；收齊所有頁前沒有 global rank 或全市場 shortlist。",
        "公司母體仍只有 heuristic coverage，官方沒有 declared row count；本工具不是投資建議。",
      ],
    };
  }
}

export const taiwanMarketFullUniverseClient =
  new TaiwanMarketFullUniverseClient();
