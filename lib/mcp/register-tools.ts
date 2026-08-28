import type { McpServer } from "@modelcontextprotocol/server";

import { registerToolRegistry } from "./tool-registry";

export { TOOL_REGISTRY } from "./tool-registry";

export function registerMopsfinTools(server: McpServer): void {
  registerToolRegistry(server);
}
