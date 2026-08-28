import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "@/app/page";
import { RESULT_CONTRACT_VERSION as RESULT_CONTRACT_REEXPORT } from "@/lib/mcp/result-contract";
import { PUBLIC_TOOL_NAMES, TOOL_COUNT } from "@/lib/mcp/tool-manifest";
import {
  RESULT_CONTRACT_VERSION,
  SERVER_IDENTITY,
  SERVER_VERSION,
  UPSTREAM_HTTP_USER_AGENT,
} from "@/lib/server/identity";
import packageMetadata from "../package.json";

const runtimeSurfacePaths = [
  "../app/api/health/route.ts",
  "../app/api/mcp/route.ts",
  "../app/page.tsx",
  "../lib/mopsfin/guidance.ts",
  "../lib/catalyst/html-loader.ts",
  "../lib/market-data/client-utils.ts",
  "../lib/mopsfin/http.ts",
  "../lib/revenue/client.ts",
  "../scripts/test-client-contract.mjs",
  "../scripts/test-client.mjs",
] as const;

describe("canonical server identity", () => {
  it("derives runtime identity from package metadata without a second version literal", () => {
    expect(SERVER_VERSION).toBe(packageMetadata.version);
    expect(SERVER_VERSION).toBe("0.9.1");
    expect(SERVER_IDENTITY).toMatchObject({
      name: "mopsfin-taiwan-equities",
      version: packageMetadata.version,
      resultContractVersion: "mopsfin.result.v1",
      mcpEndpoint: "/api/mcp",
      publicMcpUrl: "https://mopsfin-mcp.vercel.app/api/mcp",
    });
    expect(Object.isFrozen(SERVER_IDENTITY)).toBe(true);
    expect(RESULT_CONTRACT_REEXPORT).toBe(RESULT_CONTRACT_VERSION);
    expect(UPSTREAM_HTTP_USER_AGENT).toBe(
      `${packageMetadata.name}/${packageMetadata.version} (+https://mopsfin.twse.com.tw/)`,
    );
  });

  it("derives the public count from the dependency-free ordered tool manifest", () => {
    expect(TOOL_COUNT).toBe(PUBLIC_TOOL_NAMES.length);
    expect(TOOL_COUNT).toBe(23);
    expect(new Set(PUBLIC_TOOL_NAMES).size).toBe(TOOL_COUNT);
    expect(PUBLIC_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "screen_taiwan_stock_candidates_with_catalyst_snapshots",
        "get_stock_price_series",
        "get_valuation_model_inputs",
        "run_reverse_dcf",
        "analyze_observed_price",
      ]),
    );
    expect(
      PUBLIC_TOOL_NAMES.indexOf(
        "screen_taiwan_stock_candidates_with_catalyst_snapshots",
      ),
    ).toBe(PUBLIC_TOOL_NAMES.indexOf("screen_taiwan_stock_candidates") + 1);
    expect(PUBLIC_TOOL_NAMES.indexOf("get_stock_price_series")).toBe(
      PUBLIC_TOOL_NAMES.indexOf("get_stock_ohlc") + 1,
    );
  });

  it("renders the homepage from the canonical version and tool manifest", () => {
    const html = renderToStaticMarkup(Home());

    expect(html).toContain(`V${SERVER_VERSION}`);
    expect(html).toContain(`v${SERVER_VERSION}`);
    expect(html).toContain(`${TOOL_COUNT} 個唯讀工具`);
    for (const toolName of PUBLIC_TOOL_NAMES) {
      expect(html).toContain(toolName);
    }
  });

  it("keeps runtime surfaces free of handwritten semantic versions", () => {
    for (const relativePath of runtimeSurfacePaths) {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8",
      );
      expect(source, relativePath).not.toMatch(/\b0\.\d+\.\d+\b/);
    }
  });
});
