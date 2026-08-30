import { taiwanMarketFullUniverseClient } from "@/lib/full-screening/client";
import {
  screenTaiwanMarketUniversePageInputSchema,
  screenTaiwanMarketUniversePageOutputSchema,
} from "@/lib/mcp/schema/full-screening";

import { defineTool } from "./definition";
import {
  FRESHNESS_POLICIES,
  annotations,
  evaluateFreshness,
  success,
} from "./shared";

export const screenTaiwanMarketUniversePageTool = defineTool(
  "screen_taiwan_market_universe_page",
  {
    title: "逐頁完整評估目前上市櫃公司母體",
    description:
      "以 full_universe_cursor_v1 建立 current listed/OTC company identity manifest，並用 stateless query/snapshot-bound cursor 每頁處理最多 5 家，依 isFinancial 路由到原封不動的 taiwan_stock_screen.v2 或 taiwan_financial_screen.v1。每頁把 candidate_limit 設為該 segment 本頁公司數，因此不再用全母體 top-10 deep／top-5 reaction 作總量截斷；每家公司必須恰好落入 candidates、notReactionScored 或 excluded，否則整頁 INCOMPLETE_COVERAGE 且不前進 cursor。shared dependency failure、reaction prefix 未完成或 page_size<=5 仍出現 notDeepScored 時同樣 fail page，caller 應重試相同 cursor。manifestSnapshot 只 pin current company identity、query、master report dates 與 counts；STATELESS_PAGE_VALUES_NOT_PINNED，pageValuesPinned=false、pointInTime=false，尚未讀頁的財務、營收、估值、公司行動與 OHLC 不在 snapshot scope。任何 manifest 改變回 SNAPSHOT_CHANGED／restart_pagination。candidate rank 固定 rankScope=page_segment_only，收齊全部頁前沒有 global rank 或 server-side 全市場 shortlist。公司 master 仍是 heuristic coverage；這不是投資建議或可回放的 point-in-time 回測。",
    inputSchema: screenTaiwanMarketUniversePageInputSchema,
    outputSchema: screenTaiwanMarketUniversePageOutputSchema,
    annotations,
  },
  async ({ market, include_ky, page_size, cursor, preset }) => {
    const data = await taiwanMarketFullUniverseClient.screenTaiwanMarketUniversePage({
      market,
      includeKy: include_ky,
      pageSize: page_size,
      ...(cursor ? { cursor } : {}),
      preset,
    });
    const sources = [
      ...(data.segments.nonFinancial?.sources ?? []),
      ...(data.segments.financial?.sources ?? []),
    ];
    return success(
      `Full-universe manifest 本頁完成 ${data.page.companyCodes.length} 家（index ${data.page.startIndex}–${data.page.endIndexExclusive}）；terminal reconciliation 完整，${data.page.hasMore ? "仍有下一頁" : "已到 manifest 結尾"}。`,
      data,
      {
        selector: "latest",
        resolved: { granularity: "mixed", from: null, through: null },
        page: data.page.meta,
        snapshotId: data.manifest.snapshotId,
        source: data.coverage.pageSourceComplete ? "complete" : "partial",
        universe: "unverified",
        selection: "complete",
        values: data.coverage.pageSourceComplete ? "complete" : "partial",
        freshnessDetails: [
          evaluateFreshness({
            policy: FRESHNESS_POLICIES.unspecified,
            observedAsOf: null,
            expectedAsOf: null,
            sourceUrls: sources.map((source) => source.sourceUrl),
          }),
        ],
        issues: [
          {
            code: "MASTER_ROWSET_HEURISTIC",
            severity: "warning",
            scope: "universe",
            message:
              "current company manifest 通過 heuristic gate，但官方沒有 declared row count，不能證明絕對完整 rowset。",
            refs: {
              companyCodes: data.page.companyCodes,
              fields: ["manifest.coverageVerification", "manifest.companyCount"],
              periods: data.manifest.masterReportDates,
              sourceUrls: sources
                .filter((source) => source.kind === "company_master")
                .map((source) => source.sourceUrl),
            },
          },
          {
            code: "STATELESS_PAGE_VALUES_NOT_PINNED",
            severity: "warning",
            scope: "page",
            message:
              "cursor 只 pin manifest company identity；未讀頁逐公司財務、估值、營收、公司行動與 OHLC 未 materialize，跨頁可能更新。",
            refs: {
              companyCodes: data.page.companyCodes,
              fields: [
                "executionDefinition.snapshotScope",
                "coverage.pageValuesPinned",
                "coverage.pointInTime",
              ],
              periods: [],
              sourceUrls: sources.map((source) => source.sourceUrl),
            },
          },
          {
            code: "GLOBAL_RANK_UNAVAILABLE",
            severity: "info",
            scope: "selection",
            message:
              "candidate ranks 只屬本頁 segment；收齊所有頁前沒有 global rank 或全市場 shortlist。",
            refs: {
              companyCodes: data.terminalResults
                .filter((result) => result.route === "candidate")
                .map((result) => result.companyCode),
              fields: [
                "executionDefinition.globalRankAvailable",
                "terminalResults[].rankScope",
              ],
              periods: [],
              sourceUrls: [],
            },
          },
          {
            code: "FULL_UNIVERSE_PAGE_TERMINAL_RECONCILED",
            severity: "info",
            scope: "selection",
            message:
              "本頁每個 manifest company code 已恰好落入一個 terminal route；page failure 不會發出下一頁 cursor。",
            refs: {
              companyCodes: data.page.companyCodes,
              fields: [
                "coverage.pageTerminalReconciliationComplete",
                "terminalResults",
                "page.nextCursor",
              ],
              periods: [],
              sourceUrls: [],
            },
          },
        ],
      },
    );
  },
);

export const fullScreeningTools = [screenTaiwanMarketUniversePageTool] as const;
