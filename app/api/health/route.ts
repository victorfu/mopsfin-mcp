import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "mopsfin-taiwan-equities",
      version: "0.1.0",
      mcpEndpoint: "/api/mcp",
      sourceUrl: "https://mopsfin.twse.com.tw/",
      checkedAt: new Date().toISOString(),
      note: "此端點只確認應用程式可回應，不會為健康檢查呼叫 Mopsfin。",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
