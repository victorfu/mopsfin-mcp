import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  assertDeploymentContract,
  canonicalToolContractSha256,
  LOCAL_PACKAGE_VERSION,
  resolveSmokeTimeoutMs,
  runWithOverallDeadline,
  serverInstructionsSha256,
} from "./test-client-contract.mjs";

const endpoint = new URL(
  process.argv[2] ??
    process.env.MOPSFIN_MCP_URL ??
    "http://localhost:3000/api/mcp",
);
const healthEndpoint = new URL("/api/health", endpoint);
const timeoutMs = resolveSmokeTimeoutMs();

await runWithOverallDeadline(
  "MopsFin deployment contract smoke",
  timeoutMs,
  async (deadline) => {
    const client = new Client({
      name: "mopsfin-deployment-contract-smoke",
      version: LOCAL_PACKAGE_VERSION,
    });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint),
        deadline.requestOptions(),
      );
      const { tools } = await client.listTools(
        undefined,
        deadline.requestOptions(),
      );
      const healthResponse = await fetch(healthEndpoint, {
        headers: { Accept: "application/json" },
        signal: deadline.signal,
      });
      if (!healthResponse.ok) {
        throw new Error(
          `Health request failed (${healthResponse.status}) at ${healthEndpoint.href}`,
        );
      }
      const health = await healthResponse.json();
      const server = client.getServerVersion();
      const serverInstructions = client.getInstructions();

      assertDeploymentContract({
        server,
        serverInstructions,
        health,
        tools,
        endpointPath: endpoint.pathname,
      });

      process.stdout.write(
        `${JSON.stringify(
          {
            check: "deployment_contract",
            endpoint: endpoint.href,
            healthEndpoint: healthEndpoint.href,
            timeoutMs,
            server,
            resultContractVersion: health.resultContractVersion,
            health: {
              status: health.status,
              liveness: health.liveness,
              applicationReadiness: health.applicationReadiness,
              readiness: health.readiness,
              upstreamContracts: health.upstreamContracts,
              toolCount: health.toolCount,
            },
            toolNames: tools.map((tool) => tool.name),
            toolContractSha256: canonicalToolContractSha256(tools),
            serverInstructionsSha256:
              serverInstructionsSha256(serverInstructions),
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
