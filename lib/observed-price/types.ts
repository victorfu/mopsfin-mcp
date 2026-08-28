import type {
  CompanyMarket,
  CompanyMasterSource,
} from "@/lib/company-master/types";
import type { PriceSource } from "@/lib/price/types";
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
 * The generic price client supports daily and monthly source variants with
 * optional identity fields. A successful observed-price baseline is narrower:
 * it must be a verified, exact-date daily snapshot with cache provenance.
 */
export interface ObservedPriceOfficialCloseSource
  extends Omit<
    PriceSource,
    "cache" | "snapshotIdentity" | "dataDate" | "dataMonth"
  > {
  sourceId: string;
  stage: "latest_official_completed_close";
  cache: CacheProvenance;
  snapshotIdentity: "verified";
  dataDate: string;
  dataMonth?: never;
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
      dependency: "official_daily_market_price";
      logicalInvocations: 1;
      plannedOfficialSourceLoads: 1;
      sourceEvidence: "exposed";
      sourceIds: [string];
    }
  | {
      dependency: "official_daily_market_internal_compatible_master";
      logicalInvocations: 1;
      plannedOfficialSourceLoads: 1;
      sourceEvidence: "not_exposed_by_dependency";
      sourceIds: [];
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
    officialDailyMarketPrice: 1;
    officialDailyMarketInternalCompatibleMaster: 1;
    maximumIncludingNestedDependencies: 3;
  };
  plannedOfficialSourceRequests: {
    orchestrationCompanyMasterMarkets: 2;
    officialDailyMarketSnapshot: 1;
    officialDailyMarketInternalCompatibleMasterMarkets: 1;
    maximumTotal: 4;
    unitDefinition:
      "one_logical_official_source_load_before_cache_and_bounded_retry";
  };
  universePolicy: "compatible";
  selectedCompanyIdentityPolicy:
    "outer_market_all_master_plus_official_row_exact";
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
      { dependency: "official_daily_market_price" }
    >,
    Extract<
      ObservedPriceDependencyLedgerEntry,
      { dependency: "official_daily_market_internal_compatible_master" }
    >,
  ];
  provenance: ObservedPriceProvenance;
  workBudget: ObservedPriceWorkBudget;
  warnings: string[];
}
