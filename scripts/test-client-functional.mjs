import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  assertFindCompaniesFunctionalResult,
  LOCAL_PACKAGE_VERSION,
  resolveSmokeTimeoutMs,
  runWithOverallDeadline,
} from "./test-client-contract.mjs";

const endpoint = new URL(
  process.argv[2] ??
    process.env.MOPSFIN_MCP_URL ??
    "http://localhost:3000/api/mcp",
);
const timeoutMs = resolveSmokeTimeoutMs();

await runWithOverallDeadline(
  "MopsFin find_companies functional probe",
  timeoutMs,
  async (deadline) => {
    const client = new Client({
      name: "mopsfin-upstream-functional-smoke",
      version: LOCAL_PACKAGE_VERSION,
    });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint),
        deadline.requestOptions(),
      );
      const result = await client.callTool(
        {
          name: "find_companies",
          arguments: { query: "2330", limit: 3 },
        },
        deadline.requestOptions(),
      );
      const data = assertFindCompaniesFunctionalResult(result);

      process.stdout.write(
        `${JSON.stringify(
          {
            check: "find_companies_functional",
            endpoint: endpoint.href,
            timeoutMs,
            server: client.getServerVersion(),
            ok: data.ok,
            contractVersion: data.meta.contractVersion,
            companies: data.companies,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await client.close();
    }
  },
);
