import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getIndustryDataTool } from "@/lib/mcp/tools/financials";
import { industryDataOutputSchema } from "@/lib/mcp/schema/financials";
import { MopsfinClient, mopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinHttpClient } from "@/lib/mopsfin/http";

const catalog = readFileSync(new URL("./fixtures/catalog.html", import.meta.url), "utf8");
const statistics = JSON.parse(readFileSync(new URL("./fixtures/industry-statistics.json", import.meta.url), "utf8"));
const clock = () => new Date("2026-09-07T03:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

async function callIndustryTool(args: Record<string, unknown>) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/") return new Response(catalog);
    if (url.pathname !== "/compare/bcode") throw new Error(`Unexpected ${url.pathname}`);
    const fields = init?.body as URLSearchParams;
    return Response.json(fields.get("ys") !== "0" ? statistics : {
      ylabel: "新台幣仟元", xaxisList: ["2025Q4", "2026Q1"],
      graphData: [{ label: "半導體業", data: [[0, 100], [1, 120]] }],
    });
  });
  const client = new MopsfinClient(new MopsfinHttpClient(fetchMock, { now: clock, maxAttempts: 1 }), clock);
  vi.spyOn(mopsfinClient, "getIndustryData").mockImplementation((query) => client.getIndustryData(query));
  const server = new McpServer({ name: "industry-test", version: "1" }, { capabilities: { tools: {} } });
  getIndustryDataTool.register(server);
  const mcp = new Client({ name: "industry-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await mcp.connect(ct);
    const response = await mcp.callTool({ name: "get_industry_data", arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return { data: industryDataOutputSchema.parse(response.structuredContent), content: response.content };
  } finally {
    await Promise.allSettled([mcp.close(), server.close()]);
  }
}

describe("industry data metadata through HTTP, client and MCP", () => {
  it.each(["latest", "2026Q1"])("uses the verified quarter for statistics period=%s", async (period) => {
    const { data, content } = await callIndustryTool({ mode: "statistics", period });
    expect(data.query.period).toBe("2026Q1");
    expect(data.periods).toEqual(["半導體業", "水泥工業"]);
    expect(data.meta.asOf.resolved).toEqual({ granularity: "quarter", from: "2026Q1", through: "2026Q1" });
    expect(data.meta.asOf.selector).toBe(period === "latest" ? "latest" : "explicit");
    expect(data.meta.asOf.sourceCutoffs[0].resolved).toEqual(data.meta.asOf.resolved);
    expect(data.meta.quality.freshnessDetails[0].observedAsOf).toBe("2026Q1");
    expect(JSON.stringify(content)).toContain("2026Q1");
    expect(JSON.stringify(content)).toContain("2 個產業");
    const wrong = structuredClone(data);
    wrong.meta.asOf.resolved.from = "半導體業";
    expect(industryDataOutputSchema.safeParse(wrong).success).toBe(false);
    const missingPeriod = structuredClone(data);
    delete missingPeriod.query.period;
    expect(industryDataOutputSchema.safeParse(missingPeriod).success).toBe(false);
  });

  it("keeps trend periods and metadata as a chronological quarter range", async () => {
    const { data } = await callIndustryTool({ mode: "trend", industry_codes: ["24"], start_period: "2025Q4", end_period: "2026Q1" });
    expect(data.periods).toEqual(["2025Q4", "2026Q1"]);
    expect(data.series[0].points.map((point) => point.value)).toEqual([100, 120]);
    expect(data.meta.asOf.resolved).toEqual({ granularity: "quarter", from: "2025Q4", through: "2026Q1" });
    expect(data.meta.asOf.selector).toBe("range");
    expect(data.meta.quality.freshnessDetails[0].observedAsOf).toBe("2026Q1");
  });
});
