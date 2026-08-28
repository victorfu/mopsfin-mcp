import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";

import type { McpToolName } from "../tool-manifest";

export interface ToolDefinition {
  readonly name: McpToolName;
  readonly config: {
    title?: string;
    description?: string;
    inputSchema: StandardSchemaWithJSON;
    outputSchema: StandardSchemaWithJSON;
    annotations?: ToolAnnotations;
  };
  register(server: McpServer): void;
}

export function defineTool<
  const Name extends McpToolName,
  Input extends StandardSchemaWithJSON,
  Output extends StandardSchemaWithJSON,
>(
  name: Name,
  config: {
    title?: string;
    description?: string;
    inputSchema: Input;
    outputSchema: Output;
    annotations?: ToolAnnotations;
  },
  handler: ToolCallback<Input>,
): ToolDefinition & { readonly handler: ToolCallback<Input> } {
  return {
    name,
    config,
    handler,
    register(server: McpServer): void {
      server.registerTool(name, config, handler);
    },
  } as const;
}
