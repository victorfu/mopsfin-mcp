import { createHash } from "node:crypto";

import packageMetadata from "../package.json" with { type: "json" };
import {
  canonicalJson,
  PUBLIC_MCP_ENDPOINT,
  PUBLIC_MCP_SERVER_NAME,
  PUBLIC_RESULT_CONTRACT_VERSION,
  PUBLIC_SERVER_INSTRUCTIONS_SHA256,
  PUBLIC_TOOL_CONTRACT_SHA256,
  PUBLIC_TOOL_NAMES,
  publicToolContractPayload,
} from "../lib/mcp/tool-manifest.ts";

export { canonicalJson, publicToolContractPayload };

export const LOCAL_PACKAGE_VERSION = packageMetadata.version;
export const EXPECTED_PUBLIC_TOOL_NAMES = Object.freeze([...PUBLIC_TOOL_NAMES]);
export const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;

export const DEPLOYMENT_CONTRACT_EXPECTATIONS = Object.freeze({
  serverName: PUBLIC_MCP_SERVER_NAME,
  resultContractVersion: PUBLIC_RESULT_CONTRACT_VERSION,
  endpointPath: PUBLIC_MCP_ENDPOINT,
  toolNames: EXPECTED_PUBLIC_TOOL_NAMES,
  toolContractSha256: PUBLIC_TOOL_CONTRACT_SHA256,
  serverInstructionsSha256: PUBLIC_SERVER_INSTRUCTIONS_SHA256,
});

export function sha256Utf8(value) {
  if (typeof value !== "string") {
    throw new TypeError("SHA-256 input must be a string.");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalToolContractSha256(tools) {
  return sha256Utf8(canonicalJson(publicToolContractPayload(tools)));
}

export function serverInstructionsSha256(instructions) {
  if (typeof instructions !== "string" || instructions.length === 0) {
    throw new TypeError(
      "MCP initialize did not return a non-empty server instructions string.",
    );
  }
  return sha256Utf8(instructions);
}

function firstOrderedDifference(actual, expected) {
  const comparedLength = Math.max(actual.length, expected.length);
  for (let index = 0; index < comparedLength; index += 1) {
    if (actual[index] !== expected[index]) {
      return {
        index,
        expected: expected[index] ?? null,
        actual: actual[index] ?? null,
      };
    }
  }
  return null;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

export function assertDeploymentContract(
  { server, serverInstructions, health, tools, endpointPath },
  expectations = DEPLOYMENT_CONTRACT_EXPECTATIONS,
) {
  if (server?.version !== LOCAL_PACKAGE_VERSION) {
    throw new Error(
      `Deployed MCP version ${String(server?.version)} does not match local package version ${LOCAL_PACKAGE_VERSION}. Deploy the current commit before accepting this smoke test.`,
    );
  }
  if (health?.version !== LOCAL_PACKAGE_VERSION) {
    throw new Error(
      `Deployed health version ${String(health?.version)} does not match local package version ${LOCAL_PACKAGE_VERSION}. Deploy the current commit before accepting this smoke test.`,
    );
  }
  if (server?.name !== expectations.serverName) {
    throw new Error(
      `Deployed MCP server name ${String(server?.name)} does not match canonical server name ${expectations.serverName}.`,
    );
  }
  if (health?.service !== expectations.serverName) {
    throw new Error(
      `Health service ${String(health?.service)} does not match canonical server name ${expectations.serverName}.`,
    );
  }
  if (health?.resultContractVersion !== expectations.resultContractVersion) {
    throw new Error(
      `Health resultContractVersion ${String(health?.resultContractVersion)} does not match ${expectations.resultContractVersion}.`,
    );
  }
  if (health?.status !== "ok" || health?.liveness !== "ok") {
    throw new Error(
      `Health liveness contract is invalid: ${JSON.stringify({ status: health?.status, liveness: health?.liveness })}.`,
    );
  }
  if (health?.applicationReadiness !== "ready") {
    throw new Error(
      `Health applicationReadiness must be ready, received ${String(health?.applicationReadiness)}.`,
    );
  }
  if (
    health?.readiness?.status !== "ready" ||
    health?.readiness?.upstreamChecks !== "not_run"
  ) {
    throw new Error(
      `Health readiness contract is invalid: ${JSON.stringify(health?.readiness)}.`,
    );
  }
  requireNonEmptyString(health?.readiness?.note, "Health readiness.note");
  if (
    health?.upstreamContracts?.status !== "not_checked" ||
    health?.upstreamContracts?.lastCheckedAt !== null
  ) {
    throw new Error(
      `Health upstreamContracts must explicitly be not_checked with lastCheckedAt=null: ${JSON.stringify(health?.upstreamContracts)}.`,
    );
  }
  if (!Array.isArray(tools)) {
    throw new Error("tools/list did not return an array of tools.");
  }

  const toolNames = tools.map((tool) => tool?.name);
  const difference = firstOrderedDifference(toolNames, expectations.toolNames);
  if (difference !== null) {
    throw new Error(
      `Deployed tools/list does not exactly match canonical PUBLIC_TOOL_NAMES: ${JSON.stringify({ difference, expected: expectations.toolNames, actual: toolNames })}`,
    );
  }
  if (
    !Number.isInteger(health?.toolCount) ||
    health.toolCount !== expectations.toolNames.length
  ) {
    throw new Error(
      `Deployed health toolCount ${String(health?.toolCount)} does not match canonical PUBLIC_TOOL_NAMES count ${expectations.toolNames.length}.`,
    );
  }

  const actualToolContractSha256 = canonicalToolContractSha256(tools);
  if (actualToolContractSha256 !== expectations.toolContractSha256) {
    throw new Error(
      `Deployed tools/list public contract SHA-256 mismatch: expected ${expectations.toolContractSha256}, actual ${actualToolContractSha256}.`,
    );
  }
  const actualInstructionsSha256 =
    serverInstructionsSha256(serverInstructions);
  if (actualInstructionsSha256 !== expectations.serverInstructionsSha256) {
    throw new Error(
      `Deployed server instructions SHA-256 mismatch: expected ${expectations.serverInstructionsSha256}, actual ${actualInstructionsSha256}.`,
    );
  }

  if (endpointPath !== expectations.endpointPath) {
    throw new Error(
      `Smoke target path ${String(endpointPath)} does not match canonical MCP endpoint ${expectations.endpointPath}.`,
    );
  }
  if (health?.mcpEndpoint !== expectations.endpointPath) {
    throw new Error(
      `Health MCP endpoint ${String(health?.mcpEndpoint)} does not match ${expectations.endpointPath}.`,
    );
  }
}

export function assertFindCompaniesFunctionalResult(result) {
  if (result?.isError === true) {
    throw new Error(
      `find_companies returned an MCP tool error: ${JSON.stringify(result.content)}`,
    );
  }
  const data = result?.structuredContent;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("find_companies did not return a structured object.");
  }
  if (data.ok !== true) {
    throw new Error(
      `find_companies structured result must have ok=true, received ${String(data.ok)}.`,
    );
  }
  if (data.meta?.contractVersion !== PUBLIC_RESULT_CONTRACT_VERSION) {
    throw new Error(
      `find_companies meta.contractVersion ${String(data.meta?.contractVersion)} does not match ${PUBLIC_RESULT_CONTRACT_VERSION}.`,
    );
  }
  if (!Array.isArray(data.companies) || data.companies.length === 0) {
    throw new Error(
      "find_companies must return a non-empty companies array for the 2330 functional probe.",
    );
  }
  for (const [index, company] of data.companies.entries()) {
    if (
      company === null ||
      typeof company !== "object" ||
      Array.isArray(company) ||
      typeof company.code !== "string" ||
      company.code.length === 0 ||
      typeof company.name !== "string" ||
      company.name.length === 0 ||
      typeof company.displayName !== "string" ||
      company.displayName.length === 0
    ) {
      throw new Error(
        `find_companies companies[${index}] does not satisfy the public company contract.`,
      );
    }
  }
  if (!data.companies.some((company) => company.code === "2330")) {
    throw new Error(
      "find_companies 2330 functional probe did not return company code 2330.",
    );
  }
  return data;
}

export function resolveSmokeTimeoutMs(
  rawValue = process.env.MOPSFIN_SMOKE_TIMEOUT_MS,
) {
  if (rawValue === undefined || rawValue === "") {
    return DEFAULT_SMOKE_TIMEOUT_MS;
  }
  const timeoutMs = Number(rawValue);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 300_000
  ) {
    throw new Error(
      "MOPSFIN_SMOKE_TIMEOUT_MS must be an integer from 1000 through 300000.",
    );
  }
  return timeoutMs;
}

/** Bound the entire connect/request/cleanup workflow with one absolute timer. */
export async function runWithOverallDeadline(label, timeoutMs, task) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label} exceeded its overall ${timeoutMs} ms deadline.`,
      );
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const context = {
    signal: controller.signal,
    remainingMs() {
      return Math.max(1, timeoutMs - (Date.now() - startedAt));
    },
    requestOptions() {
      const remaining = this.remainingMs();
      return {
        signal: controller.signal,
        timeout: remaining,
        maxTotalTimeout: remaining,
      };
    },
  };

  try {
    return await Promise.race([Promise.resolve().then(() => task(context)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
