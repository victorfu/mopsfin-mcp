import { describe, expect, it } from "vitest";

import * as publicSchemas from "@/lib/mcp/schemas";
import * as catalysts from "@/lib/mcp/schema/catalysts";
import * as common from "@/lib/mcp/schema/common";
import * as company from "@/lib/mcp/schema/company";
import * as financials from "@/lib/mcp/schema/financials";
import * as financialScreening from "@/lib/mcp/schema/financial-screening";
import * as marketScreening from "@/lib/mcp/schema/market-screening";
import * as observedPrice from "@/lib/mcp/schema/observed-price";
import * as price from "@/lib/mcp/schema/price";
import * as priceSeries from "@/lib/mcp/schema/price-series";
import * as revenue from "@/lib/mcp/schema/revenue";
import * as research from "@/lib/mcp/schema/research";
import * as reverseDcf from "@/lib/mcp/schema/reverse-dcf";
import * as screening from "@/lib/mcp/schema/screening";
import * as valuation from "@/lib/mcp/schema/valuation";
import * as valuationModel from "@/lib/mcp/schema/valuation-model";

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
  stockPriceSeriesInputSchema: priceSeries.stockPriceSeriesInputSchema,
  dailyMarketOhlcInputSchema: price.dailyMarketOhlcInputSchema,
  dailyMarketValuationInputSchema: valuation.dailyMarketValuationInputSchema,
  valuationModelInputsInputSchema:
    valuationModel.valuationModelInputsInputSchema,
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
  stockPriceSeriesOutputSchema: priceSeries.stockPriceSeriesOutputSchema,
  dailyMarketOhlcOutputSchema: price.dailyMarketOhlcOutputSchema,
  dailyMarketValuationOutputSchema: valuation.dailyMarketValuationOutputSchema,
  valuationModelInputsDataSchema:
    valuationModel.valuationModelInputsDataSchema,
  valuationModelInputsOutputSchema:
    valuationModel.valuationModelInputsOutputSchema,
  reverseDcfInputSchema: reverseDcf.reverseDcfInputSchema,
  reverseDcfDataSchema: reverseDcf.reverseDcfDataSchema,
  reverseDcfOutputSchema: reverseDcf.reverseDcfOutputSchema,
  analyzeObservedPriceInputSchema:
    observedPrice.analyzeObservedPriceInputSchema,
  analyzeObservedPriceDataSchema:
    observedPrice.analyzeObservedPriceDataSchema,
  analyzeObservedPriceOutputSchema:
    observedPrice.analyzeObservedPriceOutputSchema,
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
  screenTaiwanFinancialCandidatesInputSchema:
    financialScreening.screenTaiwanFinancialCandidatesInputSchema,
  screenTaiwanFinancialCandidatesDataSchema:
    financialScreening.screenTaiwanFinancialCandidatesDataSchema,
  screenTaiwanFinancialCandidatesOutputSchema:
    financialScreening.screenTaiwanFinancialCandidatesOutputSchema,
  screenTaiwanMarketCandidatesInputSchema:
    marketScreening.screenTaiwanMarketCandidatesInputSchema,
  screenTaiwanMarketCandidatesDataSchema:
    marketScreening.screenTaiwanMarketCandidatesDataSchema,
  screenTaiwanMarketCandidatesOutputSchema:
    marketScreening.screenTaiwanMarketCandidatesOutputSchema,
  screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema:
    research.screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema,
  screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema:
    research.screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema,
} as const;

describe("MCP schema modules", () => {
  it("derives a strict screening data schema without the MCP envelope", () => {
    expect(
      Object.hasOwn(screening.screenTaiwanStockCandidatesDataSchema.shape, "ok"),
    ).toBe(false);
    expect(
      Object.hasOwn(
        screening.screenTaiwanStockCandidatesDataSchema.shape,
        "meta",
      ),
    ).toBe(false);
    expect(
      screening.screenTaiwanStockCandidatesDataSchema.safeParse({}).success,
    ).toBe(false);
  });

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
