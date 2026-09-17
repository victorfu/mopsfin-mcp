import { companyMasterClient } from "@/lib/company-master/client";
import { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { stockPriceSeriesClient } from "@/lib/price-series/client";
import { BenchmarkClient } from "@/lib/reaction/benchmark-client";
import type { BenchmarkBar, BenchmarkSource } from "@/lib/reaction/types";
import { getCurrentDeadline } from "@/lib/upstream/reliability";
import {
  calculateBreakout, calculateHistoricalVolatility, calculateRsi, calculateSma, calculateVolumeRatio,
  type IndicatorResult, type TechnicalWindowInput,
} from "./calculations";

import { TECHNICAL_INDICATORS, type StockTechnicalsQuery, type TechnicalDependencies } from "./types";
export { TECHNICAL_INDICATORS } from "./types";
export type { TechnicalIndicator, StockTechnicalsQuery, TechnicalDependencies } from "./types";

function monthBefore(date: string, offset: number): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 - offset, 1)).toISOString().slice(0, 7);
}
function validate(query: StockTechnicalsQuery): void {
  if (!/^\d{4}$/.test(query.companyCode)) throw new MopsfinError("INVALID_ARGUMENT", "company_code 必須是四位公司代碼。");
  if (query.asOf !== "latest" && (!/^\d{4}-\d{2}-\d{2}$/.test(query.asOf) || !Number.isFinite(Date.parse(query.asOf)) || new Date(query.asOf).toISOString().slice(0, 10) !== query.asOf)) throw new MopsfinError("INVALID_ARGUMENT", "as_of 必須是 latest 或有效 YYYY-MM-DD。");
  if (!["raw_unadjusted", "price_index_compatible_corporate_action_adjusted"].includes(query.priceBasis)) throw new MopsfinError("INVALID_ARGUMENT", "不支援的價格口徑。");
  if (!query.indicators.length || query.indicators.some((indicator) => !TECHNICAL_INDICATORS.includes(indicator))) throw new MopsfinError("INVALID_ARGUMENT", "indicators 必須是已登錄指標的非空子集。");
  if (!query.smaPeriods.length || query.smaPeriods.some((period) => ![5, 10, 20, 60, 120, 200].includes(period))) throw new MopsfinError("INVALID_ARGUMENT", "sma_periods 必須取自 5/10/20/60/120/200。");
}

export function technicalHistoryRequirement(query: StockTechnicalsQuery): number {
  validate(query);
  return Math.max(...query.indicators.map((indicator) => ({
    sma: Math.max(...query.smaPeriods), rsi: 251, historical_volatility: 61, breakout: 61, volume_ratio: 21,
  })[indicator]));
}

export class StockTechnicalsClient {
  private readonly dependencies: TechnicalDependencies;
  constructor(dependencies: Partial<TechnicalDependencies> = {}) {
    this.dependencies = { master: companyMasterClient, resolver: completedSessionResolver, benchmark: new BenchmarkClient(), prices: stockPriceSeriesClient, now: () => new Date(), ...dependencies };
  }

  async getStockTechnicals(query: StockTechnicalsQuery) {
    const requiredSessions = technicalHistoryRequirement(query);
    const evaluatedAt = this.dependencies.now();
    const deadline = getCurrentDeadline();
    deadline?.throwIfExpired();
    const master = await this.dependencies.master.listCompanies({ market: "all", includeFinancial: true, includeKy: true });
    const company = master.companies.find((entry) => entry.code === query.companyCode);
    if (!company) throw new MopsfinError("NOT_FOUND", "目前上市櫃公司母體沒有此代碼。");
    deadline?.throwIfExpired();
    const asOfEvidence = await this.dependencies.resolver.resolve({ market: company.market, evaluatedAt });
    if (asOfEvidence.status !== "resolved" || !asOfEvidence.expectedAsOf) throw new MopsfinError("INCOMPLETE_COVERAGE", "無法驗證最新完成交易日。", { details: { asOfEvidence } });
    const asOf = query.asOf === "latest" ? asOfEvidence.expectedAsOf : query.asOf;
    if (asOf > asOfEvidence.expectedAsOf) throw new MopsfinError("INVALID_ARGUMENT", "as_of 尚未完成交易。");

    const benchmarkBars: BenchmarkBar[] = [];
    const benchmarkSources: BenchmarkSource[] = [];
    const benchmarkMonths: string[] = [];
    let sessions: string[] = [];
    for (let offset = 0; offset < 18; offset++) {
      deadline?.throwIfExpired();
      const month = monthBefore(asOf, offset);
      const history = await this.dependencies.benchmark.getHistory(company.market, [month]);
      benchmarkMonths.push(month);
      benchmarkSources.push(...history.sources);
      if (history.market !== company.market || history.bars.some((bar) => bar.date.slice(0, 7) !== month)) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "交易日曆市場或月份與請求不符。");
      if (!history.bars.length) throw new MopsfinError("INCOMPLETE_COVERAGE", "官方交易日曆月份為空，不能略過。");
      benchmarkBars.push(...history.bars);
      if (new Set(benchmarkBars.map((bar) => bar.date)).size !== benchmarkBars.length) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "官方交易日曆有重複日期。");
      sessions = benchmarkBars.map((bar) => bar.date).filter((date) => date <= asOf).sort();
      if (offset === 0 && !sessions.includes(asOf)) throw new MopsfinError("NO_DATA", "指定日期不是官方已完成交易日；不改用前一交易日。");
      if (sessions.length >= requiredSessions) break;
    }
    sessions = sessions.slice(-requiredSessions);
    const startDate = sessions[0];
    if (!startDate) throw new MopsfinError("NO_DATA", "無可驗證交易日。");
    deadline?.throwIfExpired();
    const prices = await this.dependencies.prices.getStockPriceSeries({ companyCode: query.companyCode, startDate, endDate: asOf, priceBasis: query.priceBasis, includeEventLedger: true });
    deadline?.throwIfExpired();
    if (prices.query.companyCode !== query.companyCode || prices.requestedPriceBasis !== query.priceBasis || prices.identity.resolvedMarket !== company.market) throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "價格序列 identity 或價格口徑不符。");
    if (prices.adjustment.marketTransitionDetected || prices.identity.observedMarkets.some((market) => market !== company.market)) throw new MopsfinError("INCOMPLETE_COVERAGE", "價格視窗跨市場或含轉板前資料，無法以單一市場交易日曆驗證；請縮小至同市場視窗。");
    const input: TechnicalWindowInput = { bars: prices.bars, sessions, asOf, priceBasis: query.priceBasis };
    const indicators: Record<string, IndicatorResult> = {};
    for (const indicator of new Set(query.indicators)) {
      if (indicator === "sma") for (const period of new Set(query.smaPeriods)) indicators[`sma_${period}`] = calculateSma(input, period);
      if (indicator === "rsi") indicators.rsi_14 = calculateRsi(input);
      if (indicator === "historical_volatility") for (const period of [20, 60]) indicators[`historical_volatility_${period}`] = calculateHistoricalVolatility(input, period);
      if (indicator === "breakout") for (const period of [20, 60]) indicators[`breakout_${period}`] = calculateBreakout(input, period);
      if (indicator === "volume_ratio") indicators.volume_ratio_20 = calculateVolumeRatio(input, {
        verified: prices.coverage.corporateActions.status === "complete" && prices.adjustment.status === "complete",
        shareChangeDates: prices.eventLedger.filter((entry) => entry.event.shareCountChanged).map((entry) => entry.event.effectiveDate),
      });
    }
    return {
      query, evaluatedAt: evaluatedAt.toISOString(), asOf, timezone: "Asia/Taipei" as const,
      interval: "1d" as const, company, priceBasis: query.priceBasis, isTotalReturn: false as const,
      asOfEvidence, identity: prices.identity, indicators,
      coverage: { requiredSessions, observedMarketSessions: sessions.length, marketWindowComplete: sessions.length === requiredSessions, priceSeries: prices.coverage, indicatorsComplete: Object.values(indicators).every((item) => item.status === "available") },
      adjustment: prices.adjustment, eventLedger: prices.eventLedger,
      sources: { master: master.sources, benchmark: benchmarkSources, prices: prices.sources },
      workBudget: {
        orchestrationMasterCalls: 1, resolver: asOfEvidence.workBudget,
        benchmarkMonths, benchmarkLogicalLoads: benchmarkMonths.length, maximumBenchmarkLogicalLoads: 18,
        stockCalendarMonths: (Number(asOf.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + Number(asOf.slice(5, 7)) - Number(startDate.slice(5, 7)) + 1,
        priceSeriesCalls: 1, priceSeries: prices.workBudget,
        note: "各 dependency 的 master、raw pages、公司行動 range/detail 成本另列；logical loads 不等於 HTTP 重試次數。",
      },
      warnings: [...prices.warnings, "現金除息效果保留；此價格指數相容口徑並非含息總報酬。", ...(query.priceBasis === "raw_unadjusted" ? ["raw 模式未驗證股數變動，跨事件技術數字與量比可比性未確認。"] : [])],
    };
  }
}

export const stockTechnicalsClient = new StockTechnicalsClient();
