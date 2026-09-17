# 研究工具 1–4 驗收紀錄

範圍依 [原計畫](./research-tools-1-4.md)，不是依已完成項目縮減。版本 0.12.0，公開工具由 21 增至 24；本次只完成工作目錄實作，不含 commit、push 或部署。

## 功能與證據對照

| 原要求 | 實作／權威驗證來源 | 核對結果 |
|---|---|---|
| ① 目前上市／上櫃公司條件篩選 | `lib/screener/{client,engine,types}.ts`；`tests/screener-client.test.ts` | 非金融＋營收 YoY >20＋PE 10–25＋成交金額 >1 億，逐條 evidence 與隱藏篩選欄位皆核對；公開介面要求 1–12 個條件 |
| 三態、缺公司、null、來源失敗與 stale | `tests/research-engine.test.ts`、`screener-client.test.ts` | false 優先於 unknown，但 unknown 計數不丟棄；selected=matched+notMatched+undetermined；失敗不冒充零或確定不符合 |
| 排序、分頁與修訂 | 同上 | 完整集合先排序，null last，market/code tie-break；內容修改或 query 修改拒絕 cursor；僅取得時間變動不拒絕 |
| 篩選成本有界 | `screener-client.test.ts` 的 500 公司 fixture | 每 domain 一次 bulk orchestration，perCompanyMarketCalls=0；未使用 domain 零呼叫；不宣稱 logical call 等於 HTTP attempt |
| ② 1–20 公司、最多 8 財務欄位 | `lib/comparison/{client,alignment,types}.ts`、MCP input schema | caller 順序不變，最多 24 總欄位，財務只透過批次依賴取得；超限由 schema/domain 拒絕 |
| common_latest／company_latest／explicit | `tests/research-engine.test.ts`、`comparison-client.test.ts` | 共用最近 12 個已完成曆季；落後公司取交集；沒資料公司不移除；無交集／explicit 缺資料不 fallback |
| 金融定義與單位 | `lib/research/financials.ts`；comparison tests；四檔 live evidence | 金控 Revenue→淨收益、金融 GrossMargin=not_applicable；同單位不同定義不混合；仟元→TWD、元→TWD/share，目錄／批次單位矛盾時拒絕換算 |
| ③ 單一欄位 registry／欄位目錄 | `lib/research/{fields,types}.ts`；`research-mcp.test.ts` | 20 個固定欄位，kind=all 增動態財務欄位；固定目錄在上游故意失敗時可用；supportedTools 包含對應市場投影工具 |
| 市場 columns 與 full/compact/summary | `lib/research/market-projection.ts`；`research-mcp.test.ts` | 三工具皆經正式 MCP 呼叫與 lossless schema round-trip；summary 用未分頁集合，其餘投影用本頁；頁外缺值仍影响 summary quality |
| 舊工具相容性 | `research-mcp.test.ts`、既有 `mcp.integration.test.ts` | 不帶新參數與僅 full 的 payload 相同（只排除組裝時間比較）；正式舊模式回歸保留，不削弱 required rows/bars |
| 財務批次壓縮／摘要 | `lib/research/batch-projection.ts`、`tests/batch-projection.test.ts`、MCP tests | compact 原數值、optional status、coverage、failure 可完整還原；summary=current_page，保留 next cursor；不同單位／期別／未知業別定義隔離 |
| 價格摘要口徑與公式 | `lib/research/price-summary.ts`、`tests/price-summary.test.ts` | 完整 collected requested window；端點報酬、close drawdown、未年化 daily log sample SD(ddof=1)；獨立手算期望值；缺 session 只保留可計算端點報酬 |
| adjusted 缺值不回退、來源失敗透明 | price summary tests、MCP tests | selected basis 不混用；benchmark failure 不當 no-data；錯誤與額外工作量保留；meta source/value 降級 |
| 來源、日期、品質與非空 ledger | `research-mcp.test.ts`、`mcp.integration.test.ts` 的 adjusted summary case；final live | summary 保留原 coverage、eventLedger、sources、warnings；非空 ledger 實際 MCP 驗證；市場日／月份 cutoffs、技術 nested sources 已驗證 |
| JSON 輸出至少減半 | `research-engine.test.ts`、`batch-projection.test.ts`、`research-mcp.test.ts` | 20×8 cells、20×8×12 財務點 compact，以及 250 bars 完整公開 summary payload 均小於 full 的 50%；沒有刪除品質契約湊數 |
| ④ 日線技術工具與型別 | `lib/technicals/{client,calculations,types}.ts` | SMA、RSI14、volatility20/60、breakout20/60、volume ratio20 已註冊，可由 MCP 呼叫 |
| RSI／波動／突破／量比獨立公式 | `tests/technicals-calculations.test.ts` | RSI 固定 251 closes，Wilder seed 與平盤50／單邊100、0；sample log SD×sqrt(252)；突破與量比分母排除今日，嚴格 >，零分母不可用 |
| as-of、暖機、停牌、企業行動 | `technicals-client.test.ts`、`price-series.test.ts` | 固定完成日、缺末根不回退、18 月暖機上限；actual price adjustment engine 驗證現金除息、配股、面額拆股、減資、未知因子；跨市場 raw 視窗拒用單一日曆驗證 |
| deadline／取消 | screener/comparison/technical client tests、research MCP tests | 已取消／已逾時不開始來源工作，末端 dependency 完成後也檢查；跨依賴錯誤保留 UPSTREAM_TIMEOUT 與穩定 reason |
| 正式 MCP 契約 | `tool-registry`、`schema-modules`、`mcp.integration`、`research-mcp` tests | 24 工具、annotations、巢狀 descriptions、所有 variants 與 schema 不丟 metadata 已驗證；hash 與 instructions 同步 |
| 文件、首頁與 artifact 結構 | README、app/page.tsx、三個新工具的 types.ts、公開 manifest | 功能、限制、輸出模式、工具數與版本同步；不提供 intraday、point-in-time vintage、total return 或買賣評級 |

## 最終 gates

原始 stdout 紀錄保存在 [validation 目錄](../research/research-tools-validation-2026-09-17/)。以下皆為最後型別檔案整理後的完整重跑結果；各命令 exit 0。

- `npm run lint`：通過。
- `npm run type-check`：通過。
- `npm test`：57 files / 651 tests passed；8 個 opt-in live files / 34 tests skipped。官方 live 小樣本另外執行並保存下方證據，不把 skipped 計為通過。
- `npm run build`：通過（含 TypeScript、頁面資料與静態頁產生）。
- 本機 deployment contract 與 functional smoke：通過；server 0.12.0、24 工具，find_companies 回 2330。
- tools/list SHA-256：`1611bc2dc7eb479fc455733a76391d76bc309ee78bf4aae46b721b1c064955c3`。
- instructions SHA-256：`78e1f0d4be5adf6fe1860dd9df24248c2e59825b3aa6e31424edb06ade88d81f`。

build 使用已核准的沙箱外執行：沙箱內最小 Node 子程序連 console.log 都回空 stdout，導致 Next.js 無法 parse tsc --showConfig；直接 TypeScript 與沙箱外完整 build 正常。沒有跳過 TypeScript，也未降低測試或 build 要求。

## 官方 live 小樣本：部分成功，不能稱為全市場完整驗證

[首輪完整原始證據](../research/research-tools-live-2026-09-17.json) 依上市、上櫃、all 的順序執行；再查 2330／6488／2881／2886 共同季與 2330 SMA5。資料取得日為 2026-09-17，目的性四檔樣本不代表台股涵蓋率。

| 呼叫 | 首輪 latency | 已取得／未驗證 |
|---|---:|---|
| 上市篩選 | 1,758 ms | 3 家行情與月營收成功；2026-09-17 TWSE 估值為 NO_DATA，相關 cell 保留 source_unavailable |
| 上櫃篩選 | 52,007 ms | 在 52 秒總 deadline 附近失敗（首輪被包裝成一般上游錯誤）；無法證明 6488 的價量／估值／營收組合可用，不能解釋為沒有公司或資料 |
| all 篩選 | 50,043 ms | 共同完成交易日未解析，TPEx 月營收逾時；回 partial，保留各 domain failure |
| 四檔財務比較 | 1,271 ms | 共同季 2026Q2，Revenue/EPS 成功，金融毛利率 not_applicable；latest filing freshness 不具充分依據，仍為 unknown |
| 2330 raw SMA5 | 377 ms | exact 2026-09-17，5 sessions，SMA=2396 TWD；這是當次證據，不作永久固定 assertion |

首輪找出的來源 cutoff 展開與 deadline 分類問題已修正並補回歸；原始 evidence 保留當時結果，不改寫成修正後成功。

[0.12.0 有界補驗](../research/research-tools-live-final-2026-09-17.json) 只重查靜態目錄、上市篩選、共同季比較與 SMA5，未重試先前逾時的上櫃／all。四個呼叫成功回應合約；上市估值仍無資料，整體資料品質仍 partial。上市 metadata 現已分別保留 master=2026-09-16、price=2026-09-17、revenue=2026-08；技術 metadata 含 master、benchmark、STOCK_DAY 與年度日曆，共 6 筆 cutoff 證據。

這些限制依原計畫「live 上游失敗如實記錄」處理，不以 mock passing 冒充 live 完整通過；也不以大量重試或偷偷縮減原查詢範圍換取成功。未驗證項目是官方上櫃／all 的即時組合可用性，而非將四項功能從交付範圍刪除。

## 完成判定

四項公開能力、型別與 schema、相容性、公式／成本／品質／企業行動回歸、文件與版本、完整 gates、本機 contract／functional smoke、有限官方 live 及失敗證據均已交付。原計畫沒有要求官方服務當下必須完整可用，也沒有要求部署；外部可用性的未驗證範圍已明示保留。驗收完成，未 commit、push 或部署。本機驗證 server 已停止。

最後程式、測試、README、設定與 package 檔案的 SHA-256 清單見 [validated-source-manifest.json](../research/research-tools-validation-2026-09-17/validated-source-manifest.json)。它不包含會隨驗收書寫而改動的 docs 與 .next 產物。
