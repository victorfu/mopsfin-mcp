import type { McpServer } from "@modelcontextprotocol/server";

import {
  PUBLIC_TOOL_NAMES,
  TOOL_COUNT,
  type McpToolName,
} from "./tool-manifest";
import { catalogTools } from "./tools/catalog";
import { catalystTools } from "./tools/catalyst";
import { companiesTools } from "./tools/companies";
import type { ToolDefinition } from "./tools/definition";
import { financialsTools } from "./tools/financials";
import { marketTools } from "./tools/market";
import { observedPriceTools } from "./tools/observed-price";
import { priceSeriesTools } from "./tools/price-series";
import { revenueTools } from "./tools/revenue";
import { researchTools } from "./tools/research";
import { reverseDcfTools } from "./tools/reverse-dcf";
import { screeningTools } from "./tools/screening";
import { valuationModelTools } from "./tools/valuation-model";

const definitions = [
  ...companiesTools,
  ...marketTools,
  ...priceSeriesTools,
  ...observedPriceTools,
  ...catalystTools,
  ...screeningTools,
  ...researchTools,
  ...valuationModelTools,
  ...reverseDcfTools,
  ...revenueTools,
  ...catalogTools,
  ...financialsTools,
] as const;

function buildCanonicalRegistry(): readonly ToolDefinition[] {
  const byName = new Map<McpToolName, ToolDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`Duplicate MCP tool definition: ${definition.name}`);
    }
    byName.set(definition.name, definition);
  }
  if (definitions.length !== TOOL_COUNT) {
    throw new Error(
      `MCP tool manifest defines ${TOOL_COUNT} tools, but registry has ${definitions.length}.`,
    );
  }
  return PUBLIC_TOOL_NAMES.map((name) => {
    const definition = byName.get(name);
    if (!definition) {
      throw new Error(`Missing MCP tool definition: ${name}`);
    }
    return definition;
  });
}

export const TOOL_REGISTRY = buildCanonicalRegistry();

export function registerToolRegistry(server: McpServer): void {
  for (const definition of TOOL_REGISTRY) {
    definition.register(server);
  }
}
