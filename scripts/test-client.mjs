import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import packageMetadata from "../package.json" with { type: "json" };

const endpoint = new URL(
  process.argv[2] ??
    process.env.MOPSFIN_MCP_URL ??
    "http://localhost:3000/api/mcp",
);
const healthEndpoint = new URL("/api/health", endpoint);
const client = new Client({
  name: "mopsfin-smoke-test",
  version: packageMetadata.version,
});

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const healthResponse = await fetch(healthEndpoint, {
    headers: { Accept: "application/json" },
  });
  if (!healthResponse.ok) {
    throw new Error(
      `Health request failed (${healthResponse.status}) at ${healthEndpoint.href}`,
    );
  }
  const health = await healthResponse.json();
  const server = client.getServerVersion();
  if (server?.name !== health.service || server?.version !== health.version) {
    throw new Error(
      `MCP initialize does not match health identity: ${JSON.stringify({ server, healthService: health.service, healthVersion: health.version })}`,
    );
  }
  if (!Number.isInteger(health.toolCount) || names.length !== health.toolCount) {
    throw new Error(
      `tools/list returned ${names.length} tools but health reports ${String(health.toolCount)}: ${names.join(", ")}`,
    );
  }
  if (!names.includes("get_stock_price_series")) {
    throw new Error(
      `tools/list is missing the v0.7 price-series contract: ${names.join(", ")}`,
    );
  }
  if (health.mcpEndpoint !== endpoint.pathname) {
    throw new Error(
      `Health MCP endpoint ${String(health.mcpEndpoint)} does not match ${endpoint.pathname}`,
    );
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
        healthEndpoint: healthEndpoint.href,
        server,
        health: {
          version: health.version,
          toolCount: health.toolCount,
          liveness: health.liveness,
          applicationReadiness: health.applicationReadiness,
          upstreamContracts: health.upstreamContracts,
        },
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
