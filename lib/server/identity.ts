import packageMetadata from "../../package.json";

/**
 * Browser-safe service identity shared by Next.js routes, server-rendered UI,
 * documentation surfaces, and upstream HTTP clients. Keep this module free of
 * Node-only APIs and MCP handlers so importing it never pulls server code into
 * a browser bundle.
 */
export const SERVER_IDENTITY = Object.freeze({
  name: "mopsfin-taiwan-equities",
  version: packageMetadata.version,
  resultContractVersion: "mopsfin.result.v1",
  mcpEndpoint: "/api/mcp",
  publicMcpUrl: "https://mopsfin-mcp.vercel.app/api/mcp",
} as const);

export const SERVER_NAME = SERVER_IDENTITY.name;
export const SERVER_VERSION = SERVER_IDENTITY.version;
export const RESULT_CONTRACT_VERSION = SERVER_IDENTITY.resultContractVersion;
export const MCP_ENDPOINT = SERVER_IDENTITY.mcpEndpoint;
export const PUBLIC_MCP_URL = SERVER_IDENTITY.publicMcpUrl;

export const UPSTREAM_HTTP_USER_AGENT =
  `${packageMetadata.name}/${SERVER_VERSION} (+https://mopsfin.twse.com.tw/)`;
