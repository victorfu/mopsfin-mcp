import { createMcpHandler } from "mcp-handler";

import { registerMopsfinTools } from "@/lib/mcp/register-tools";
import { MOPSFIN_SERVER_INSTRUCTIONS } from "@/lib/mopsfin/guidance";
import {
  observeMcpRequest,
  recordMcpSdkEvent,
} from "@/lib/observability/telemetry";
import { runWithRequestDeadline } from "@/lib/upstream/reliability";

const MCP_REQUEST_DEADLINE_MS = 52_000;

const handler = createMcpHandler(
  (server) => {
    registerMopsfinTools(server);
  },
  {
    serverInfo: {
      name: "mopsfin-taiwan-equities",
      version: "0.6.1",
    },
    instructions: MOPSFIN_SERVER_INSTRUCTIONS,
    maxSubscriptions: 0,
    onEvent: recordMcpSdkEvent,
  },
);

export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(request: Request) {
  return runWithRequestDeadline(
    MCP_REQUEST_DEADLINE_MS,
    () => observeMcpRequest(request, handler),
    request.signal,
  );
}

export function POST(request: Request) {
  return runWithRequestDeadline(
    MCP_REQUEST_DEADLINE_MS,
    () => observeMcpRequest(request, handler),
    request.signal,
  );
}
