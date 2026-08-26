import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readme = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

const verifiedExamplePrompts = [
  "查台積電最近 12 季營業收入，整理成表格並標示期別、單位與 warnings。",
  "查台積電 2025-01-01 到 2026-08-24 的原始日線 OHLC，若尚未完整請沿 nextCursor 繼續。",
  "列出 2026-08-24 全部上市與上櫃公司的原始日線 OHLC，標示實際資料日期與來源。",
  "查最新上市櫃公司估值，列出台積電與穩懋的本益比、股價淨值比、殖利率及 valueStatus。",
  "查最新上市櫃月營收，列出台積電與穩懋的 MoM、YoY、資料年月及 filingCoverage。",
  "列出全部上市公司代號，不要包含上櫃公司。",
  "列出全部上市與上櫃公司，排除金融業與 KY 公司。",
  "比較台積電和聯發科最近 8 季 ROE，標示期別、單位與 warnings。",
  "列出台積電 2025Q4 資產負債表的主要項目，標示單位與資料來源。",
  "比較半導體業最近 12 季營收趨勢，並說明單季／累計口徑與 warnings。",
  "查臺企銀最近可用的銀行業資本適足率；若最新期別為 null，往前找最近一個非 null，並標示期別、單位與 warnings。",
];

describe("README example prompts", () => {
  it("keeps every live-verified example prompt in the active README", () => {
    for (const prompt of verifiedExamplePrompts) {
      expect(readme).toContain(`「${prompt}」`);
    }
  });

  it("does not reintroduce examples with known upstream-data ambiguity", () => {
    expect(readme).not.toContain("查臺銀最近可用的銀行業資本適足率");
    expect(readme).not.toContain("列出最近完成交易日全部上市櫃公司的 OHLC");
  });

  it("documents the twelve-tool market-data contract and official sources", () => {
    expect(readme).toContain("十二個工具");
    expect(readme).toContain("`get_daily_market_valuation`");
    expect(readme).toContain("`get_monthly_revenue`");
    expect(readme).toContain("成交股數、成交金額、成交筆數與漲跌");
    expect(readme).toContain(
      "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
    );
    expect(readme).toContain(
      "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
    );
    expect(readme).toContain(
      "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    );
    expect(readme).toContain(
      "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
    );
    expect(readme).not.toContain("不提供盤中即時報價、成交量、成交金額");
  });
});
