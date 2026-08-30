import type { CompanyMarket, CompanyMarketSelection } from "@/lib/company-master/types";
import type { TaiwanFinancialScreenResult } from "@/lib/financial-screening/types";
import type { ResultPageMeta } from "@/lib/mcp/result-contract";
import type { ScreenCandidateBucket, TaiwanStockScreenResult } from "@/lib/screening/types";

export const TAIWAN_MARKET_FULL_UNIVERSE_PRESET =
  "full_universe_cursor_v1" as const;
export const TAIWAN_MARKET_FULL_UNIVERSE_EXECUTION =
  "taiwan_market_full_universe.v1" as const;

export interface TaiwanMarketUniversePageQuery {
  market: CompanyMarketSelection;
  includeKy: boolean;
  pageSize: number;
  cursor?: string;
  preset: typeof TAIWAN_MARKET_FULL_UNIVERSE_PRESET;
}

export interface UniverseManifestCompany {
  companyCode: string;
  companyName: string;
  shortName: string;
  market: CompanyMarket;
  industryCode: string;
  listingDate: string;
  isFinancial: boolean;
  isKy: boolean;
  policyRoute: "screen" | "excluded_ky";
}

export interface UniverseTerminalResult {
  manifestIndex: number;
  companyCode: string;
  companyName: string;
  market: CompanyMarket;
  segment: "non_financial" | "financial";
  route: "candidate" | "not_reaction_scored" | "excluded";
  bucket: ScreenCandidateBucket | null;
  reasonCodes: string[];
  detailCollection:
    | "candidates"
    | "notReactionScored"
    | "excluded";
  detailIndex: number;
  rankScope: "page_segment_only";
}

export interface TaiwanMarketUniversePageResult {
  query: Omit<TaiwanMarketUniversePageQuery, "cursor"> & {
    cursorProvided: boolean;
  };
  generatedAt: string;
  timezone: "Asia/Taipei";
  executionDefinition: {
    id: typeof TAIWAN_MARKET_FULL_UNIVERSE_EXECUTION;
    preset: typeof TAIWAN_MARKET_FULL_UNIVERSE_PRESET;
    posture: "research_triage_not_recommendation";
    mode: "full_universe_cursor";
    pageCompanyLimit: 5;
    underlyingModels: [
      "taiwan_stock_screen.v2",
      "taiwan_financial_screen.v1",
    ];
    snapshotScope: "manifest_company_identity_only";
    pageValuesPinned: false;
    pointInTime: false;
    globalRankAvailable: false;
    sharedDependencyFailurePolicy: "fail_page_without_advancing_cursor";
  };
  manifest: {
    snapshotId: string;
    companyCount: number;
    listedCount: number;
    otcCount: number;
    financialCount: number;
    nonFinancialCount: number;
    excludedKyCount: number;
    masterReportDates: string[];
    coverageVerification: {
      status: "heuristic";
      officialDeclaredRowCountAvailable: false;
    };
  };
  page: {
    startIndex: number;
    endIndexExclusive: number;
    companyCodes: string[];
    hasMore: boolean;
    nextCursor: string | null;
    meta: ResultPageMeta;
  };
  coverage: {
    pageSelectionComplete: true;
    pageTerminalReconciliationComplete: true;
    pageSourceComplete: boolean;
    manifestIdentityPinned: true;
    pageValuesPinned: false;
    pointInTime: false;
    globalRankAvailable: false;
    pageEndReached: boolean;
  };
  segments: {
    nonFinancial: TaiwanStockScreenResult | null;
    financial: TaiwanFinancialScreenResult | null;
  };
  terminalResults: UniverseTerminalResult[];
  warnings: string[];
}
