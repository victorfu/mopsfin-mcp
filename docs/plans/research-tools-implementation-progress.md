# 研究工具 1–4 實作進度

2026-09-17：工作目錄 **0.12.0，24 個公開工具，四項驗收完成**。完整要求以 [原計畫](./research-tools-1-4.md) 為準；逐條實作與驗證證據見 [驗收紀錄](./research-tools-acceptance.md)。未 commit、push 或部署。

## 已完成

1. `screen_companies`：1–12 個明確條件、三態判定、先全體排序後分頁、內容綁定 cursor、批次來源成本上限。
2. `compare_companies`：1–20 公司、最多 8 財務指標，common_latest／company_latest／explicit、共同曆季窗、金融定義與單位核對。
3. 欄位 registry／目錄與既有工具 full／compact／summary：原呼叫相容、市場摘要涵蓋完整集合、財務摘要只限本頁；價格摘要保留 ledger／coverage／sources，以官方交易日驗證每日統計。
4. `get_stock_technicals`：SMA、固定 251 close Wilder RSI、年化樣本波動、突破、量比；完成日、暖機、缺值、公司行動及轉板限制。

三個 domain 均有 client、運算模組與 types.ts；正式 registry、schema barrel、manifest、instructions、README 與首頁同步。

## 驗證結果

- 全套 **651 tests passed / 34 opt-in live tests skipped**；57 test files passed / 8 skipped。
- `npm run lint`、`npm run type-check`、`npm run build` 通過。
- 最後 build 的本機 deployment contract 與 `find_companies` functional smoke 通過，0.12.0／24 工具及兩個 SHA-256 相符。
- 正式 MCP callTool 驗證新工具及所有模式，schema parse 不靜默丟 metadata；舊參數與 full payload 相同。
- 20×8 cells、20×8×12 財務點的 compact 與 250 根價格 summary 均達 JSON 至少减半，品質資訊仍保留。
- Actual price-series／公司行動 engine 驗證除息、配股、拆股、減資與缺少因子；非空 ledger 經 MCP summary 驗證。
- 原始紀錄位於 [validation 目錄](../research/research-tools-validation-2026-09-17/)。build 因沙箱 Node 子程序 stdout 空輸出的環境限制，使用已核准的沙箱外執行；未跳過任何 build 或型別檢查。

## Live 結果與限制

[首輪 evidence](../research/research-tools-live-2026-09-17.json) 依上市、上櫃、all 順序查 2330／6488／2881／2886：共同季財務成功（2026Q2），金融 Revenue→淨收益與毛利率不適用正確；2330 raw SMA5 可取得。當日上市估值 NO_DATA，上櫃於 52 秒 deadline 附近失敗，all 回 partial。這不證明全市場完整涵蓋或官方上櫃／all 當下可用。

首輪發現的 source cutoff 展開、技術 nested sources 與跨 dependency deadline 分類已修正並有回歸。[0.12.0 有界補驗](../research/research-tools-live-final-2026-09-17.json) 的四個呼叫皆成功回應合約；來源日期已核對，資料品質仍按真實限制標 partial。沒有重試先前逾時的上櫃／all，也沒有改寫首輪原始 evidence。本機驗證 server 已停止。
