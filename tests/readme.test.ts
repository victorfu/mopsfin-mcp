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
});
