import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { researchPresentationSchema } from "@/lib/mcp/schema/research";
import { projectResearchRows } from "@/lib/research/projection";
import { screenCompaniesInputSchema, compareCompaniesInputSchema, stockTechnicalsInputSchema } from "@/lib/mcp/schema/research-inputs";

describe("research input contracts", () => {
  it("does not manufacture explicit financial parameters for a market-only comparison", () => {
    const input = compareCompaniesInputSchema.parse({ company_codes: ["2330"], columns: ["price.close"] });
    expect(input.financial_period_policy).toBeUndefined();
    expect(input.financial_basis).toBeUndefined();
    expect(compareCompaniesInputSchema.safeParse({ ...input, financial_period_policy: "common_latest" }).success).toBe(false);
    expect(compareCompaniesInputSchema.safeParse({ ...input, columns: ["financial.EPS"], financial_period_policy: "explicit" }).success).toBe(false);
    expect(compareCompaniesInputSchema.safeParse({ ...input, company_codes: ["2330", "2330"] }).success).toBe(false);
  });
  it("rejects impossible dates and duplicate indicators while preserving cursor page size inheritance", () => {
    expect(stockTechnicalsInputSchema.safeParse({ company_code: "2330", as_of: "2026-02-30" }).success).toBe(false);
    expect(stockTechnicalsInputSchema.safeParse({ company_code: "2330", indicators: ["rsi", "rsi"] }).success).toBe(false);
    expect(screenCompaniesInputSchema.parse({ cursor: "opaque", filters: [{ field: "company.code", op: "eq", value: "2330" }] }).page_size).toBeUndefined();
    expect(screenCompaniesInputSchema.safeParse({ filters: [] }).success).toBe(false);
    expect(screenCompaniesInputSchema.safeParse({ as_of: "2026-08-28" }).success).toBe(false);
  });
});

describe("research output variants through the MCP SDK", () => {
  it("preserves required keys for each root object variant and validates callTool output", async () => {
    const server = new McpServer({ name: "research-contract-test", version: "1" });
    const client = new Client({ name: "test", version: "1" });
    server.registerTool("probe", {
      inputSchema: z.object({ mode: z.enum(["full", "compact", "summary"]) }),
      outputSchema: researchPresentationSchema,
    }, async ({ mode }) => ({ content: [], structuredContent: projectResearchRows([], ["price.close"], mode, "entire_selection") }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      const listed = await client.listTools();
      expect(listed.tools[0].outputSchema).toMatchObject({ type: "object", anyOf: expect.any(Array) });
      for (const mode of ["full", "compact", "summary"] as const) {
        const output = await client.callTool({ name: "probe", arguments: { mode } });
        expect(output.isError).not.toBe(true);
        expect(researchPresentationSchema.safeParse(output.structuredContent).success).toBe(true);
      }
      expect(researchPresentationSchema.safeParse({ outputMode: "full", scope: "entire_selection", rowCount: 0, rowsOmitted: false }).success).toBe(false);
      expect(researchPresentationSchema.safeParse({ outputMode: "summary", scope: "entire_selection", rowCount: 0, rowsOmitted: true }).success).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
});
