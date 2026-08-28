import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";

import {
  TOOL_REGISTRY,
  registerToolRegistry,
} from "@/lib/mcp/tool-registry";
import {
  PUBLIC_TOOL_NAMES,
  TOOL_COUNT,
} from "@/lib/mcp/tool-manifest";

describe("canonical MCP tool registry", () => {
  it("matches the ordered dependency-free public manifest one-to-one", () => {
    const names = TOOL_REGISTRY.map((definition) => definition.name);

    expect(TOOL_COUNT).toBe(19);
    expect(names).toEqual(PUBLIC_TOOL_NAMES);
    expect(new Set(names).size).toBe(TOOL_COUNT);
  });

  it("keeps every public contract component on its canonical definition", () => {
    for (const definition of TOOL_REGISTRY) {
      expect(definition.config.title?.length).toBeGreaterThan(0);
      expect(definition.config.description?.length).toBeGreaterThanOrEqual(180);
      expect(definition.config.inputSchema).toBeDefined();
      expect(definition.config.outputSchema).toBeDefined();
      expect(definition.config.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("registers the same definitions in manifest order", () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;

    registerToolRegistry(server);

    expect(registerTool).toHaveBeenCalledTimes(TOOL_COUNT);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(
      PUBLIC_TOOL_NAMES,
    );
    for (const [index, definition] of TOOL_REGISTRY.entries()) {
      expect(registerTool.mock.calls[index]?.[1]).toBe(definition.config);
      expect(registerTool.mock.calls[index]?.[2]).toBe(
        (definition as typeof definition & { handler: unknown }).handler,
      );
    }
  });
});
