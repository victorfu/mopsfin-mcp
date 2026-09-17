# mopsfin 研究工具 1～4：實作規格與交付計畫

日期：2026-09-17。設計基準：工作目錄 v0.11.0，21 個公開工具。

實作狀態：四項已於工作目錄 v0.12.0 完成驗收，尚未部署。逐條證據、命令紀錄與 live 限制見 [驗收紀錄](./research-tools-acceptance.md)。下文保留原設計範圍。

本文件是實作計畫，所有新介面、限制與預設均為設計決策，尚未代表已上線功能。涵蓋：①台股條件篩選、②公司比較表、③欄位選擇與摘要模式、④日線技術指標。四項均列入交付與驗收，不以完成第一項視為整體完成。

## 目標與邊界

- 延用公開、唯讀、無資料庫、固定官方來源的架構。
- 新增 `screen_companies`、`compare_companies`、`get_stock_technicals`；擴充既有工具的輸出模式與 `list_catalog`。完成後預計共 24 個工具。
- 先處理目前台股研究，不宣稱歷史 point-in-time 選股、歷史公司母體、即時行情、total return 或投資評級。
- 篩選第一版使用公司母體、全市場日行情／估值與單月營收；多月營收加速、全市場季度指標及全市場技術條件屬後续能力，不混入第一版的呼叫成本。
- 比較第一版支援 1–20 家目前上市櫃公司、最多 8 個季度指標及 24 個總欄位；不默默只回前幾家。
- 技術指標第一版每次單一目前上市櫃公司、日線、最新完成交易日或指定過去交易日；沒有盤中、週／月線或全市場技術掃描。
- 1～4 不依賴 TradingView API，也不加入資料庫、OAuth、帳戶、自選清單或背景警示排程。

## 已確認的程式基礎

| 現有位置 | 可重用能力／限制 |
|---|---|
| `lib/company-master/client.ts`、`types.ts` | 市場、產業、金融／KY 分類；完整性為 heuristic，不能升級宣稱官方完整母體 |
| `lib/price/client.ts` | 單日全市場 OHLC、跨月個股原始日線、exact current-company close |
| `lib/valuation/client.ts`、`types.ts` | 全市場 PE／PB／殖利率、缺值狀態、日期與來源口徑 |
| `lib/revenue/client.ts`、`types.ts` | 月營收以 TWD 回傳、申報覆蓋與 missing rows；月份與價格日期不同 |
| `lib/mopsfin/batch.ts` | 公司×指標批次、每個 comparison request 最多 10 公司；整批 comparison＋錯誤隔離最多 24 units |
| `lib/mopsfin/guidance.ts` | 季度／累計、指標公式、金融業適用性與 Revenue→淨收益的跨業別對應 |
| `lib/price-series/client.ts` | raw 與公司行動調整序列、最多 36 個月、event ledger、證據不足不回退 raw |
| `lib/reaction/calculations.ts` | exact session windows、流動性、回撤；不應為單算 RSI 執行完整 ReactionClient |
| `lib/reaction/benchmark-client.ts` | 官方 benchmark 實際交易日，可驗證缺 bar／停牌，不以平日推算交易日 |
| `lib/freshness/completed-session-resolver.ts` | 官方完成交易日與 Asia/Taipei 13:33 guard |
| `lib/mcp/result-contract.ts`、`cursor.ts` | meta、source cutoffs、freshness、query/snapshot-bound cursor |
| `lib/upstream/reliability.ts` | 有界併發、快取與 request deadline 傳遞 |
| `app/api/mcp/route.ts` | 52 秒共享 request deadline、60 秒 function duration |

現有 batch 的預設是每家公司自己的最近 12 個有效期別，可能落在不同年代；新的比較工具不能直接取各陣列最後一點就聲稱共同季度。現有價格序列 range 查詢也不自動等於完成交易日，技術工具需先解析 as-of。

## 共用設計：欄位、數值與來源

新增 `lib/research/fields.ts`，作為篩選、比較、投影與目錄的唯一欄位 registry。

每個欄位定義 `id`、中文名稱、資料型別、單位、domain、frequency、basis、definitionId、來源依賴、適用業別、可用工具、可否 filter/sort、成本類型、原始值到標準值的轉換。

第一版固定欄位使用 namespace：

- `company.code/name/market/industry_code/is_financial/is_ky`
- `price.open/high/low/close/volume_shares/turnover_twd`
- `valuation.pe/pb/dividend_yield_pct`
- `revenue.month_amount_twd/mom_pct/yoy_pct/cumulative_amount_twd/cumulative_yoy_pct`
- 比較工具另接受 `financial.Revenue/EPS/ROE/GrossMargin/...`，僅限動態 catalog `family=data` 存在且 applicability adapter 可解讀的指標；無法確認適用性則回 unknown，不能猜。

財務 amount 從仟元轉 TWD 必須有 unit 依據；EPS 維持 TWD/share，比率使用百分點尺度的 `%`，倍數不轉百分比。保留 sourceUnit、sourceValue、normalizationFactor；未知單位不做倍數猜測。

新表格的每個 cell 至少提供：`value`、`status`、`unit`、`period`、`basis`、`definitionId`、`sourceRefs`。status 區分 `available / missing / not_applicable / invalid_upstream / source_unavailable / period_unaligned / freshness_unverified`；freshness 另列，不必為 stale 刪除已讀到的原始數字，但不能自動把它當可用的 latest 篩選值。

sourceRefs 指向回應內去重的來源表，來源表包含 URL、source cutoff、retrievedAt、cache provenance。共同 unit 不等於共同 definition；金融 Revenue 要明示對應「淨收益」，金融／非金融混合欄位標 `definition_mismatch`，不能做一個未標示的共同排名。

金額、價格、月營收與季財務各保留自己的日期；總體 meta 不把不同頻率強塞成同一天。

## ① screen_companies

### 輸入

| 參數 | 決策 |
|---|---|
| `market` | `all/listed/otc`，預設 all |
| `include_financial/include_ky` | 沿用公司母體工具，預設皆 true；不暗中排除 |
| `industry_codes` | 可選，必須由 catalog 取得 |
| `company_codes` | 可選、最多 500 家；省略使用 accepted current master |
| `as_of` | 第一版固定 latest；解析一次官方完成交易日 |
| `revenue_month` | latest 或明確 YYYY-MM，不宣稱這些資料在 as_of 當日已公開 |
| `filters` | 最多 12 個 AND 條件；數值 gt/gte/lt/lte/between，分類 eq/in；型別與可用 operator 由 registry 驗證 |
| `columns` | 最多 24 個已註冊欄位；固定保留公司 identity |
| `sort` | 最多 3 個欄位，asc/desc；末尾固定 market＋code tie-break |
| `page_size/cursor` | 預設 50、上限 100；不可先截斷資料再篩選或排序 |
| `output_mode` | full/compact/summary，預設 compact（新工具） |

不接受 SQL、任意函式、任意來源 URL、未註冊欄位。至少一個條件；不另加藏有條件的預設。具名 preset 如未來新增，必須回傳展開後的 filters，與 caller 條件衝突時報錯。

### 執行與三態判定

1. 驗證並正規化所有參數、計算依賴計畫；沒有用到的 domain 不載入。
2. 取得 current master，套用明確的市場／產業／金融／KY／公司 selection。
3. 僅在價格／估值需要時解析 completed session；兩者採同一 exact 日期，不分別任意取 latest；market=all 若必要市場無法對齊，不能產出貌似完整的排名。
4. 載入每個必要市場的全市場來源；價量與估值同日，營收單独揭露 resolved month。latest 營收兩市場若月份不同，回來源期別不一致，要求 caller 指定共同月份。
5. 按 `(market, companyCode)` join；不能因其中一個來源缺公司就 inner join 靜默刪除。
6. 每條件為 true/false/unknown。AND 的任一確定 false 可判不符合；沒有 false 且至少一個 unknown 為未能判定。缺值、N/A、來源失敗不能當成零。`gt 20` 不包含 20。
7. 只對能確定符合者排序，null 排最後；排序欄位缺值即標 rankIncomplete，不能宣稱完整數值名次。先完成全體評估及排序，再分頁。

預設只在 match 陣列回傳確定符合者，但回傳 `unresolvedCompanies`（同樣有有界分頁或摘要計數）、原因與各條件狀態。已確定不符合但其他欄位未知的公司仍納入 `companiesWithUnknownCells` 計數，不隱藏資料品質。

### 輸出與一致性

- `universe`：master source、heuristic coverage、eligibleCount、selectedCount。
- `counts`：matched、notMatched、undetermined，三者合計 selectedCount；另列 source missing／unknown cell counts。
- `matches[]`：identity、requested cells、所有條件的實際值及判定依據（即使條件欄位未放入 columns）。
- `sourceFailures[]`、`freshness`、`resolvedDates`、`workBudget`、`meta.page`。
- `resultCompleteness` 與 ranking completeness 分開，來源失敗不能說「全市場只有這些公司」。
- cursor 綁參數、欄位定義版本、master 内容，以及所有篩選／排序／輸出用到的完整來源 rowset fingerprint；忽略 retrievedAt/cache age 等非內容資訊。任一來源內容變動則拒絕續頁並要求重查。
- 無資料庫意味著續頁重新查詢；不能保證能取回上一份來源快照，但必須偵測改變。

效能契約：全市場模式不可呼叫逐公司財報／OHLC；加入第 2,000 家公司不應使網路呼叫線性成長。完整成本需包含 master、resolver、來源補強及 retries，不把「三個 domain」誤寫成「只有三次 HTTP」。

## ② compare_companies

### 輸入與期間政策

- `company_codes`：1–20 家目前上市櫃公司，重複／空清單報錯；第一版不分公司頁，避免共同季度在不同頁不同。
- `columns`：最多 24；季度財務最多 8 項，沿用 batch 的每 10 公司×1 指標單位，最重主計畫為 16 comparison units，總含隔離仍遵守既有 24-unit cap。
- `financial_period_policy`：`common_latest / company_latest / explicit`，預設 common_latest。
- `financial_period`：explicit 時必填 YYYYQn，其他模式不得傳。
- `financial_basis`：第一版固定 quarterly；清楚標示原站早期不同申報頻率警示，不自動合成 TTM。
- `market_date`：latest 或明確完成的過去交易日；不是整份比較的歷史 as-of。
- `revenue_month`：latest 或 YYYY-MM；兩市場 latest 月份不齊則要求明確月份。
- `output_mode`：預設 compact，可 full/summary。

common_latest 的精確定義：固定 request 時間，以上一個完成曆季為上界，搜尋最近 12 個曆季；計算所有 requested companies × applicable financial metrics 的 reported period 交集，取最大期別。not_applicable cell 不約束交集；missing、invalid、來源失敗不能藉刪除公司解除約束。沒有交集時回 `no_common_period`、null 選定季、各公司最新可用期別與原因，不自動切換成各自 latest。

company_latest：各公司在其 requested applicable metrics 的同一 12 曆季窗内求交集，選出該公司的一個共同季；若無交集／來源失败，該公司標 period_unaligned，保留取得的可用期別資訊，不把不同季度值填進同一季度。explicit 不回退。

如果没有要求 financial 欄位，拒絕明確傳入的 financial period 參數或按 schema 組合約束處理，不能無效接收；預設不觸發財務查詢。

### 輸出

- `columns[]`：field definition、normalized unit、basis、適用性與比較狀態。
- `companies[]`：identity、每格 value/status/period/sourceRefs、公司的 selected fiscal period。
- `alignment`：requested policy、搜尋期間、resolved common period、各公司 latest available、definition／period 不一致。
- `failures`：以 domain/company/field 歸因，成功欄位不被其他來源錯誤抹除。
- 第一版維持 caller 公司順序，不加混合期別的排名、買賣分數或金融／非金融共同營收倍數比較。
- 可提供 min/max/median 的摘要，但只對同 definition、unit、basis、period 的 available cells 計算；無法比較時分組列出或 null，不硬算平均。

只載入要求欄位的 domain。依賴直接呼叫 domain client，不繞 HTTP 呼叫自己的 MCP，不額外查單家公司財報來取已有 market snapshot 的欄位。

## ③ 欄位選擇、摘要與目錄

### 公開範圍

| 工具 | 新能力 |
|---|---|
| 新 screen／compare | columns＋full/compact/summary |
| `get_daily_market_ohlc` | 可選 columns；compact projected table 與 summary |
| `get_daily_market_valuation` | 可選 columns；compact projected table 與 summary |
| `get_monthly_revenue` | 可選 columns；compact projected table 與 summary |
| `get_company_metrics_batch` | 原本 metric_codes 已是指標選擇；增加 compact/summary，避免再造第二個衝突 selector |
| `get_stock_price_series` | 增加 output_mode=full/summary；摘要涵蓋完整已收齊 requested window |
| `list_catalog` | 增加 kind=research_fields，並在 all 回 researchFields 與定義版本 |

既有工具不傳新增參數時，保留目前完整 payload、欄位、分頁及呼叫行為。不得為了減少 token 改掉原本的 required rows/bars 語意。明確選 compact/summary 才走新的可辨識 output variant；schema 為舊 full object 與新 presentation object 的明示分支，舊分支沒有被迫新增 required 欄位。實作初期先驗證 MCP SDK outputSchema 與既有 description traversal 支援該結構，必要時用 top-level object＋nested discriminated payload，而不能假裝省略 bars 是「0 根」。

compact 輸出欄位表與 cells/value/status/source refs，避免重複冗長定義；不可把 metadata 全部去掉。

summary：

- 行情／估值／月營收：對 selected rowset（未分頁前）統計筆數、缺值率及可比較數值的 min/max/median；不聚合語意不一致的金融／非金融營收。
- 財務 batch：仍受既有公司分頁限制，明示 `summaryScope=current_page`、evaluatedCompanies、nextCursor；不得稱為全體 requested companies 的統計。
- 價格序列：first/last date、有效 bars 數、端點報酬、close-based 最大回撤、日對數報酬樣本標準差（不年化）、單位與價格基礎。每日波動依官方 session grid 驗證，不把停牌多日報酬當單日；不足資料則 null＋原因。
- 價格 summary 的 display basis 就是明確 price_basis；adjusted 證據不足不能以 raw 計算同一欄位。若提供 raw 對照，必須另命名。
- 所有摘要固定保留 query、asOf、source cutoffs、coverage、quality、warnings、scope、pagination、省略明細宣告。include_event_ledger=true 時仍提供 ledger。
- 摘要只保證減少輸出，不宣稱降低上游成本；欄位依賴裁剪才可降低呼叫量。

`list_catalog(kind=research_fields)` 可只讀靜態研究欄位 registry，不依賴動態 Mopsfin 網頁成功；financial 動態 metric 仍以既有 metrics 目錄為準，兩者以明確的 field mapping 連接。query 可搜欄位、domain、單位及名稱，回傳 supportedOperators、sortable、supportedTools、costClass、definitionVersion。

## ④ get_stock_technicals

獨立新工具可只計算需求，不改動既有 reaction signals 的預設輸出或計算意義。共用純函式與價格依賴，不複製 corporate-action engine。

### 輸入

- `company_code`：一家公司。
- `as_of`：latest 或 exact YYYY-MM-DD；指定非交易日不回退。
- `price_basis`：raw_unadjusted 或 price_index_compatible_corporate_action_adjusted，預設後者；回應總是明示。
- `indicators`：SMA、RSI、historical_volatility、breakout、volume_ratio 的子集；預設全部。
- `sma_periods`：5/10/20/60/120/200 的子集，預設 20/60/200；RSI 固定 14；volatility 固定 20/60；breakout 固定 20/60；volume ratio 固定當日／前 20 交易日。
- 不提供模糊買賣評級。first version 回 as-of snapshot，不額外生成所有歷史指標序列。

### 精確公式與邊界

| 指標 | 公式／資料需求 |
|---|---|
| SMA(N) | 含 as-of 的 N 個連續官方 market sessions 收盤平均；價差百分比另回 `(close/SMA-1)*100` |
| RSI14 | Wilder 平滑；固定使用截至 as-of 最近 251 個 session closes（250 個變動），前 14 個 gain/loss 平均初始化，後續 `(previous*13+current)/14`；回 seed date、計算樣本數與公式版本 |
| RSI 特例 | avgLoss=0 且 avgGain>0 →100；avgGain=0 且 avgLoss>0 →0；兩者皆0 →50；不足固定暖機資料 →null，不能悄悄改 seed |
| 年化歷史波動率 N | N 個日對數報酬的樣本標準差（ddof=1）×sqrt(252)×100；需要 N+1 根連續正數 close；252 是公開假設，非實際年度交易日數 |
| 突破 N | 今日 close 與前 N 個 sessions 的 high 最大值比較，基準窗排除今日；嚴格 `>` 才 true，等於為 false；回 referenceHigh、distancePct |
| 量比 | 今日 raw volume ÷ 前 20 sessions raw volume 平均；排除今日於分母；分母0則 null；不得用本日成交金額代替成交量 |

fixed RSI seed 是重現性選擇，不保證與 TradingView 的暖機歷史或演算法輸出逐位相同。短歷史公司可能有 SMA20、但 RSI 尚為 insufficient_history；逐指標隔離，不能把全部指標一起抹除。

### 取得資料與品質

1. 固定 evaluatedAt，解析公司 identity 與官方 completed-session；latest 的 selected stock bar 必須等於 resolver date。
2. 重用 benchmark client 的實際 session dates 作完整性檢查，不以股票有交易的最後 N 根略過停牌。
3. 根據所選指標計算最少歷史需求；自近月至遠月有界擴充到足够 session，最多 18 個日曆月份。未要求 RSI 就不強制 251 根。
4. 以實際需要的起始 session 至 as-of 呼叫 stockPriceSeriesClient；暖機範圍內的公司行動也需要驗證。
5. 缺 bar、null、非正 close 或未知 adjustment 只使依赖該窗口的指標 unavailable；不補週末、不 forward-fill、不回退 raw。分別揭露 expected/observed sessions。
6. 量比跨股數變動事件且 volume 維持 raw shares 時，標 not_comparable_corporate_action；如 caller 選 raw 且沒有查事件證據，量比可回機械值但 comparability=unverified，不能稱已驗證可比。
7. cash-only 股利仍保留價格效果；這些技術數字不是含息報酬。轉板、名稱或 identity 不明時遵守既有調整 engine 限制。
8. 工作量分開列 benchmark months、stock months、resolver、公司行動 range/detail loads，沿用 52 秒 deadline；超過限制在可知時先拒絕，不靠多次重試延長時限。

輸出每項 indicator 的 value、status、reason、unit、window、priceBasis、calculationVersion、warmup，以及共用 source refs、coverage 與 as-of evidence。顯示時可四捨五入，遞迴計算內部不逐步四捨五入。

## 實作順序與檔案拆分

| 階段 | 產物 | 前置 | 完成證據 |
|---|---|---|---|
| A 共用契約 | `lib/research/{fields,types,projection,statistics}.ts`；研究目錄 schema | 無 | 欄位識別、單位、未知欄位、投影／統計語意測試 |
| B 篩選 | `lib/screener/{client,engine,types}.ts`；MCP schema/tools | A | 三態、整體排序後分頁、來源變更 cursor、成本非逐股 |
| C 比較 | `lib/comparison/{client,alignment,types}.ts`；MCP schema/tools | A | 共同季度／公司季度／explicit、金融定義、部分失敗 |
| D 輸出模式 | 修改三個市場工具、financial batch、price series、catalog | A，價格統計共用 E 純函式 | 舊呼叫不變、新模式 schema/metadata、輸出量下降 |
| E 技術指標 | `lib/technicals/{client,calculations,types}.ts`；MCP schema/tools | A；重用 completed-session／price-series | 已知序列、企業行動、缺 bar、暖機與日期測試 |
| F 契約與交付 | manifest、guidance、README、首頁、smoke、整合測試 | B～E | 下列所有驗收條件通過 |

順序 A → B → C → E → D → F。E 的純函式可先於 E orchestration 完成，供 D 價格摘要使用。這是同一開發工作的可審查切分，不代表只有部分項目需要完成。

schema 依現有結構置於 `lib/mcp/schema/`，工具置於 `lib/mcp/tools/`；新增 registry import 及 `lib/mcp/schemas.ts` export。共用模組不 import MCP wrapper，避免循環依賴。新增工具正式登錄前先完成 domain tests。

`PUBLIC_TOOL_NAMES`、TOOL_COUNT、tools/list SHA-256、server instructions SHA-256 必須一起更新。版本由 package.json 單一來源在功能完整時升為 0.12.0；新版本計畫不代表現在就修改版本。相容性回歸核對旧调用的 payload 与错误语义，不能只更新 hash 讓測試變綠。

## 驗收清單

### 功能與語意

- [x] 篩選：非金融＋營收 YoY >20＋PE 10–25＋成交金額 >1 億可回逐條 evidence，數值邊界正確。
- [x] 未回傳公司、null、N/A、source failure 與 stale 分別記錄；三態計數加總正確，無 false negatives 冒充完整結果。
- [x] 全體先篩選排序再分頁；同值排序穩定、來源修正或篩選條件改變會拒絕舊 cursor。
- [x] 比較：某公司最新季度落後時，common_latest 正確取交集；完全沒資料的公司不能被偷偷排除。
- [x] 比較：12 季是共同曆季窗，不是每家公司任意年代的12個報告；無共同期別不 fallback。
- [x] 金融不適用指標保持 not_applicable；Revenue→淨收益有 definitionId，不把相同單位當相同定義。
- [x] 舊工具無新參數時維持原行為；compact 與 summary 能由 response variant 判別，省略明細不等於沒資料。
- [x] summary 的全 rowset／current page scope 正確，來源、日期、品質、分頁及 ledger 不被丟棄。
- [x] 技術：SMA、RSI Wilder seed、平盤50、單邊漲100／跌0、樣本波動、排除今日的 breakout／volume denominator 皆有獨立預期數值。
- [x] 技術：固定 as-of、warmup、資料不足、停牌、除息、拆股／配股、減資、事件缺證據與轉板 case。
- [x] 不把調整失敗 raw fallback、不完整價格視窗或未完成交易日產生成「正常」指標。

### 測試與效能

- 新增單元測試：`research-fields/projection/statistics`、`screener`、`comparison-alignment`、`technicals-calculations`、各 domain client。
- 独立手算小型 fixture 驗證公式，不以同一 production function 產生 expected 值；另用跨事件 fixture 驗證調整契約。
- 以 injected clients 統計來源呼叫：未用 domain 零呼叫、全市場篩選不逐股 fan-out、比較不重複 source load、超限／deadline／取消均受控。
- 對相同確定性 fixture 比較輸出 JSON bytes：20 公司×8指標的 compact 相對 full、250 bars 的 summary 相對 full，目標至少減半；未達標需檢視結構，但不能刪除品質契約湊數。
- 跑 `npm run lint`、`npm run type-check`、`npm test`、`npm run build`。
- 檢查實際 in-memory MCP tools/list 與 callTool output；巢狀欄位 descriptions、annotations、工具名／數量／hash、首頁與 README 同步。
- 本機 server 執行 `npm run test:client -- http://localhost:3000/api/mcp`（需先啟動本機 server）；這只驗證部署契約，功能另外由 MCP callTool 測試與 functional smoke 驗證。不得把未部署功能拿 production smoke 充數。
- live 小樣本採 2330、6488、2881、2886，先以單市場驗證再測 all；記錄 latency、來源數量與日期對齊，不用即時數值當永遠固定的 assertion。
- live 遇到上游阻擋／逾時，保留明確未驗證項目，不能以 mock passing 宣稱 live 通過；也不以大量重試增加官方負擔。

### 完成定義

四項公開能力皆可從 MCP 呼叫、文件與工具契約同步、上列必要驗收均有證據，才算實作完成。發布／部署是另外的操作，本計畫沒有執行或承諾部署。

## 規劃審查時需保留的風險

1. upstream fields 與母體只達 heuristic/compatible：新工具必須傳遞限制，不能因成功 join 升級為 verified 全市場。
2. market_date 是價格觀測日期；當前財務值不具歷史 vintage，舊日期比較不代表當時已知資訊。
3. 組合來源的 snapshot 並非原子交易：以日期、內容 fingerprint 與 warnings 限定可保證範圍。
4. 財報不同業別、不同申報頻率与單位需明確 adapter；本計畫不以名稱相似推定可比較。
5. output variant 要在 A 階段驗證 SDK 與 schema 工具鏈，避免到最後才發現壓縮輸出破壞 required fields。
6. 52 秒 deadline 可能限制 cold-cache 最重查詢；先量測與有界處理，不能延長到平台60秒以外或悄悄減少 requested 範圍。

參考：`docs/research/tradingview-mcp-2026-09-17/report.md` 的實測結果。規劃已依本工作目錄 source 檢查；此文件本身不是功能已實作或測試已通過的證據。

## 呼叫範例（已於本機 MCP 驗證；不代表 production 已部署）

`screen_companies`：

```json
{
  "market": "all",
  "include_financial": false,
  "as_of": "latest",
  "revenue_month": "latest",
  "filters": [
    { "field": "revenue.yoy_pct", "op": "gt", "value": 20 },
    { "field": "valuation.pe", "op": "between", "value": [10, 25] },
    { "field": "price.turnover_twd", "op": "gt", "value": 100000000 }
  ],
  "columns": ["revenue.yoy_pct", "valuation.pe", "price.turnover_twd"],
  "sort": [{ "field": "revenue.yoy_pct", "direction": "desc" }],
  "page_size": 50,
  "output_mode": "compact"
}
```

`compare_companies`：

```json
{
  "company_codes": ["2330", "6488", "2881", "2886"],
  "columns": ["financial.Revenue", "financial.EPS", "financial.ROE", "valuation.pe", "revenue.yoy_pct"],
  "financial_period_policy": "common_latest",
  "financial_basis": "quarterly",
  "market_date": "latest",
  "revenue_month": "latest",
  "output_mode": "compact"
}
```

此例刻意包含金融／非金融混合，驗收應出現營收定義不可直接比較的說明，不能回傳一個跨業別營收名次。

`get_stock_price_series` 的摘要模式：

```json
{
  "company_code": "2330",
  "start_date": "2025-07-01",
  "end_date": "2026-09-16",
  "price_basis": "price_index_compatible_corporate_action_adjusted",
  "include_event_ledger": true,
  "output_mode": "summary"
}
```

`get_stock_technicals`：

```json
{
  "company_code": "2330",
  "as_of": "latest",
  "price_basis": "price_index_compatible_corporate_action_adjusted",
  "indicators": ["sma", "rsi", "historical_volatility", "breakout", "volume_ratio"],
  "sma_periods": [20, 60, 200]
}
```
