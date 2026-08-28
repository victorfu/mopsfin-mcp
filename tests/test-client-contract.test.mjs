import { describe, expect, it } from "vitest";

import {
  PUBLIC_MCP_ENDPOINT,
  PUBLIC_MCP_SERVER_NAME,
  PUBLIC_RESULT_CONTRACT_VERSION,
  PUBLIC_SERVER_INSTRUCTIONS_SHA256,
  PUBLIC_TOOL_CONTRACT_SHA256,
  PUBLIC_TOOL_NAMES,
} from "../lib/mcp/tool-manifest.ts";
import {
  assertDeploymentContract,
  assertFindCompaniesFunctionalResult,
  canonicalJson,
  canonicalToolContractSha256,
  DEPLOYMENT_CONTRACT_EXPECTATIONS,
  EXPECTED_PUBLIC_TOOL_NAMES,
  LOCAL_PACKAGE_VERSION,
  resolveSmokeTimeoutMs,
  runWithOverallDeadline,
  serverInstructionsSha256,
} from "../scripts/test-client-contract.mjs";

const VALID_SERVER = {
  name: PUBLIC_MCP_SERVER_NAME,
  version: LOCAL_PACKAGE_VERSION,
};
const TEST_INSTRUCTIONS = "Deterministic local server instructions.";
const TEST_TOOLS = EXPECTED_PUBLIC_TOOL_NAMES.map((name) => ({
  name,
  title: `Title for ${name}`,
  description: `Description for ${name}`,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}));
const TEST_EXPECTATIONS = {
  ...DEPLOYMENT_CONTRACT_EXPECTATIONS,
  toolContractSha256: canonicalToolContractSha256(TEST_TOOLS),
  serverInstructionsSha256: serverInstructionsSha256(TEST_INSTRUCTIONS),
};

function validHealth() {
  return {
    status: "ok",
    liveness: "ok",
    service: PUBLIC_MCP_SERVER_NAME,
    version: LOCAL_PACKAGE_VERSION,
    resultContractVersion: PUBLIC_RESULT_CONTRACT_VERSION,
    toolCount: EXPECTED_PUBLIC_TOOL_NAMES.length,
    applicationReadiness: "ready",
    readiness: {
      status: "ready",
      upstreamChecks: "not_run",
      note: "Shallow application readiness only.",
    },
    upstreamContracts: {
      status: "not_checked",
      lastCheckedAt: null,
    },
    mcpEndpoint: PUBLIC_MCP_ENDPOINT,
  };
}

function assertContract(overrides = {}, expectationOverrides = {}) {
  assertDeploymentContract(
    {
      server: VALID_SERVER,
      serverInstructions: TEST_INSTRUCTIONS,
      health: validHealth(),
      tools: structuredClone(TEST_TOOLS),
      endpointPath: PUBLIC_MCP_ENDPOINT,
      ...overrides,
    },
    { ...TEST_EXPECTATIONS, ...expectationOverrides },
  );
}

function validFunctionalResult() {
  return {
    structuredContent: {
      ok: true,
      meta: { contractVersion: PUBLIC_RESULT_CONTRACT_VERSION },
      companies: [
        { code: "2330", name: "台灣積體電路製造", displayName: "2330 台積電" },
      ],
    },
  };
}

describe("remote deployment smoke contract", () => {
  it("loads names, identity, endpoint, result contract, and hashes from the dependency-free manifest", () => {
    expect(EXPECTED_PUBLIC_TOOL_NAMES).toEqual(PUBLIC_TOOL_NAMES);
    expect(DEPLOYMENT_CONTRACT_EXPECTATIONS).toMatchObject({
      serverName: PUBLIC_MCP_SERVER_NAME,
      resultContractVersion: PUBLIC_RESULT_CONTRACT_VERSION,
      endpointPath: PUBLIC_MCP_ENDPOINT,
      toolContractSha256: PUBLIC_TOOL_CONTRACT_SHA256,
      serverInstructionsSha256: PUBLIC_SERVER_INSTRUCTIONS_SHA256,
    });
  });

  it("accepts the exact deployment and shallow health contracts", () => {
    expect(() => assertContract()).not.toThrow();
  });

  it("rejects stale MCP and health versions independently", () => {
    expect(() =>
      assertContract({ server: { ...VALID_SERVER, version: "0.5.1" } }),
    ).toThrow(/MCP version .* does not match local package version/);
    expect(() =>
      assertContract({ health: { ...validHealth(), version: "0.5.1" } }),
    ).toThrow(/health version .* does not match local package version/);
  });

  it("rejects missing, extra, or reordered deployed tools", () => {
    expect(() => assertContract({ tools: TEST_TOOLS.slice(1) })).toThrow(
      /does not exactly match canonical PUBLIC_TOOL_NAMES/,
    );
    expect(() =>
      assertContract({
        tools: [...TEST_TOOLS, { ...TEST_TOOLS[0], name: "unexpected_tool" }],
      }),
    ).toThrow(/does not exactly match canonical PUBLIC_TOOL_NAMES/);

    const reordered = structuredClone(TEST_TOOLS);
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(() => assertContract({ tools: reordered })).toThrow(
      /does not exactly match canonical PUBLIC_TOOL_NAMES/,
    );
  });

  it("rejects tools/list field drift and server-instructions drift by SHA-256", () => {
    const changedTools = structuredClone(TEST_TOOLS);
    changedTools[0].description = "Changed public description";
    expect(() => assertContract({ tools: changedTools })).toThrow(
      /tools\/list public contract SHA-256 mismatch/,
    );
    expect(() =>
      assertContract({ serverInstructions: `${TEST_INSTRUCTIONS} changed` }),
    ).toThrow(/server instructions SHA-256 mismatch/);
  });

  it("canonicalizes object keys while preserving ordered arrays", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(canonicalJson(["second", "first"])).toBe('["second","first"]');
  });

  it("rejects every required health contract surface", () => {
    expect(() =>
      assertContract({
        health: { ...validHealth(), resultContractVersion: "stale.result.v0" },
      }),
    ).toThrow(/Health resultContractVersion/);
    expect(() =>
      assertContract({ health: { ...validHealth(), liveness: "failed" } }),
    ).toThrow(/liveness contract/);
    expect(() =>
      assertContract({
        health: { ...validHealth(), applicationReadiness: "starting" },
      }),
    ).toThrow(/applicationReadiness/);
    expect(() =>
      assertContract({
        health: {
          ...validHealth(),
          readiness: { ...validHealth().readiness, upstreamChecks: "passed" },
        },
      }),
    ).toThrow(/readiness contract/);
    expect(() =>
      assertContract({
        health: {
          ...validHealth(),
          upstreamContracts: { status: "ok", lastCheckedAt: null },
        },
      }),
    ).toThrow(/upstreamContracts/);
  });

  it("rejects stale health count, identity, and endpoint metadata", () => {
    expect(() =>
      assertContract({ health: { ...validHealth(), toolCount: 16 } }),
    ).toThrow(/health toolCount .* canonical PUBLIC_TOOL_NAMES count/);
    expect(() =>
      assertContract({ server: { ...VALID_SERVER, name: "stale-service" } }),
    ).toThrow(/does not match canonical server name/);
    expect(() =>
      assertContract({ health: { ...validHealth(), service: "stale-service" } }),
    ).toThrow(/does not match canonical server name/);
    expect(() => assertContract({ endpointPath: "/stale" })).toThrow(
      /Smoke target path/,
    );
    expect(() =>
      assertContract({ health: { ...validHealth(), mcpEndpoint: "/stale" } }),
    ).toThrow(/Health MCP endpoint/);
  });
});

describe("upstream functional smoke contract", () => {
  it("strictly accepts ok, meta.contractVersion, and a 2330 company match", () => {
    expect(assertFindCompaniesFunctionalResult(validFunctionalResult())).toEqual(
      validFunctionalResult().structuredContent,
    );
  });

  it("rejects tool errors and malformed structured success fields", () => {
    expect(() =>
      assertFindCompaniesFunctionalResult({ isError: true, content: [] }),
    ).toThrow(/MCP tool error/);
    expect(() =>
      assertFindCompaniesFunctionalResult({
        structuredContent: {
          ...validFunctionalResult().structuredContent,
          ok: false,
        },
      }),
    ).toThrow(/ok=true/);
    expect(() =>
      assertFindCompaniesFunctionalResult({
        structuredContent: {
          ...validFunctionalResult().structuredContent,
          meta: { contractVersion: "stale.result.v0" },
        },
      }),
    ).toThrow(/meta.contractVersion/);
    expect(() =>
      assertFindCompaniesFunctionalResult({
        structuredContent: {
          ...validFunctionalResult().structuredContent,
          companies: [],
        },
      }),
    ).toThrow(/non-empty companies array/);
    expect(() =>
      assertFindCompaniesFunctionalResult({
        structuredContent: {
          ...validFunctionalResult().structuredContent,
          companies: [
            { code: "2454", name: "聯發科技", displayName: "2454 聯發科" },
          ],
        },
      }),
    ).toThrow(/did not return company code 2330/);
  });
});

describe("smoke deadline", () => {
  it("uses a bounded configurable timeout", () => {
    expect(resolveSmokeTimeoutMs(undefined)).toBe(60_000);
    expect(resolveSmokeTimeoutMs("1250")).toBe(1_250);
    expect(() => resolveSmokeTimeoutMs("999")).toThrow(/1000 through 300000/);
    expect(() => resolveSmokeTimeoutMs("Infinity")).toThrow(
      /1000 through 300000/,
    );
  });

  it("aborts one overall deadline instead of resetting it per operation", async () => {
    await expect(
      runWithOverallDeadline("test smoke", 5, () => new Promise(() => {})),
    ).rejects.toThrow(/exceeded its overall 5 ms deadline/);
  });
});
