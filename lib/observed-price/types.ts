import type {
  CompanyMarket,
  CompanyMasterSource,
} from "@/lib/company-master/types";
import type {
  AuthoritativeCompletedCloseResult,
  AuthoritativeCompletedCloseSource,
} from "@/lib/completed-close/types";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

export interface ObservedPriceQuery {
  companyCode: string;
  observedPriceTwd: number;
  observedAt: string;
  sourceLabel: string;
}

export interface ObservedPriceCompanyMasterSource
  extends Omit<CompanyMasterSource, "cache"> {
  sourceId: string;
  stage: "company_master";
  cache: CacheProvenance;
}

/**
 * The authoritative close dependency uses a verified single-stock monthly
 * snapshot and selects one exact completed-session bar. Keep the monthly
 * source identity separate from the exact selected bar date.
 */
export interface ObservedPriceOfficialCloseSource
  extends Omit<
    AuthoritativeCompletedCloseSource,
    "cache"
  > {
  sourceId: string;
  stage: "latest_official_completed_close";
  cache: CacheProvenance;
}

export type ObservedPriceSource =
  | ObservedPriceCompanyMasterSource
  | ObservedPriceOfficialCloseSource;

export type ObservedPriceDependencyLedgerEntry =
  | {
      dependency: "orchestration_company_master";
      logicalInvocations: 1;
      plannedOfficialSourceLoads: 2;
      sourceEvidence: "exposed";
      sourceIds: [string, string];
    }
  | {
      dependency: "authoritative_completed_session_resolver";
      logicalInvocations: 1;
      plannedOfficialSourceLoads: 2;
      sourceEvidence: "exposed_in_meta_resolver_evidence";
      sourceIds: [];
    }
  | {
      dependency: "official_exact_single_stock_ohlc";
      logicalInvocations: 1;
      plannedOfficialSourceLoads: 1 | 2;
      sourceEvidence: "exposed";
      sourceIds: [string];
    };

export interface ObservedPriceProvenance {
  observedPrice: {
    evidenceClass: "CALLER_SUPPLIED";
    official: false;
    independentlyVerified: false;
    sourceLabel: string;
    observedAt: string;
  };
  currentMasterIdentity: {
    evidenceClass: "OFFICIAL_MASTER_RAW";
    queryMarket: "all";
    coverageMarkets: ["listed", "otc"];
    companyMarket: CompanyMarket;
    sourceIds: [string, string];
  };
  officialBaseline: {
    evidenceClass: "OFFICIAL_MARKET_RAW";
    priceBasis: "raw_unadjusted";
    dataDate: string;
    sourceIds: [string];
  };
  comparison: {
    evidenceClass: "MOPSFIN_CALC";
    absoluteDifferenceFormula:
      "observed_price_twd - latest_official_completed_close_twd";
    percentDifferenceFormula:
      "(observed_price_twd / latest_official_completed_close_twd - 1) * 100";
    inputOrigins: ["CALLER_SUPPLIED", "OFFICIAL_MARKET_RAW"];
  };
}

export interface ObservedPriceWorkBudget {
  requestedCompanies: 1;
  dependencyInvocations: {
    orchestrationCompanyMaster: 1;
    authoritativeCompletedSessionResolver: 1;
    officialExactSingleStockOhlc: 1;
    maximumIncludingNestedDependencies: 3;
  };
  plannedOfficialSourceRequests: {
    orchestrationCompanyMasterMarkets: 2;
    completedSessionResolver: {
      actual: number;
      maximum: 2;
    };
    exactSingleStockOhlc: {
      actual: 1 | 2;
      maximum: 2;
      cacheRefreshPerformed: boolean;
    };
    actualTotal: number;
    maximumTotal: 6;
    unitDefinition:
      "one_logical_official_source_load_before_cache_and_bounded_retry";
  };
  priceRoutingPolicy:
    "authoritative_completed_session_expected_as_of_then_exact_single_stock_ohlc";
  selectedCompanyIdentityPolicy:
    "outer_market_all_master_plus_exact_single_stock_source";
}

export interface ObservedPriceAnalysisResult {
  query: ObservedPriceQuery;
  generatedAt: string;
  priceOrigin: "caller_supplied";
  officialBaselineOrigin: "official_latest_completed_close";
  company: {
    code: string;
    name: string;
    shortName: string;
    market: CompanyMarket;
    exchange: "TWSE" | "TPEx";
  };
  observedPriceTwd: number;
  observedAt: string;
  observedTaipeiDate: string;
  sourceLabel: string;
  latestOfficialCompletedClose: number;
  latestOfficialCloseDate: string;
  changeFromOfficialCloseTwd: number;
  changeFromOfficialClosePercent: number;
  officialHistoryCutoff: string;
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  currency: "TWD";
  timezone: "Asia/Taipei";
  officialPriceBasis: "raw_unadjusted";
  sources: [
    ObservedPriceCompanyMasterSource,
    ObservedPriceCompanyMasterSource,
    ObservedPriceOfficialCloseSource,
  ];
  dependencyLedger: [
    Extract<
      ObservedPriceDependencyLedgerEntry,
      { dependency: "orchestration_company_master" }
    >,
    Extract<
      ObservedPriceDependencyLedgerEntry,
      { dependency: "authoritative_completed_session_resolver" }
    >,
    Extract<
      ObservedPriceDependencyLedgerEntry,
      { dependency: "official_exact_single_stock_ohlc" }
    >,
  ];
  provenance: ObservedPriceProvenance;
  workBudget: ObservedPriceWorkBudget;
  warnings: string[];
}

export interface ObservedPriceAnalysisContext {
  data: ObservedPriceAnalysisResult;
  completedClose: AuthoritativeCompletedCloseResult;
}
