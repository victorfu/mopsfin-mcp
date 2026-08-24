import { createMcpHandler } from "mcp-handler";

import { registerMopsfinTools } from "@/lib/mcp/register-tools";
import { MOPSFIN_SERVER_INSTRUCTIONS } from "@/lib/mopsfin/guidance";

const handler = createMcpHandler(
  (server) => {
    registerMopsfinTools(server);
  },
  {
    serverInfo: {
      name: "mopsfin-taiwan-equities",
      version: "0.1.0",
    },
    instructions: MOPSFIN_SERVER_INSTRUCTIONS,
    maxSubscriptions: 0,
  },
);

export const runtime = "nodejs";
export const maxDuration = 60;

export { handler as GET, handler as POST };
