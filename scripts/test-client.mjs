import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const endpoint = new URL(
  process.argv[2] ??
    process.env.MOPSFIN_MCP_URL ??
    "http://localhost:3000/api/mcp",
);
const client = new Client({ name: "mopsfin-smoke-test", version: "0.3.1" });

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  const expected = [
    "find_companies",
    "get_stock_ohlc",
    "get_daily_market_ohlc",
    "get_stock_reaction_signals",
    "get_daily_market_valuation",
    "get_monthly_revenue",
    "get_monthly_revenue_trend",
    "list_companies",
    "list_catalog",
    "get_company_metric",
    "get_company_metrics_batch",
    "get_financial_statement",
    "get_financial_note",
    "get_industry_data",
    "get_financial_institution_metric",
  ];
  const names = tools.map((tool) => tool.name);
  if (names.length !== expected.length) {
    throw new Error(
      `Expected exactly ${expected.length} tools, received ${names.length}: ${names.join(", ")}`,
    );
  }
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }
  const server = client.getServerVersion();
  if (server?.version !== "0.3.1") {
    throw new Error(`Expected server version 0.3.1, received ${server?.version ?? "unknown"}`);
  }

  const result = await client.callTool({
    name: "find_companies",
    arguments: { query: "2330", limit: 3 },
  });
  if (result.isError || result.structuredContent === undefined) {
    throw new Error(`find_companies failed: ${JSON.stringify(result.content)}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        endpoint: endpoint.href,
        server,
        tools: names,
        findCompanies: result.structuredContent,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
}
