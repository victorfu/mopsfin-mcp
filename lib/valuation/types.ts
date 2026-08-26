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
  | "invalid_upstream";

export interface DailyMarketValuationQuery {
  market: CompanyMarketSelection;
  date: "latest";
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
  valueStatus: {
    peRatio: ValuationValueStatus;
    priceToBookRatio: ValuationValueStatus;
    dividendYieldPercent: ValuationValueStatus;
  };
}

export interface ValuationSource extends OfficialMarketSource {
  dataDate: string;
}

export interface DailyMarketValuationResult {
  query: DailyMarketValuationQuery;
  dataDate: string;
  currency: "TWD";
  classificationPolicy: CurrentMasterClassificationPolicy;
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
