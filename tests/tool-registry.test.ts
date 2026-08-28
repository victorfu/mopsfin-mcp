import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  TOOL_REGISTRY,
  registerToolRegistry,
} from "@/lib/mcp/tool-registry";
import {
  canonicalJson,
  PUBLIC_MCP_ENDPOINT,
  PUBLIC_MCP_SERVER_NAME,
  PUBLIC_RESULT_CONTRACT_VERSION,
  PUBLIC_SERVER_INSTRUCTIONS_SHA256,
  PUBLIC_TOOL_CONTRACT_SHA256,
  PUBLIC_TOOL_NAMES,
  publicToolContractPayload,
  TOOL_COUNT,
} from "@/lib/mcp/tool-manifest";
import { MOPSFIN_SERVER_INSTRUCTIONS } from "@/lib/mopsfin/guidance";
import {
  MCP_ENDPOINT,
  RESULT_CONTRACT_VERSION,
  SERVER_NAME,
} from "@/lib/server/identity";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("canonical MCP tool registry", () => {
  it("matches the ordered dependency-free public manifest one-to-one", () => {
    const names = TOOL_REGISTRY.map((definition) => definition.name);

    expect(TOOL_COUNT).toBe(23);
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

  it("keeps dependency-free deployment identity constants synchronized", () => {
    expect(PUBLIC_MCP_SERVER_NAME).toBe(SERVER_NAME);
    expect(PUBLIC_RESULT_CONTRACT_VERSION).toBe(RESULT_CONTRACT_VERSION);
    expect(PUBLIC_MCP_ENDPOINT).toBe(MCP_ENDPOINT);
  });

  it("matches canonical tools/list and initialize-instructions SHA-256 values", async () => {
    const server = new McpServer(
      { name: PUBLIC_MCP_SERVER_NAME, version: "contract-test" },
      {
        capabilities: { tools: {} },
        instructions: MOPSFIN_SERVER_INSTRUCTIONS,
      },
    );
    registerToolRegistry(server);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();

      expect(sha256(canonicalJson(publicToolContractPayload(tools)))).toBe(
        PUBLIC_TOOL_CONTRACT_SHA256,
      );
      expect(sha256(client.getInstructions() ?? "")).toBe(
        PUBLIC_SERVER_INSTRUCTIONS_SHA256,
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
