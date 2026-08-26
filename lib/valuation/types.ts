import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";
import type {
  CurrentMasterClassificationPolicy,
  MarketReconciliation,
  OfficialMarketSource,
  UniversePolicy,
} from "@/lib/market-data/types";

export type ValuationValueStatus =
  | "reported"
  | "missing_or_not_meaningful"
  | "not_provided_by_source"
  | "invalid_upstream";

export type LegacyValuationValueStatus = Exclude<
  ValuationValueStatus,
  "not_provided_by_source"
>;

export type ValuationClassificationPolicy =
  | CurrentMasterClassificationPolicy
  | "historical_code_rule";

export interface DailyMarketValuationQuery {
  market: CompanyMarketSelection;
  date: "latest" | string;
  companyCodes?: string[];
  universePolicy: UniversePolicy;
}

export interface ValuationRow {
  code: string;
  name: string;
  market: CompanyMarket;
  peRatio: number | null;
  priceToBookRatio: number | null;
  dividendYieldPercent: number | null;
  closePriceTwd: number | null;
  dividendPerShareTwd: number | null;
  dividendFiscalYear: number | null;
  referenceFiscalPeriod: string | null;
  valueStatus: {
    peRatio: LegacyValuationValueStatus;
    priceToBookRatio: LegacyValuationValueStatus;
    dividendYieldPercent: LegacyValuationValueStatus;
    closePriceTwd: ValuationValueStatus;
    dividendPerShareTwd: ValuationValueStatus;
    dividendFiscalYear: ValuationValueStatus;
    referenceFiscalPeriod: ValuationValueStatus;
  };
  rawValue: {
    peRatio: string | null;
    priceToBookRatio: string | null;
    dividendYieldPercent: string | null;
    closePriceTwd: string | null;
    dividendPerShareTwd: string | null;
    dividendFiscalYear: string | null;
    referenceFiscalPeriod: string | null;
  };
}

export interface ValuationSource extends OfficialMarketSource {
  dataDate: string;
}

export interface DailyMarketValuationResult {
  query: DailyMarketValuationQuery;
  dataDate: string;
  currency: "TWD";
  classificationPolicy: ValuationClassificationPolicy;
  coverageComplete: boolean;
  universeCoverageVerified: boolean;
  selectionComplete: boolean;
  missingCompanyCodes: string[];
  reconciliation: MarketReconciliation[];
  counts: {
    raw: number;
    returned: number;
    withPe: number;
    withPb: number;
    withDividendYield: number;
    withClosePrice: number;
    withDividendPerShare: number;
    withDividendFiscalYear: number;
    withReferenceFiscalPeriod: number;
  };
  rows: ValuationRow[];
  sources: ValuationSource[];
  warnings: string[];
}

export type {
  CurrentMasterClassificationPolicy,
  MarketReconciliation,
  UniversePolicy,
};
