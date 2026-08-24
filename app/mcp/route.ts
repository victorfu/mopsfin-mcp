import { createMcpHandler } from "mcp-handler";

import { registerMopsfinTools } from "@/lib/mcp/register-tools";

const handler = createMcpHandler(
  (server) => {
    registerMopsfinTools(server);
  },
  {
    serverInfo: {
      name: "mopsfin-taiwan-equities",
      version: "0.1.0",
    },
    instructions:
      "唯讀查詢台灣公開發行公司的 Mopsfin 財務資料。未知代號先呼叫 find_companies 或 list_catalog；重要投資判斷應回查公開資訊觀測站原始申報。",
    maxSubscriptions: 0,
  },
);

export const runtime = "nodejs";
export const maxDuration = 60;

export { handler as GET, handler as POST };
