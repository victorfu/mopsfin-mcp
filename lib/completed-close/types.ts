import type { CompanyMarket } from "@/lib/company-master/types";
import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import type {
  CurrentCompanyPriceIdentity,
  ExactCurrentCompanyOhlcResult,
  ExactCurrentCompanyOhlcSource,
  OhlcBar,
} from "@/lib/price/types";

export type CompletedCloseCompanyIdentity = CurrentCompanyPriceIdentity;

export interface AuthoritativeCompletedCloseQuery {
  company: CompletedCloseCompanyIdentity;
  evaluatedAt?: Date | string;
}

export interface AuthoritativeCompletedCloseSource
  extends ExactCurrentCompanyOhlcSource {
  companyCode: string;
  exchange: "TWSE" | "TPEx";
  observedName: string;
  selectedBarDate: string;
}

export type AuthoritativeCompletedCloseBar = Omit<
  OhlcBar,
  "close" | "status"
> & {
  close: number;
  status: "traded";
};

export interface AuthoritativeCompletedCloseResult {
  query: {
    companyCode: string;
    market: CompanyMarket;
    evaluatedAt: string;
  };
  company: CompletedCloseCompanyIdentity;
  expectedAsOf: string;
  selectedBarDate: string;
  close: number;
  currency: "TWD";
  timezone: "Asia/Taipei";
  interval: "1d";
  priceBasis: "raw_unadjusted";
  bar: AuthoritativeCompletedCloseBar;
  source: AuthoritativeCompletedCloseSource;
  resolverEvidence: CompletedSessionResolverEvidence;
  cacheRefresh: ExactCurrentCompanyOhlcResult["cacheRefresh"];
  workBudget: {
    scope: "authoritative_completed_close_routing";
    completedSessionResolver: CompletedSessionResolverEvidence["workBudget"];
    exactStockOhlcAttempts: {
      actual: 1 | 2;
      maximum: 2;
      cacheRefreshPerformed: boolean;
    };
  };
}
