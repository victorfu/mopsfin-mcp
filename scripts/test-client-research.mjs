import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LOCAL_PACKAGE_VERSION, runWithOverallDeadline } from "./test-client-contract.mjs";

// Explicit, low-cardinality live probe. No retries or financial value assertions.
const endpoint = new URL(process.argv[2] ?? "http://localhost:3000/api/mcp");
const reportPath = resolve(process.argv[3] ?? "docs/research/research-tools-live.json");
const sampleCodes = ["2330", "6488", "2881", "2886"];
const plannedCalls = [
  { label: "static_catalog", name: "list_catalog", arguments: { kind: "research_fields" } },
  ...[
    { market: "listed", company_codes: ["2330", "2881", "2886"] },
    { market: "otc", company_codes: ["6488"] },
    { market: "all", company_codes: sampleCodes },
  ].map((selection) => ({
    label: `screen_${selection.market}`, name: "screen_companies",
    arguments: { ...selection, filters: [{ field: "company.code", op: "in", value: selection.company_codes }], columns: ["company.market", "price.close", "valuation.pe", "revenue.yoy_pct"], output_mode: "full" },
  })),
  { label: "compare_common_quarter", name: "compare_companies", arguments: { company_codes: sampleCodes, columns: ["financial.Revenue", "financial.EPS", "financial.GrossMargin"], output_mode: "full" } },
  { label: "technicals_sma5_raw", name: "get_stock_technicals", arguments: { company_code: "2330", price_basis: "raw_unadjusted", indicators: ["sma"], sma_periods: [5] } },
];
const selectedLabels = process.argv[4]?.split(",");
if (selectedLabels?.some((label) => !plannedCalls.some((call) => call.label === label))) throw new Error("Unknown probe label.");
const calls = selectedLabels ? plannedCalls.filter((call) => selectedLabels.includes(call.label)) : plannedCalls;
const report = { startedAt: new Date().toISOString(), endpoint: endpoint.href, packageVersion: LOCAL_PACKAGE_VERSION, sampleCodes, requestedLabels: calls.map((call) => call.label), scope: "purposeful small sample; not whole-market coverage or point-in-time validation", calls: [] };
try {
  await runWithOverallDeadline("research tools live sample", 300_000, async (deadline) => {
    const client = new Client({ name: "mopsfin-research-live", version: LOCAL_PACKAGE_VERSION });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint), deadline.requestOptions());
      report.server = client.getServerVersion();
      for (const call of calls) {
        const started = performance.now();
        try {
          const result = await client.callTool({ name: call.name, arguments: call.arguments }, deadline.requestOptions());
          const data = result.structuredContent;
          const contractValid = result.isError !== true && data?.ok === true && data?.meta?.contractVersion === "mopsfin.result.v1";
          const entry = { ...call, elapsedMs: Math.round(performance.now() - started), contractValid, quality: data?.meta?.quality ?? null, resolved: data?.meta?.asOf?.resolved ?? null, sourceCount: data?.meta?.asOf?.sourceCutoffs?.length ?? 0, result };
          report.calls.push(entry);
          process.stdout.write(`${JSON.stringify({ label: call.label, elapsedMs: entry.elapsedMs, contractValid, quality: data?.meta?.quality?.status, sourceCount: entry.sourceCount, error: data?.error ?? null })}\n`);
          // These calls intentionally use different domains. A failed tool is recorded,
          // never retried or represented as verified no-data.
        } catch (error) {
          report.calls.push({ ...call, elapsedMs: Math.round(performance.now() - started), contractValid: false, transportError: String(error) });
          if (deadline.signal.aborted) break;
        }
      }
    } finally { await client.close(); }
  });
} catch (error) {
  report.failure = String(error);
} finally {
  report.finishedAt = new Date().toISOString();
  report.allToolContractsPassed = report.calls.length === calls.length && report.calls.every((call) => call.contractValid);
  // Successful partial output remains partial evidence, even if its MCP envelope is valid.
  report.allDataQualityComplete = report.allToolContractsPassed && report.calls.every((call) => call.quality?.status === "complete");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Evidence saved: ${reportPath}\n`);
  if (!report.allToolContractsPassed) process.exitCode = 1;
}
