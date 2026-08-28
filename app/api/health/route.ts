import { NextResponse } from "next/server";

import { TOOL_COUNT } from "@/lib/mcp/tool-manifest";
import { telemetrySnapshot } from "@/lib/observability/telemetry";
import { SERVER_IDENTITY } from "@/lib/server/identity";
import { getUpstreamReliabilitySnapshot } from "@/lib/upstream/reliability";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      liveness: "ok",
      service: SERVER_IDENTITY.name,
      version: SERVER_IDENTITY.version,
      resultContractVersion: SERVER_IDENTITY.resultContractVersion,
      toolCount: TOOL_COUNT,
      applicationReadiness: "ready",
      readiness: {
        status: "ready",
        upstreamChecks: "not_run",
        note: "這是 shallow application readiness；深度官方來源契約由低頻 synthetic workflow 驗證，此端點不放大上游流量。",
      },
      upstreamContracts: {
        status: "not_checked",
        lastCheckedAt: null,
      },
      telemetry: telemetrySnapshot(),
      upstreamReliability: getUpstreamReliabilitySnapshot(),
      mcpEndpoint: SERVER_IDENTITY.mcpEndpoint,
      sourceUrls: {
        mopsfin: "https://mopsfin.twse.com.tw/",
        twseCompanies:
          "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
        tpexCompanies:
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
        twseOhlc: "https://www.twse.com.tw/zh/trading/historical/stock-day.html",
        tpexOhlc:
          "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html",
        twseValuation:
          "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
        tpexValuation:
          "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
        twseMonthlyRevenue:
          "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
        tpexMonthlyRevenue:
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
        mopsMonthlyRevenueArchive:
          "https://mopsov.twse.com.tw/nas/t21/{sii|otc}/t21sc03_{ROC_YEAR}_{MONTH}.csv",
        twseHistoricalValuation:
          "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d",
        tpexHistoricalValuation:
          "https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate",
        twseBenchmark:
          "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST",
        tpexBenchmark:
          "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex",
        twseTradingCalendar:
          "https://www.twse.com.tw/holidaySchedule/holidaySchedule",
        tpexTradingCalendar:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate",
        twseExRightDividend:
          "https://www.twse.com.tw/rwd/zh/exRight/TWT49U",
        twseExRightDividendDetail:
          "https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail",
        twseCapitalReduction:
          "https://www.twse.com.tw/rwd/zh/reducation/TWTAUU",
        twseParValueChange:
          "https://www.twse.com.tw/rwd/zh/change/TWTB8U",
        tpexExRightDividend:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ",
        tpexCapitalReduction:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/revivt",
        tpexParValueChange:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt",
        twseMaterialInformation:
          "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
        tpexMaterialInformation:
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
        mopsMaterialInformationHistory:
          "https://mopsov.twse.com.tw/mops/web/ajax_t05st01",
        mopsInvestorConferenceHistory:
          "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1",
        twseForecastAchievementSnapshot:
          "https://openapi.twse.com.tw/v1/opendata/t187ap15_L",
        tpexForecastAchievementSnapshot:
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O",
        twseForecastMaterialVarianceSnapshot:
          "https://openapi.twse.com.tw/v1/opendata/t187ap16_L",
        tpexForecastMaterialVarianceSnapshot:
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap16_O",
        twseShareholderMeetingSnapshot:
          "https://openapi.twse.com.tw/v1/opendata/t187ap41_L",
        tpexShareholderMeetingSnapshot:
          "https://www.tpex.org.tw/openapi/v1/t187ap41_O",
        twseDividendDecisionSnapshot:
          "https://openapi.twse.com.tw/v1/opendata/t187ap45_L",
      },
      checkedAt: new Date().toISOString(),
      note: "此 shallow health 端點只確認應用程式可回應且可接受請求，不會為健康檢查呼叫 Mopsfin、TWSE 或 TPEx 財務／行情來源；ready 不代表上游資料契約已在本次請求驗證。",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
