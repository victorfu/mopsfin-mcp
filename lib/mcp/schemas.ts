/**
 * Compatibility barrel for the public MCP Zod schemas.
 *
 * Domain implementations live under ./schema so tool registration and tests may
 * continue importing this stable module without runtime-contract changes.
 */
export {
  companyCodesSchema,
  freshnessEvaluationSchema,
  pageShape,
  periodSchema,
  rangeShape,
  requestedPeriodSchema,
  resultMetaSchema,
  sourceCacheObservationSchema,
} from "./schema/common";

export {
  findCompaniesInputSchema,
  findCompaniesOutputSchema,
  listCompaniesInputSchema,
  listCompaniesOutputSchema,
} from "./schema/company";

export {
  dailyMarketOhlcInputSchema,
  dailyMarketOhlcOutputSchema,
  stockOhlcInputSchema,
  stockOhlcOutputSchema,
  stockReactionSignalsInputSchema,
  stockReactionSignalsOutputSchema,
} from "./schema/price";

export {
  dailyMarketValuationInputSchema,
  dailyMarketValuationOutputSchema,
} from "./schema/valuation";

export {
  valuationModelInputsDataSchema,
  valuationModelInputsInputSchema,
  valuationModelInputsOutputSchema,
} from "./schema/valuation-model";

export {
  reverseDcfDataSchema,
  reverseDcfInputSchema,
  reverseDcfOutputSchema,
} from "./schema/reverse-dcf";

export {
  analyzeObservedPriceDataSchema,
  analyzeObservedPriceInputSchema,
  analyzeObservedPriceOutputSchema,
} from "./schema/observed-price";

export {
  stockPriceSeriesInputSchema,
  stockPriceSeriesOutputSchema,
} from "./schema/price-series";

export {
  monthlyRevenueInputSchema,
  monthlyRevenueOutputSchema,
  monthlyRevenueTrendInputSchema,
  monthlyRevenueTrendOutputSchema,
} from "./schema/revenue";

export {
  companyCatalystEventsInputSchema,
  companyCatalystEventsOutputSchema,
  companyCatalystSnapshotsInputSchema,
  companyCatalystSnapshotsOutputSchema,
} from "./schema/catalysts";

export {
  companyMetricInputSchema,
  companyMetricOutputSchema,
  companyMetricsBatchInputSchema,
  companyMetricsBatchOutputSchema,
  financialInstitutionInputSchema,
  financialInstitutionOutputSchema,
  financialNoteInputSchema,
  financialNoteOutputSchema,
  financialStatementInputSchema,
  financialStatementOutputSchema,
  industryDataInputSchema,
  industryDataOutputSchema,
  listCatalogInputSchema,
  listCatalogOutputSchema,
} from "./schema/financials";

export {
  screenTaiwanStockCandidatesInputSchema,
  screenTaiwanStockCandidatesOutputSchema,
} from "./schema/screening";

export {
  screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema,
  screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema,
} from "./schema/research";
