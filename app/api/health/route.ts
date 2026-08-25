import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "mopsfin-taiwan-equities",
      version: "0.1.1",
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
