import { NextResponse } from "next/server";

import { telemetrySnapshot } from "@/lib/observability/telemetry";
import { getUpstreamReliabilitySnapshot } from "@/lib/upstream/reliability";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "mopsfin-taiwan-equities",
      version: "0.4.1",
      resultContractVersion: "mopsfin.result.v1",
      toolCount: 16,
      readiness: {
        status: "ready",
        upstreamChecks: "not_run",
        note: "深度官方來源契約由低頻 synthetic workflow 驗證；此端點不放大上游流量。",
      },
      telemetry: telemetrySnapshot(),
      upstreamReliability: getUpstreamReliabilitySnapshot(),
      mcpEndpoint: "/api/mcp",
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
      },
      checkedAt: new Date().toISOString(),
      note: "此端點只確認應用程式可回應，不會為健康檢查呼叫 Mopsfin、TWSE 或 TPEx 財務／行情來源。",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
