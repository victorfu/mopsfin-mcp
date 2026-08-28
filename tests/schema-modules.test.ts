import { describe, expect, it } from "vitest";

import * as publicSchemas from "@/lib/mcp/schemas";
import * as catalysts from "@/lib/mcp/schema/catalysts";
import * as common from "@/lib/mcp/schema/common";
import * as company from "@/lib/mcp/schema/company";
import * as financials from "@/lib/mcp/schema/financials";
import * as price from "@/lib/mcp/schema/price";
import * as revenue from "@/lib/mcp/schema/revenue";
import * as screening from "@/lib/mcp/schema/screening";
import * as valuation from "@/lib/mcp/schema/valuation";

const publicSchemaOwners = {
  sourceCacheObservationSchema: common.sourceCacheObservationSchema,
  freshnessEvaluationSchema: common.freshnessEvaluationSchema,
  resultMetaSchema: common.resultMetaSchema,
  periodSchema: common.periodSchema,
  requestedPeriodSchema: common.requestedPeriodSchema,
  companyCodesSchema: common.companyCodesSchema,
  rangeShape: common.rangeShape,
  pageShape: common.pageShape,
  findCompaniesInputSchema: company.findCompaniesInputSchema,
  listCompaniesInputSchema: company.listCompaniesInputSchema,
  stockOhlcInputSchema: price.stockOhlcInputSchema,
  dailyMarketOhlcInputSchema: price.dailyMarketOhlcInputSchema,
  dailyMarketValuationInputSchema: valuation.dailyMarketValuationInputSchema,
  monthlyRevenueInputSchema: revenue.monthlyRevenueInputSchema,
  monthlyRevenueTrendInputSchema: revenue.monthlyRevenueTrendInputSchema,
  companyCatalystEventsInputSchema: catalysts.companyCatalystEventsInputSchema,
  companyCatalystSnapshotsInputSchema:
    catalysts.companyCatalystSnapshotsInputSchema,
  stockReactionSignalsInputSchema: price.stockReactionSignalsInputSchema,
  listCatalogInputSchema: financials.listCatalogInputSchema,
  companyMetricInputSchema: financials.companyMetricInputSchema,
  companyMetricsBatchInputSchema: financials.companyMetricsBatchInputSchema,
  financialStatementInputSchema: financials.financialStatementInputSchema,
  financialNoteInputSchema: financials.financialNoteInputSchema,
  industryDataInputSchema: financials.industryDataInputSchema,
  financialInstitutionInputSchema: financials.financialInstitutionInputSchema,
  findCompaniesOutputSchema: company.findCompaniesOutputSchema,
  listCompaniesOutputSchema: company.listCompaniesOutputSchema,
  stockOhlcOutputSchema: price.stockOhlcOutputSchema,
  dailyMarketOhlcOutputSchema: price.dailyMarketOhlcOutputSchema,
  dailyMarketValuationOutputSchema: valuation.dailyMarketValuationOutputSchema,
  monthlyRevenueOutputSchema: revenue.monthlyRevenueOutputSchema,
  monthlyRevenueTrendOutputSchema: revenue.monthlyRevenueTrendOutputSchema,
  companyCatalystEventsOutputSchema:
    catalysts.companyCatalystEventsOutputSchema,
  companyCatalystSnapshotsOutputSchema:
    catalysts.companyCatalystSnapshotsOutputSchema,
  stockReactionSignalsOutputSchema: price.stockReactionSignalsOutputSchema,
  listCatalogOutputSchema: financials.listCatalogOutputSchema,
  companyMetricOutputSchema: financials.companyMetricOutputSchema,
  companyMetricsBatchOutputSchema: financials.companyMetricsBatchOutputSchema,
  financialStatementOutputSchema: financials.financialStatementOutputSchema,
  financialNoteOutputSchema: financials.financialNoteOutputSchema,
  industryDataOutputSchema: financials.industryDataOutputSchema,
  financialInstitutionOutputSchema:
    financials.financialInstitutionOutputSchema,
  screenTaiwanStockCandidatesInputSchema:
    screening.screenTaiwanStockCandidatesInputSchema,
  screenTaiwanStockCandidatesOutputSchema:
    screening.screenTaiwanStockCandidatesOutputSchema,
} as const;

describe("MCP schema modules", () => {
  it("keeps the compatibility barrel public export surface exact", () => {
    expect(Object.keys(publicSchemas).sort()).toEqual(
      Object.keys(publicSchemaOwners).sort(),
    );
  });

  it("re-exports the same runtime schema objects owned by each domain", () => {
    for (const [name, schema] of Object.entries(publicSchemaOwners)) {
      expect(publicSchemas[name as keyof typeof publicSchemas], name).toBe(
        schema,
      );
    }
  });
});
