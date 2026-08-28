# Mopsfin 台股 MCP Server

目前版本 `0.9.1`。這是一個公開、唯讀、無資料庫的台灣公司財務與市場資料 MCP Server，以 Next.js 16 App Router 與 MCP TypeScript SDK v2 實作，透過 Stateless Streamable HTTP `/api/mcp` 暴露 23 個工具；財務查詢直接存取[公開資訊觀測站－財務比較 E 點通](https://mopsfin.twse.com.tw/)，上市櫃公司母體、原始日線價量、可稽核的公司行動調整價格序列、歷史估值、月營收、大盤指數、公司行動實際結果、年度開休市日曆、重大訊息與法人說明會、current official catalyst snapshots 直接取自 MOPS、TWSE 與 TPEx 官方資料。另可將 caller 自行觀察的價格與官方最近完成交易日收盤價分開標示後比較；caller 值不會被冒充成官方或即時行情。

這不是臺灣證券交易所或證券櫃檯買賣中心的官方 MCP Server，也不構成投資建議。

## 架構

```text
LLM / MCP client
       │ Streamable HTTP
       ▼
Next.js /api/mcp on Vercel
       │ 固定 allowlist endpoint、無任意 URL
       ├─ mopsfin.twse.com.tw
       │    ├─ JSON → periods + series
       │    └─ HTML → 展開 rowspan/colspan 的二維 tables
       ├─ openapi.twse.com.tw → 上市公司母體
       ├─ www.tpex.org.tw/openapi → 上櫃公司母體
       └─ TWSE／TPEx／MOPS 官方資料 → 原始日線價量、公司行動調整價格序列、日估值、月營收、市場指數、公司行動實際結果、重大訊息／法說會與 current catalyst snapshots
```

- 不使用資料庫、Redis 或已淘汰的 HTTP+SSE transport。
- 財務與事件資料都不持久化；Mopsfin 動態目錄與事件歷史 HTML、估值與月營收等官方 JSON／CSV 回應快取 5 分鐘，TWSE／TPEx 公司母體快取 6 小時，個股歷史 OHLC 月資料快取 24 小時。動態快取採有 entry／weight 上限的 TTL LRU 或固定小集合，只存在單一 Vercel instance 記憶體，重啟或跨 instance 不保證命中。
- 上游 URL 完全固定，工具參數不能提供 URL，因此不會形成任意 proxy/SSRF。
- 每個 MCP request 共用一個 absolute deadline；單次上游 timeout、等待併發 gate 與 retry backoff 都受剩餘時間約束，避免多次呼叫或重試把整體時間無限延長。
- 網路錯誤、429、5xx 或暫時性非 JSON 回應只做有限次重試；重試會尊重上游 `Retry-After`（設安全上限），否則使用 exponential backoff 與 jitter，其他 4xx 不重試。
- 上游 response bytes、JSON／CSV row 與 HTML table 展開都有上限；所有官方來源共用有界併發與等待佇列，超載時回結構化 backpressure 錯誤，不讓記憶體或排隊量無界成長。
- 行程內 telemetry 只彙總 MCP method、tool name、延遲、狀態、結構化錯誤碼及 reliability counters；不記錄 tool arguments、request body、認證資料或使用者查詢值，也不持久化。`/api/health` 是不呼叫上游的 shallow health：保留既有 `status`／`readiness`，並以 `liveness=ok`、`applicationReadiness=ready` 表示應用程式可回應及接受請求；`upstreamContracts.status=not_checked` 與 `lastCheckedAt=null` 明示本次 health request 沒有驗證官方資料契約。
- 版本由 `package.json` 經 browser-safe server identity 單向提供給 MCP initialize、health、首頁、guidance 與上游 User-Agent；公開工具名稱與數量則由 dependency-free tool manifest 提供。外部 surfaces 不各自保存另一份 runtime 版本或工具數量。
- 不保留或轉送 Mopsfin cookies。
- 報表的 `latest` 會從上一個完成季度往前探測最多 12 季，並核對回應期別，避免原站靜默退回其他季度。
- Vercel 使用 Node.js `24.x`、東京 `hnd1`、60 秒 function duration 與 Fluid Compute。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `find_companies` | 搜尋公司代號與名稱 |
| `get_stock_ohlc` | 查詢單一目前或歷史公司股票的跨期原始日線 OHLC，支援時間游標與轉板合併 |
| `get_stock_price_series` | 一次收齊單一公司最多 36 個月的 raw 或 price-index-compatible 公司行動調整日線，附可選事件 ledger 與 fail-closed 證據 |
| `get_daily_market_ohlc` | 查詢最近完成交易日或指定日期的上市、上櫃或全部市場日線價量 |
| `analyze_observed_price` | 比較 caller-supplied 觀察價與官方最近完成交易日 raw 收盤價，嚴格分開來源、時間與證據類別 |
| `get_stock_reaction_signals` | 比較個股 5／20／60／120 交易日原始與 price-index-compatible 報酬、價格指數 benchmark、量能與回撤代理訊號 |
| `get_daily_market_valuation` | 查詢上市、上櫃或全部市場 latest／指定日估值與參考財報欄位 |
| `get_valuation_model_inputs` | 整理單一非金融公司的可追溯 TTM、歷史 FCFF proxy、net debt、market cap 與 enterprise value 模型輸入 |
| `run_reverse_dcf` | 以顯性假設反解目前市場價格隱含的 revenue CAGR、FCFF CAGR 或 terminal operating margin |
| `get_monthly_revenue` | 查詢上市、上櫃或全部市場 latest／指定月份營收、MoM、YoY 與累計營收 |
| `get_monthly_revenue_trend` | 查詢 3–24 個月營收序列、滾動 YoY 與改善加速度 |
| `get_company_catalyst_events` | 查詢 selected companies 指定日期範圍的官方重大訊息與法人說明會；`isConsensus=false` |
| `get_company_catalyst_snapshots` | 查詢 selected companies 的財測達成／重大差異、股東會與股利決議 current official snapshot evidence |
| `screen_taiwan_stock_candidates` | 以四柱固定規則分流最多 5 個 latest 非金融台股研究候選 |
| `screen_taiwan_stock_candidates_with_catalyst_snapshots` | 執行相同四柱篩選後，只替實際最多 5 名 candidates 附上不影響分數的 current catalyst snapshots |
| `list_companies` | 取得目前上市／上櫃公司母體；以 heuristic coverage gate 偵測明顯截斷，可排除金融業與 KY 公司 |
| `list_catalog` | 即時列出指標、endpoint family、產業、金融機構及期間 |
| `get_company_metric` | 一般公司財務趨勢、比率、YOY 與現金流指標 |
| `get_company_metrics_batch` | 每頁批次取得多家公司 × 多項財務指標 |
| `get_financial_statement` | 資產負債表、綜合損益表、現金流量表 |
| `get_financial_note` | 五類財報附註 |
| `get_industry_data` | 產業統計與產業趨勢，支援營收／稅後純益 |
| `get_financial_institution_metric` | 金融業資產品質與資本適足率，可加入產業平均及所選機構簡單平均 |

每個工具都有嚴格 Zod input/output schema，回傳短 `content` 摘要及完整 `structuredContent`。成功結果固定包含 `ok=true` 與 `meta`；`meta.asOf`、`meta.quality`、`meta.page` 分別揭露實際資料時間、來源／母體／selection／值品質與續頁狀態。工具 annotations 標記為唯讀、非破壞、冪等、無開放世界副作用。

LLM 可從三層取得解讀資料：MCP `initialize` 的 server instructions 說明整體資料範圍與呼叫順序；`tools/list` 對 23 個工具及每個 input/output 欄位提供用途與口徑；`list_catalog` 的 `officialGuidance` 與每個 metric 的 `guidance` 則提供公式、數值基礎、適用業別與注意事項。實際查詢結果的 `warnings` 與 `meta.quality.issues` 會再帶入與本次查詢直接相關的母體／時間覆蓋、價格口徑、事件日期、snapshot freshness、申報頻率、缺值、平均數、研究代理或分頁警示。

需要目前上市櫃代號母體或全市場掃描候選代號時使用 `list_companies`；只知道特定公司名稱或代號時使用 `find_companies`，不要以 `find_companies` 枚舉全市場。不知道資料指標或期間時使用 `list_catalog`。`list_catalog` 的 `family` 對應如下：

| family | 使用工具 |
|---|---|
| `data` | `get_company_metric` |
| `report` | `get_financial_statement` |
| `bcode` | `get_industry_data` |
| `xb` | `get_financial_note` |
| `fin`, `adequacy` | `get_financial_institution_metric` |

### `screen_taiwan_stock_candidates` 研究候選分流

這是 latest-only、工作量有上限的非金融 research triage，不是最終選股或交易建議。`market` 可選 `all | listed | otc`，也可指定最多 100 個 `company_codes`；`include_ky` 預設為 `true`，`candidate_limit` 為 1–5、預設 5，`preset` 固定為 `balanced_non_financial_v2`。省略代號時以目前 heuristic-gated 上市櫃 master 為母體，金融保險業固定排除。

工具先以 latest 月營收與 latest 估值做低成本粗篩，再對最多 10 家取得 6 個月營收趨勢與七項財務指標，最後只對最多 5 家取得 5／20／60 交易日 reaction signals。七項需求不再以可能漂移的上游裸代號定義，而是固定為 `roe`、`net_profit`、`operating_cashflow`、`debt_ratio`、`gross_margin`、`operating_margin`、`eps` semantic roles；每次執行先從即時 Mopsfin catalog 的 `family=data` 以正式中文名稱精確解析，已知歷史代號只作 fallback。缺少、重複、名稱／代號衝突或 batch definitions 與解析結果不一致時，整次 screen 會以 `UPSTREAM_BAD_RESPONSE`／`CATALOG_CONTRACT_MISMATCH` fail closed，不猜測也不把契約漂移默默降為 `unknown`。generic `get_company_metric` 與 `get_company_metrics_batch` 仍只接受當次 catalog 的正式代號，不會全域放寬 alias。

deep batch 會逐公司解析 identity，並在 24-unit 預算內嘗試隔離 metric 錯誤；受影響代號會列在 `dependencyStatus.affectedCompanyCodes`，並以 `notReactionScored.reasonCodes=company_metrics_unavailable` 保留 unavailable／unknown 語意，不會被當成 `fail` 或 0 分。無法精確隔離時會保守標記共享 chunk 中的公司；其餘已進入 deep stage 的公司仍按既定規則繼續，但不會從 `deepSelected` 之外自動遞補。四柱 `companyQuality`、`fundamentalImprovement`、`reasonableValuation`、`marketUnderreactionProxy` 分別回 `pass | fail | unknown`；只有四柱皆可判讀時才提供等權總分，四柱全數通過才是 `research_candidate`。只有完成 reaction 並形成 `candidates` 的公司才進 bucket；其中品質與改善通過但估值或市場柱未通過者列為 `watchlist`，必要柱未知者列為 `insufficient_data`，其餘為 `deprioritized`。deep evidence unavailable 而未進 reaction 的公司則留在 `notReactionScored`。`screenDefinition.id=taiwan_stock_screen.v2` 會完整揭露 `coarseRanking`、criteria、weights，以及 `evidencePolicies.requiredFinancialMetricRoles`、當次 `resolvedFinancialMetrics`、`catalogDiscoveredAt` 與 deterministic `catalogSnapshotId`；`funnel`、`workBudget`、`dependencyStatus` 及 deprioritized 摘要則交代有多少公司在哪一階段被排除或證據不足。

四柱資料來自不同發布頻率與截止日，結果的 `asOf` 是 mixed、不是單一同步快照；應沿 `meta.asOf.sourceCutoffs` 與來源 lineage 判讀。`marketUnderreactionProxy` 僅接受公司行動 coverage、調整因子、前收盤核對與 marker reconciliation 均足以形成 `price_index_compatible` 證據的 reaction；任一必要證據不足即為 `unknown`，不會退回原始報酬評分。screen 本身目前沒有分析師預期修正、新聞、法人流向、持股或放空資料，也未將 `get_company_catalyst_events` 或 `get_company_catalyst_snapshots` 證據納入四柱評分。因為深篩名單與工作量刻意有界，結果不代表完整全市場四柱覆蓋，也不是 point-in-time／無存活者偏誤回測、錯價證明或投資建議；應把候選當成下一輪公開申報查核、估值建模與風險研究的優先清單。

### `screen_taiwan_stock_candidates_with_catalyst_snapshots` 候選快照補強

這個 wrapper 保留 `screen_taiwan_stock_candidates` 的輸入、四柱規則、排名、bucket 與分數，依序執行：

1. 先完成原本的 latest-only 四柱 screen。
2. 只取 screen 實際形成的 `candidates`，不論其 bucket 是 `research_candidate`、`watchlist`、`insufficient_data` 或 `deprioritized`；數量仍受 `candidate_limit` 限制且最多 5 家。
3. 僅對這些 candidate codes 查 `get_company_catalyst_snapshots` 的 current official snapshot evidence；若沒有實際 candidates，就不擴大查詢其他公司。
4. 將快照作為後續人工查核 evidence 附回，並固定標示 `affectsScreenScore=false`。

它會查詢 `screen.candidates` 中所有實際 candidates，不因 bucket 排除其中的 `watchlist`、`insufficient_data` 或 `deprioritized`；只排除 `notDeepScored`、`notReactionScored`、`excluded`，以及進入 `deepSelected` 但未形成 candidate 的公司。Current snapshots 不是歷史事件資料，也不是分析師 consensus／consensus revision；它們不是第五柱、不會成為加分項，也不產生目標價、買賣訊號或投資建議。原有的 `screen_taiwan_stock_candidates`、`get_company_catalyst_snapshots` 與 `get_company_catalyst_events` standalone tools 全部保留，使用者仍可分開呼叫。

### `get_company_catalyst_events` 官方事件

工具查詢 1–20 家 selected companies 在明確 `YYYY-MM-DD` 起訖範圍內的官方重大訊息與法人說明會，含首尾最多 366 日。重大訊息使用 MOPS 歷史查詢，並在查詢範圍與近期重疊時以 TWSE／TPEx current OpenAPI 補強；法說會使用 MOPS 歷史日曆。公開介面只支援 `material_information` 與 `investor_conference` 兩個 event families，不提供公司財測、分析師 consensus 或預估修正。目前公司 master 只用來協助 current identity 與近期重大訊息市場路由；歷史法說固定查上市、上櫃兩個 `TYPEK`，避免因公司轉板漏掉舊市場事件，且不會把目前 master 宣稱為歷史公司母體。

單次呼叫的 catalyst 計畫查詢工作單位上限為 40；重大訊息每個 company×month 為一單位，歷史法說每個 company×month 會分上市與上櫃兩單位，另加近期 market snapshot。這是執行前的 logical work budget，不包含 company-master hint、cache hit、single-flight 或 retry attempts，也不是實際 HTTP attempt 計數；超限時應縮小公司、日期或 event family 範圍。執行時的 failure isolation 是 `per_company_event_type_calendar_month`：上游錯誤、security block 或 parser failure 只標記對應單位並保留其他結果，不得解讀為無事件。`familyCoverage` 只計 selected-company 歷史月份，近期補強另列於 `coverage.currentSnapshots`。只有官方回應的明確空結果可核對、所有 requested families 完成、`companies[].eventCount=0`、沒有 failures，且 `meta.quality.selection=complete` 已確認公司 identity，才能說該公司在指定範圍「已驗證無事件」。

`publishedAt`、`factDate`、`scheduledAt` 與 `effectiveAt` 分開保留，官方未提供的日期不會互相代填。`dateConfidence=confirmed` 只表示時間直接來自官方證據，不代表事件為正面、負面或市場尚未反應。事件只作為 screening 後的人工查核證據；目前不把它納入 `screen_taiwan_stock_candidates` 分數，也不產生情緒、impact score、目標價或買賣建議。

事件使用 stateless offset 分頁：每頁會重新查詢並組裝官方來源，不是 pinned point-in-time snapshot。續頁必須沿用完全相同的公司、日期與 event types，並在 `fingerprint` 或 `meta.asOf.snapshotId` 改變時由 `offset=0` 重查。

### `get_company_catalyst_snapshots` 當期官方快照證據

這個工具查詢 1–20 家 selected companies 在 `as_of=latest` 的 current official snapshot evidence，不是歷史事件查詢。四個 family 是 `forecast_achievement`、`forecast_material_variance`、`shareholder_meeting` 與 `dividend_decision`；它最多檢查上市／上櫃 × 四 family 的 8 個 full-market source routes，再對 selected codes 分頁，`limit` 為 1–100。不需要資料庫，也不建立歷史 event store。

每個 source 的 `status` 是 `nonempty | verified_empty | failed | unsupported`，`freshness` 是 `within_expected_window | stale | not_applicable`。`sourceSnapshotDate` 只是官方資料集的當次出表／快照日，不是公司財測的 `factDate`、首次公告日或歷史事件日。快照日距 Asia/Taipei `asOf` 不超過 7 日才是 `within_expected_window`，超過即為 `stale`；任何 `sourceSnapshotDate` 晚於 Asia/Taipei as-of date，或日期無法驗證時都 fail closed。只有 fresh、schema-valid snapshot 缺少 selected code 時才能回 `not_disclosed_in_snapshot`；`stale`、`failed`、`unsupported` 或 identity 不可核對都是 unknown／unsupported，不得當成 current no-data。

`pointInTimeHistoryAvailable=false` 明示這些 current snapshots 不提供可回放的歷史 vintage。來源不能證明首次為市場知悉的時間，因此 `firstKnownAt` 固定為 null，不會以 `sourceSnapshotDate` 代填。`upcomingEligible` 只可用於 fresh snapshot 中會議日不早於 as-of 的股東會；財測達成／差異、過期會議、股利決議與 stale evidence 均為 false。TWSE 股利資料的董事會（擬議）分派日是董事會事件日，不是現金股利支付日。

公司自行揭露的財測達成／重大差異不是分析師 EPS／營收 consensus，也不是 consensus revision。TPEx 沒有可用的 current dividend-decision source，因此該 route 固定明示 `unsupported`；工具不會請求或以停在 2021 年的 stale `mopsfin_t187ap39_O` 冒充當期股利證據。`get_company_catalyst_events` 仍是原本的指定日期歷史重大訊息／法說會工具；兩個 catalyst tools 都不會改變 `screen_taiwan_stock_candidates` 四柱分數。

所有 snapshot routes 都沒有 official declared row count。因此 fresh nonempty snapshot 中缺少 selected code 的 `not_disclosed_in_snapshot` 只是「當次官方返回快照未見該代號」，不是絕對完整公司母體的證明。

### `list_companies` 公司母體

`market` 是必須正確理解的 MCP 介面語意，預設為 `all`：

| `market` | 母體 |
|---|---|
| `all` | 合併上市與上櫃兩個當次官方來源；兩個必要來源都成功且通過 safety gate 才回傳 |
| `listed` | 只取 TWSE 上市公司，包含創新板 |
| `otc` | 只取 TPEx 上櫃公司 |

`include_financial=false` 會依產業代號 17 排除金融保險業；`include_ky=false` 會排除註冊地為 KY 或官方簡稱標示 `-KY` 的公司。兩者預設皆為 `true`，因此預設母體不會默默漏掉金融業或 KY 公司。

省略 `page_size`／`cursor` 時，工具維持回傳本次 accepted snapshot 的整個 `companies` 陣列；提供 `page_size` 才按公司代號分頁。結果附上 `coverageVerification`、`coverageComplete`、`snapshotId`、各來源 `reportDate`、`minimumExpectedCount`、原始／排除／最終筆數及 `warnings`，並提供目前 snapshot 的成立日、實收資本額、已發行普通股數、面額原文與財報類型 raw code。頂層 `snapshotId` 只是 market＋reportDate 的來源日期標籤，不是內容 hash；cursor 綁定的內容 fingerprint 位於 `meta.asOf.snapshotId`，而 `meta.asOf.resolved` 使用官方 `reportDate`、不以 `generatedAt` 冒充資料日期。這些欄位不可拿來推算歷史市值。TWSE 公司基本資料中的 TDR 會固定排除；ETF、ETN、權證與特別股不屬於此公司母體。

TWSE／TPEx 公司基本資料來源沒有 official declared row count。`coverageComplete=true` 是向後相容成功旗標，只表示必要來源、必要欄位、單一出表日期、唯一代號與最低筆數 heuristic gate 均通過；`coverageVerification.status` 固定為 `heuristic`、`officialDeclaredRowCountAvailable=false`，`meta.quality.universe=unverified` 並帶 `MASTER_ROWSET_HEURISTIC` warning。它能拒絕混入不同出表日期，或排除 TDR 後上市少於 1,000 家、上櫃少於 800 家的疑似截斷來源，但不能證明官方完整 rowset；需要高風險全市場決策時仍應回查官方名錄。

### MCP descriptions 是介面契約

MCP descriptions 必須與實際行為同步，不能只更新程式邏輯或 README。新增或修改任何工具時，必須一起檢查並更新：

1. MCP `initialize` 的 server instructions。
2. `tools/list` 的 tool-level `description`，包括資料來源、參數路由、完整性與限制。
3. 每個 input/output 欄位的 Zod `.describe(...)`，包括 enum 各值的精確語意。
4. README、首頁工具清單、設定 prompt、smoke client 與 MCP integration tests。

整合測試會直接稽核 MCP `tools/list` 的實際輸出：每個工具必須有 title 與足夠完整的 tool description，所有 input/output 的巢狀 object、array item 與其欄位都必須有 description。測試也會特別鎖定 `list_companies` 的市場／TDR 完整性、兩個既有 OHLC 工具的 `raw_unadjusted`、價量單位、時間游標與完整性，以及 `get_stock_price_series` 的 raw／adjusted 分離、backward anchor、event ledger、fail-closed 調整證據與工作量界線；歷史估值、月營收／趨勢、批次指標、reaction signals、官方事件與候選篩選四柱的來源、缺值、分頁及比較限制也都在契約範圍。

### 統一結果、分頁與錯誤契約

所有成功工具的 `structuredContent` 固定包含 `ok=true` 與 `meta.contractVersion=mopsfin.result.v1`：

- `meta.asOf` 說明 requested selector、實際 resolved 時間範圍、`Asia/Taipei`、snapshot ID 與 `servedAt`；每個 `sourceCutoffs[]` 另分開保留資料 cutoff、官方明示的 `publishedAt`、真正向上游取得的 `retrievedAt`，以及 caller-specific `cache.status/observedAt/storedAt/ageMs/ttlMs`。cache hit 不會用 `servedAt` 覆寫原始 `retrievedAt`。
- `meta.quality` 分開揭露 source、universe、selection、values、freshness、逐來源／policy 的 `freshnessDetails` 與具體 `issues`。`latest` 只是 selector，不會自動等於 fresh；官方日行情、日估值與 completed-close dependencies 會以市場各自的 TWSE／TPEx 年度開休市日曆、當月 exact benchmark session 及 Asia/Taipei 13:33 guard 解析 `expectedAsOf`。resolver source 不可用、契約漂移或 `market=all` 兩市場日期不一致時 fail closed 為 `unknown + FRESHNESS_UNVERIFIED`；其他沒有可靠 expected as-of 的 policy 也維持 unknown，落後 policy 時回 `stale + DATA_STALE`。freshness 為 unknown/stale、`universe=compatible | unverified`，或 selection/value 尚為 `unknown` 時 overall `status=partial`；`status=complete` 仍不代表每個數值都非 null。
- `meta.page` 統一表示 `none`、`offset` 或 `cursor` 分頁，以及下一頁 token。`list_companies`、單日全市場 OHLC、估值與月營收在省略 `page_size`／`cursor` 時維持完整回傳，提供 `page_size` 後才啟用 stateless cursor；批次指標與 reaction signals 則預設分頁。

HTML 表格仍以 `pagination.nextOffset` 續頁，單一個股跨月 OHLC 以 `coverage.nextCursor` 續頁，reaction signals 以 `pagination.nextCursor` 續頁。cursor 不需要資料庫，也不保存伺服器端 session；`meta.asOf.snapshotId` 表示該工具可驗證的 snapshot scope。先取得整個 accepted rowset 再切頁的工具可綁內容快照，但這不額外證明官方 rowset 完整；`get_company_metrics_batch` 只綁 query／catalog，reaction cursor v2 綁 query／目前 master／benchmark，以及 full-market 公司行動 range contracts/summaries 與整個 requested company scope 的 TWSE 權息 detail fingerprint。各頁財務值或個股 OHLC 仍於該頁即時取得，因此會以 `STATELESS_PAGE_VALUES_NOT_PINNED` 明示不具跨頁 point-in-time 保證。`get_company_catalyst_events` 的 offset 也是重新查詢的非 pinned 分頁，必須比對 `fingerprint` 與 `meta.asOf.snapshotId`；出現 `CATALYST_OFFSET_PAGE_NOT_PINNED` 不代表資料已被鎖定。若錯誤 `reason` 是 `CURSOR_INVALID` 或 `SNAPSHOT_CHANGED`，依 `action=restart_pagination` 從第一頁重啟。

工具 handler 失敗時仍會回傳 `structuredContent`，固定含 `ok=false`、原有 `error.code`，以及 `reason`、`category`、`retryable`、`retryAfterMs`、`action` 與已清理的 `details`。只有上游逾時／限流等可重試錯誤應依指示重試；Zod input 驗證失敗仍使用 MCP protocol `InvalidParams`。

### 官方 OHLC 價格

`get_stock_ohlc` 每次只接受一個四碼 `company_code`，以含頭含尾的 `start_date`／`end_date` 查詢。每頁最多處理 12 個日曆月份；若 `coverage.coverageComplete=false`，必須以完全相同的代號與日期範圍帶回 `nextCursor`。TWSE 個股月資料自 `2010-01-04`、TPEx 自 `1994-01-01` 起支援；已下市櫃代號會探測兩個市場，轉板月份會合併 TPEx 與 TWSE 日線。

`get_daily_market_ohlc` 的 `market=all | listed | otc` 與公司母體一致。`date=latest` 代表最近完成交易日，不是盤中即時價；也可指定 `YYYY-MM-DD`，但假日或未來日期不會退回前一日。指定日期的上市市場最早為 `2004-02-11`、上櫃與全部市場最早為 `2007-04-23`。`company_codes` 最多 500 家；省略時回本次官方 snapshot 中通過公司股票辨識規則的全部 eligible rows，仍須依 `universeCoverageVerified`、`reconciliation` 與 `meta.quality` 判讀 rowset，指定代號有缺漏時則讀取 `selectionComplete` 與 `missingCompanyCodes`。

兩個工具都固定回 `currency=TWD`、`timezone=Asia/Taipei`、`interval=1d`、`priceBasis=raw_unadjusted`，並正規化官方成交股數、成交金額、成交筆數與漲跌。TPEx 歷史個股的「張／仟元」會乘以 1,000 統一為 shares／TWD；每個月、每個實際探測市場的 source 都分開保留 URL、原始單位、multiplier 與 `snapshotIdentity`。只有回應本身可核對月份時才保留 `dataMonth` 並讓 `meta.asOf.sourceCutoffs` 逐月追溯；官方 no-data response 若缺 title/date，會回 `snapshotIdentity=unverified_empty`、省略 `dataMonth`、將該 source cutoff 設為 none，並以 `meta.quality.source=partial` 與 `SOURCE_SNAPSHOT_IDENTITY_UNVERIFIED` 明示。官方 `--`／無成交會正規化為 `null` OHLC 與 `status=no_trade`，官方零成交量值仍保留 0；`qualityStatus`、`missingFields` 與 `dataQualityComplete` 用來區分完整、部分缺欄及官方無成交。週末、休市與停牌日期不會補合成 bar。這兩個 OHLC tools 不提供盤中報價或 adjusted close，也不內嵌公司行動資料或公司行動調整價；需要完整 raw／adjusted 日線序列時使用獨立的 `get_stock_price_series`，需要 benchmark reaction proxies 時使用 `get_stock_reaction_signals`。

### `analyze_observed_price` Caller 觀察價比較

這個工具處理「我目前看到 33.35 元」之類的使用情境，但不新增或假裝存在外部即時行情來源。caller 必須提供單一四碼 `company_code`、大於 0 的 `observed_price_twd`、含明確 `Z` 或 UTC offset 的 `observed_at`，以及非空 `source_label`。`-00:00` 表示未知 local offset，因此不被接受。工具先以 `market=all` 目前公司 master 的 listed／otc 兩份來源核對 identity；官方價格 dependency 使用 `compatible` current-master reconciliation，各市場 `matchRatio` 至少 95% 才接受，以免疑似截斷來源因只查一個代號而漏網。非目標公司的 master 差異不會阻斷查詢，但目標公司的 code、name、market 必須由外層 master 與官方行情列精確吻合，才能取得最近完成交易日的 `raw_unadjusted` 收盤價。

輸出固定分開 `CALLER_SUPPLIED` 觀察值、`OFFICIAL_MASTER_RAW` 公司 identity、`OFFICIAL_MARKET_RAW` completed close 與 `MOPSFIN_CALC` 機械價差；`priceOrigin=caller_supplied`、`officialHistoryCutoff`、三份 evidence sources、caller-specific cache provenance 與 `dependencyLedger` 都是契約的一部分。價格 dependency 內部的 nested compatible-master acquisition source evidence 目前不會由該 dependency 回傳，因此 ledger 明示 `not_exposed_by_dependency`，`meta.quality.source=partial`，不以外層 master 證據冒充同一次 nested retrieval。

若 caller observation 與官方 completed close 落在同一個台北日曆日期，只有 `13:33:00 Asia/Taipei`（含）之後才接受比較，藉此涵蓋一般 13:30 收盤及可能的暫緩收盤；更早的同日觀察值會 fail closed。這是保守 session guard，不代表 MopsFin 驗證了 observed price。結果只回答「caller 值相對最近官方完成收盤差多少」，不是 real-time quote、fair value、合理進場區、adjusted close、目標價、評級或投資建議。

### `get_stock_price_series` 公司行動調整價格序列

這個工具接受一個四碼 `company_code`、含頭含尾的 `start_date`／`end_date`、明確 `price_basis` 與 `include_event_ledger`；單次最多 36 個日曆月份，沒有 public cursor。它會在一次 orchestration 內收齊最多 3 個既有 `get_stock_ohlc` cursor pages；raw range 未能在安全上限內完整處理時整個工具 fail closed，不把局部結果冒充完整序列。`get_stock_ohlc` 的公開輸入、輸出與逐頁行為完全不變。

`price_basis=raw_unadjusted` 只回官方原始未還原權值 OHLC，完全不查公司行動；即使 `include_event_ledger=true`，ledger 仍為空，也不會增加公司行動請求。`price_basis=price_index_compatible_corporate_action_adjusted` 才會用 TWSE／TPEx official actual-result 除權息、減資與面額變更資料建立 backward factor，`adjustment.anchorDate` 固定是 requested window 最後一根實際 raw bar，而不是落在休市日的 requested end date。cash-only 現金股利 factor 固定為 1，現金股利造成的價格效果會保留；因此 adjusted OHLC 不是 adjusted close、股息再投資、total return 或 total shareholder return。成交量不調整，`volumeBasis=raw_shares`。

`include_event_ledger=true` 只在 adjusted basis 附上逐事件 official lineage、factor、`priorCloseCheck` 與 `markerReconciliation`。公司 identity、official history coverage、factor、prior close、同日多事件、轉板／市場、名稱或 `changeMarker` reconciliation 任一證據不足時，受影響 `cumulativeFactor` 與 `adjusted` 固定為 `null`，`adjustmentStatus=unknown` 並列出穩定原因；絕不回退 raw、猜測 factor 或把沒有可驗證事件說成無事件。原始 OHLC 與 raw volume 仍保留供稽核。

結果的 `sources[].stage` 分開標示 `company_master`、`raw_price` 與 `corporate_actions`，`coverage` 分開揭露 raw、公司行動與 adjustment；`workBudget` 另列一次 orchestration master call、最多 3 個 OHLC pages，以及 adjusted basis 至多一次 history dependency 與其官方 request count。`fingerprint` 綁 query、identity、raw bars、公司行動 history 與 adjustment evidence，排除 `retrievedAt`／cache caller state。這是明確歷史 range，`meta.quality.freshness=not_applicable`；它不是盤中即時或「截至現在」的價格聲明，也不構成投資建議。

`get_daily_market_ohlc` 的 `universe_policy=compatible` 維持 current-master 加四碼代號 fallback 行為，但各市場與目前 master 的 `matchRatio` 仍須至少 95%，以拒絕疑似截斷來源，並以 `classificationPolicy` 與 `reconciliation` 如實揭露差異；`strict_current_master` 只允許 `date=latest`，目前公司母體與行情不完全吻合時回 `INCOMPLETE_COVERAGE`。歷史日期固定採 `historical_code_rule`，不可將目前公司母體套用為歷史母體或據此宣稱無存續偏誤。

### Benchmark 與市場反應代理

`get_stock_reaction_signals` 接受 1–50 個目前上市櫃四碼代號、`as_of=latest | YYYY-MM-DD`，以及不重複的 5／20／60／120 交易日 `horizons` 子集合。benchmark 歷史自 `1999-01-05` 起；每頁最多 10 家、最多 48 個「一個官方市場月份 request」工作單位，受限時必須沿 `pagination.nextCursor` 續查。stateless reaction cursor 已升為 v2；`pagination.snapshotId` 在正常續頁保持相同，綁定 query、目前 master、benchmark、公司行動 range contracts/summaries，以及整個 requested company scope 的 TWSE 權息 detail evidence，來源改變時要求從第一頁重啟。尚未查詢公司的個股 OHLC 仍不在此快照內。

工具保留 `raw_unadjusted` 原始收盤報酬供稽核，另依 TWSE／TPEx 公司行動「實際結果」建立 `price_index_compatible_corporate_action_adjusted` 報酬，再與 TAIEX 或櫃買官方 `price_index` 比較。現金股利造成的價格效果會保留，以配合 price index 口徑；股票股利／除權、減資及面額變更的機械跳動則依官方前收盤與參考價調整。這個序列不是 adjusted close，也不是 total-return index／股息再投資報酬，不能當成總股東報酬。

公司行動來源包括 TWSE [除權除息計算結果（TWT49U）](https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html)、[減資恢復買賣參考價格（TWTAUU）](https://www.twse.com.tw/zh/announcement/reduction/twtauu.html)、[變更股票面額恢復買賣參考價格（TWTB8U）](https://www.twse.com.tw/zh/announcement/change/twtb8u.html)，以及 TPEx [除權息計算結果](https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ)、[減資恢復交易參考價格](https://www.tpex.org.tw/www/zh-tw/bulletin/revivt)、[變更股票面額恢復交易參考價格](https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt)。各資料集的可查起日不同，工具只對查詢視窗內已驗證的官方 coverage 下結論，不宣稱涵蓋來源支援日前的早期公司行動。

N-session 視窗依 benchmark 交易日曆的 exact 起訖日期計算，個股缺少錨點不會以前一成交日代填。官方 coverage、調整因子、前收盤核對或 `changeMarker` reconciliation 任一不足時，相應 adjusted return、excess return 與 screening market pillar 會是 `unknown`，不會猜測因子或回退成 raw score；沒有 marker 也不單獨證明沒有公司行動。跨越會改變股數的公司行動時，原始成交股數不可直接比較，因此 affected volume signal 會標成不可比；成交金額仍保留原始 TWD 證據。`comparability`、各 signal `status`、轉板／名稱變化與 `dataQualityComplete` 都必須保留；這些訊號只是可重算的市場反應代理，不是錯價證明或投資建議。

### 歷史估值、月營收與趨勢

`get_daily_market_valuation` 接受 `latest` 或單一 `YYYY-MM-DD`；指定假日不退回上一交易日。上市支援自 `2005-09-02`、上櫃與全部市場自 `2007-01-02`。latest 先以官方 OpenAPI 決定最近估值日，再以同日官方日端點補齊收盤價、每股股利、股利年度與參考財報期；成功時 `sources` 同時保留 discovery 與 exact-day lineage，同日補強失敗時則保留單一 OpenAPI 來源與其能提供的欄位。核心 PE／PB／殖利率 key 若從 eligible row 消失會視為上游 schema drift 並報錯；TWSE `total` 與 TPEx `totalCount` 也必須存在、是非負整數且等於實際資料列數，否則拒絕把截斷回應標示為完整。歷史查詢不以今天的 master 冒充當時母體，固定回 `classificationPolicy=historical_code_rule`、空 `reconciliation` 與 `universeCoverageVerified=false`。

### `get_valuation_model_inputs` 可追溯估值模型資料層

這個工具只接受單一四碼 `company_code`，為目前上市櫃非金融公司整理 14 個可重算欄位：TTM revenue、營業利益 EBIT proxy、cash tax rate、D&A、只含 PPE acquisition 的 CapEx、ΔNWC、`source/sign-normalized historical FCFF proxy`、cash、有息負債、net debt、目前 issued shares、最近完成官方估值日收盤、market capitalization 與 enterprise value。它只做模型輸入正規化，不執行 DCF，也不提供隱藏 WACC／terminal growth、評級、目標價或投資建議。

最近官方收盤的內部全市場 dependency 採 `compatible`，但每個市場仍須通過至少 95% current-master match ratio，以拒絕疑似截斷來源；指定公司的 code、name、market 還必須由外層 `market=all` current master 與官方 selected row 精確一致。這讓非目標公司的正常集合差異不再把合法單股價格誤判成 `data_gap`，同時對目標 identity、source contract、query、raw close 與 reconciliation 算術維持 fail closed。

TTM 嚴格採 Q4 FY，或 `current YTD + prior FY - prior-year YTD`。每份 Mopsfin 報表都核對公司 identity、報表類型、期別、合併範圍、唯一 row role，以及 HTML／catalog 的金額單位證據；金額從明示的新台幣仟／千元乘以 1,000 正規化為 TWD。任一必要條件不成立就回 `data_gap`、`value=null` 與 search-attempt lineage，不猜科目、不換來源，也不補 0。CapEx 第一版只含取得不動產、廠房及設備，未含無形資產或其他投資支出；`normalizedFcff` 是可重算的歷史 proxy，不代表分析師正規化或預測 FCFF。

每個欄位都有 `status`、`evidenceClass`、`formula`、`inputFieldIds`、`inputLineageIds` 與 notes。證據類別分開標示 `MOPSFIN_RAW`、`MOPSFIN_CALC`、`OFFICIAL_MASTER_RAW`、`OFFICIAL_MARKET_RAW`、`OFFICIAL_CALC`、`MIXED_OFFICIAL_CALC` 與 `UNAVAILABLE`；market cap 是目前 master issued shares × official completed-session close，enterprise value 才會再混合 Mopsfin net debt。issued shares 不是歷史期末、加權平均或 fully diluted shares。歷史財報是查詢當下 Mopsfin 可見、可能已重編的版本，不是 point-in-time filing vintage。

`meta.asOf.resolved.granularity=mixed` 且 from／through 維持 null，不把 quarter 與 calendar date 排成假的單一時間軸；真實時間只從逐來源 cutoff 分開讀取 master date、statement quarter 與 market date。Mopsfin latest 財報沒有可靠 expected quarter 時 freshness 為 `unknown`；官方 latest close 則以公司所屬市場的年度開休市日曆與 exact benchmark session 驗證，成功才可為 `within_expected_window`，任一 resolver 證據不足仍維持 `unknown + FRESHNESS_UNVERIFIED`。金融公司回 `not_applicable`，不得硬套一般企業 FCFF／enterprise-value DCF；應改用 residual income、dividend discount 或 excess-return 類模型。

### `run_reverse_dcf` 市場隱含 Reverse DCF

這個工具沿用 `get_valuation_model_inputs` 的 current-master identity、normalized financial facts、cash、aggregate interest-bearing debt、目前 issued common shares 與官方最近完成交易日收盤，以 FCFF／WACC、year-end discounting 和 perpetuity-growth terminal value 建立 deterministic market-implied reverse DCF。每次只能反解 `revenue_cagr`、`fcff_cagr` 或 `terminal_operating_margin` 其中一項；其餘 forecast years、WACC、terminal growth、solve range 與 mode-specific forward assumptions 都必須由 caller 明示。`WACC <= terminal growth`、必要 normalized fact／lineage 不完整、解區間未 bracket 市場 enterprise value，或數值 residual 無法在 tolerance 內收斂時會 fail closed，不會外插或產生看似合理的答案。

enterprise-value bridge 的 `non_operating_assets_twd`、`non_controlling_interests_twd`、`preferred_equity_twd`、`pension_deficit_twd` 與 `other_debt_like_items_twd` 也都是必填 caller assumptions；輸入 0 仍是顯性聲明，不代表官方來源已驗證為零。`non_operating_assets_twd` 必須排除已在 cash 欄位中的金額，`other_debt_like_items_twd` 必須排除已彙總進 interest-bearing debt 的負債與 lease roles，避免 bridge double count。股數基礎是目前 issued common shares，不是 fully diluted shares；金融公司固定回 `NOT_APPLICABLE_FINANCIAL_COMPANY`。

輸出保留逐年 forecast、terminal value、enterprise-to-equity bridge、PV tie-out、solver tolerance、checks，以及 `MOPSFIN_RAW`／`MOPSFIN_CALC`、官方來源、`CALLER_ASSUMPTION` 與 `MODEL_OUTPUT` 的分離證據。可選 sensitivity grid 每軸最多 5 個值、合計最多 25 cells；每個 cell 會重新反解，無可行解會個別標記，不能拿主模型或鄰近值代填。`workBudget` 分開揭露單次 orchestration、`1 + sensitivity cells` 個 solve attempts（最多 26），以及固定 solver policy 下每次最多 323、整體最多 8,398 次 model evaluations 的保守上限。來源時間維持 `source.retrievedAt <= valuationModelGeneratedAt <= generatedAt <= meta.asOf.servedAt`，財報季度、master date 與 market date 仍以 mixed source cutoffs 分開揭露。這個結果描述「caller assumptions 下，現在市場價格隱含什麼」，不是 intrinsic value、目標價、分析師共識、買賣評級或投資建議，也不會偷偷改變 `balanced_non_financial_v2`；未來若納入 screening，必須另開新 preset。

`get_monthly_revenue` 接受 `latest` 或 `2013-01` 起的 `YYYY-MM`。latest 以 OpenAPI 發現月份並與 MOPS archive 核對；同月不同出表日的少量重疊公司數值差異視為官方修訂，採較新 snapshot 並加入 warning，同出表日或大範圍衝突則報錯。歷史月份直接讀取 archive。歷史 archive 是目前可取得的修訂後檔案，不是當時發布內容的 vintage snapshot，不適合無偏誤 point-in-time backtest。MOPS CSV 沒有 declared row count、footer 或 checksum；工具會接受官方舊版短欄名與目前帶前綴的 14 欄格式，並驗證 RFC 4180、必要欄位、資料年月／出表日、四碼 eligible 代號唯一性，以 `sources[].integrity` 明示「結構可驗證、完整 rowset 不可證明」。`sourceCoverage` 與 `filingCoverage` 分別代表 rowset 完整性與 latest 申報進度，歷史月份的 `coverageComplete=false`、`filingCoverage.status=historical_cross_timepoint_unverified`。

估值的空白、`-` 或 `N/A` 會回 `null` 與 `missing_or_not_meaningful`，來源沒有該欄位則為 `not_provided_by_source`；`rawValue` 保留官方 marker，不會擅自推論成虧損或轉為 0。月營收官方金額以新台幣仟元提供，服務統一乘以 1,000 回傳 TWD；`sourceReportDate` 是資料集出表日期，不代表個別公司的申報時間。最新資料列未覆蓋目前全部公司可能源於申報進度、資料適用性或公司狀態差異，應讀取 `filingCoverage` 並回查官方申報，不可只以筆數判定上游失敗。

月營收趨勢必須指定 1–100 個四碼公司代號、3–24 個月視窗，固定使用 `compatible` 並保留 caller 公司順序。逐月 point 保留該月官方 `name`、`market` 與缺列；rolling 3／6 個月 YoY 是期間當月營收合計相對去年同月營收合計，YoY acceleration 是最新官方 YoY 減三個月前官方 YoY。所有必要值須為 reported 且去年同期合計須大於 0，否則衍生值為 null 並附 status；相鄰有資料月份若觀察到名稱或市場轉換，`comparability=needs_review` 且七個 derived 值全為 null，避免未經核對地串接改名、轉板或代號重用。工具不產生主觀的「基本面改善」分數。

### 財務趨勢與批次指標

一般財務趨勢預設回最近 12 季，可用 `start_period`、`end_period` 或 `history: "all"`。大型 HTML 表格使用 `offset`、`limit` 分頁，預設 100 列、上限 500 列。期別格式為 `YYYYQn`。

`get_company_metrics_batch` 適合一次取得多家公司 × 多個基本面指標：接受 1–100 家公司與 1–8 個 `list_catalog` `family=data` 指標，按 caller 公司順序分頁且每頁最多 20 家，每家公司保留全部 requested metrics。預設每家公司每項指標最多回自己的最近 12 期，也可指定含首尾最多 12 季；每 10 家 × 每個指標計為一個上游工作，comparison plan 與二分 isolation 合計每頁上限 24 units、併發上限 3。本工具不提供產業平均或所選公司平均；`NO_DATA` 不算 failure，單一 identity failure 與可在預算內隔離的 company×metric error 會 partial success，未受影響公司與工作繼續，受影響 company／metric 以 coverage、availability 與 failure 明示，unavailable 不會被改寫為 `fail` 或 0。若錯誤只能定位到共享 request 或隔離預算已滿，`failureIsolationComplete=false` 且 `failures[].attribution=chunk`，不能宣稱已找到單一故障公司；catalog、request／work-budget、ambient deadline、必要 invariant 或所有工作均失敗時仍整頁失敗。page 內 `snapshotId` 會包含完整 identity、unit、period、point value/status、availability／failure 與 coverage；cursor scope 則只綁 query／catalog，跨頁值不具 point-in-time 保證。

公司指標可用 `include_industry_average`、`include_company_average` 加入產業平均及所選公司簡單平均；金融機構指標可用 `include_industry_average`、`include_institution_average` 加入相應金融業別平均及所選機構簡單平均。這些平均數皆由 Mopsfin 計算，並非市值加權。

回答資料問題時至少應保留 `unit`、實際 `periods`／`period`、查詢 `basis` 與 `warnings`。`null`、`NO_DATA` 或沒有某一季可能表示不適用、尚未申報或該市場本來不需申報，不能改寫成 0。

## 本機開發

需求：Node.js 24、npm 11。

```bash
npm install
npm run dev
```

服務：

- 首頁：`http://localhost:3000/`
- MCP：`http://localhost:3000/api/mcp`
- 健康檢查：`http://localhost:3000/api/health`

健康檢查不會呼叫 Mopsfin、TWSE 或 TPEx，避免監控流量變成對官方來源的固定查詢。HTTP 200、`status=ok`、`liveness=ok` 與 `applicationReadiness=ready` 只代表應用程式的 shallow readiness；當 `upstreamContracts.status=not_checked` 時，不代表上游資料、schema、freshness 或完整性已在該次請求通過檢查。

可用官方 MCP Inspector 或內附 client 驗證：

```bash
npm run test:client
# 或指定 Preview URL
npm run test:client -- https://your-preview.vercel.app/api/mcp

# 另行驗證需連線 Mopsfin 上游的 find_companies
npm run test:client:functional -- https://your-preview.vercel.app/api/mcp
```

`test:client` 是不呼叫資料工具的部署契約 smoke check：遠端 MCP initialize 與 `/api/health` 的版本都必須精確等於本機 `package.json`；server name、result contract、endpoint、tool count、liveness、application readiness 及「本次未檢查上游」語意也必須吻合。遠端 `tools/list` 除了名稱與順序必須等於 canonical `PUBLIC_TOOL_NAMES`，每個工具的 title、description、inputSchema、outputSchema、annotations 也會以排序鍵 canonical JSON 計算 SHA-256；initialize instructions 則以原始 UTF-8 字串計算 SHA-256。兩份 expected hash 存在 dependency-free tool manifest，並由本機 in-memory MCP test 防止 registry、instructions 與常數不同步。

`test:client:functional` 是獨立的低成本上游功能探針，只呼叫一次 `find_companies(query=2330)`，並嚴格要求 MCP 沒有 tool error、`ok=true`、`meta.contractVersion=mopsfin.result.v1`、公司陣列欄位完整且包含 `2330`。因此 deployment contract 失敗代表部署內容漂移；functional probe 失敗則可獨立判讀為工具或 Mopsfin 上游問題。兩支 script 預設都以單一 60 秒 absolute deadline 包住 connect、requests 與 cleanup；可用 `MOPSFIN_SMOKE_TIMEOUT_MS=90000` 調整，合法範圍為 1000–300000 毫秒。

MCP client 設定範例：

```json
{
  "mcpServers": {
    "mopsfin": {
      "url": "https://your-domain.example/api/mcp"
    }
  }
}
```

### 在 ChatGPT 使用

ChatGPT 需要可連線的公開 HTTPS `/api/mcp` URL；本機的 `localhost` 不能直接交給遠端 ChatGPT。

1. 先部署到 Vercel，取得 `https://<你的網域>/api/mcp`。
2. 在 ChatGPT 開啟 **Settings → Security and login → Developer mode**。
3. 前往 ChatGPT Plugins，按加號新增連線。
4. 輸入名稱，例如 `Mopsfin 台股`，並將 Connection URL 設為完整的 `https://<你的網域>/api/mcp`。
5. 建立後確認 ChatGPT 能辨識 23 個工具。
6. 開始新對話，從工具選單加入這個 MCP connection，再直接以自然語言詢問台股。

Developer mode 是否可用取決於帳號方案與 workspace policy。詳細流程見 [OpenAI 官方連接說明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

範例問題：

- 「查台積電最近 12 季營業收入，整理成表格並標示期別、單位與 warnings。」
- 「用 get_valuation_model_inputs 整理台積電的 TTM、歷史 FCFF proxy、net debt、目前 issued shares、最近完成官方收盤與 enterprise value；逐欄列出 evidenceClass、formula、lineage、data_gap 與 freshness，不補 0、不當成 point-in-time vintage，也不要執行 DCF。」
- 「用 run_reverse_dcf 反解台積電目前官方收盤價隱含的 5 年 revenue CAGR；明示 WACC、terminal growth、normalized margin、cash tax、sales-to-capital、solve range 與每一項 EV bridge assumption，列出 forecast、terminal value、PV tie-out、evidenceClass、source cutoffs 與 sensitivity cell failures，不要把結果稱為目標價、共識或投資建議。」
- 「用 analyze_observed_price 比較我在 2026-08-28T09:32:00+08:00 看到的台積電 1,200 元，與官方最近完成交易日收盤價；把 caller-supplied 與 official evidence 分開，列出 cutoff、cache、價差與 warnings，不要稱為即時行情、合理價或投資建議。」
- 「查台積電 2025-01-01 到 2026-08-24 的原始日線 OHLC，若尚未完整請沿 nextCursor 繼續。」
- 「用 get_stock_price_series 查台積電 2025-01-01 到 2026-08-24 的 price-index-compatible 公司行動調整日線並附 event ledger；同時保留 raw OHLC、標示 backward anchor、現金股利 factor=1 與 raw shares，任何 adjustment 證據不足請回 null，不要回退 raw，也不要稱為 adjusted close 或 total return。」
- 「列出 2026-08-24 全部上市與上櫃公司的原始日線 OHLC，標示實際資料日期與來源。」
- 「查最新上市櫃公司估值，列出台積電與穩懋的本益比、股價淨值比、殖利率及 valueStatus。」
- 「查 2025-01-02 上市櫃公司估值，列出台積電與穩懋的 PE、PB、股利年度、參考財報期與 rawValue。」
- 「查最新上市櫃月營收，列出台積電與穩懋的 MoM、YoY、資料年月及 filingCoverage。」
- 「查台積電 2025-01 月營收，標示目前修訂後 archive、來源產業名稱與資料出表日。」
- 「查台積電截至 2026-07 的最近 12 個月營收趨勢，列出 3／6 月 YoY 與加速度。」
- 「查台積電、聯發科與穩懋的 ROE、毛利率及營業利益率最近 8 季資料，按公司整理。」
- 「比較台積電與 TAIEX 截至 2026-08-24 的 5、20、60、120 交易日原始與 price-index-compatible 報酬、公司行動證據及量能訊號。」
- 「用 balanced_non_financial_v2 篩選最新上市櫃非金融研究候選，最多 5 家；逐家列出四柱 status、分數、as-of、缺值與下一步查核，不要當成投資建議。」
- 「用 balanced_non_financial_v2 篩選最新上市櫃非金融研究候選，並只替實際最多 5 名 candidates 附 current catalyst snapshots；保留 affectsScreenScore=false，不要當成第五柱、分析師 consensus 或投資建議。」
- 「查台積電與聯發科 2026-07-01 至 2026-08-24 的官方重大訊息與法說會；分開 publishedAt、factDate、scheduledAt、effectiveAt，並標示 failures 與 verified empty，不要當成 consensus 或正負面分數。」
- 「查台積電與穩懋的 current official catalyst snapshots，分開財測達成、財測重大差異、股東會與股利決議；標示 sourceSnapshotDate、freshness、firstKnownAt、upcomingEligible 與 unsupported，不要當成歷史事件或分析師 consensus。」
- 「列出全部上市公司代號，不要包含上櫃公司。」
- 「列出全部上市與上櫃公司，排除金融業與 KY 公司。」
- 「比較台積電和聯發科最近 8 季 ROE，標示期別、單位與 warnings。」
- 「列出台積電 2025Q4 資產負債表的主要項目，標示單位與資料來源。」
- 「比較半導體業最近 12 季營收趨勢，並說明單季／累計口徑與 warnings。」
- 「查臺企銀最近可用的銀行業資本適足率；若最新期別為 null，往前找最近一個非 null，並標示期別、單位與 warnings。」

## 驗證

```bash
npm run lint
npm run type-check
npm test
npm run build
```

一般測試只使用固定 fixtures，涵蓋 README 範例、公司母體 profile、OHLC、raw／公司行動調整價格序列、歷史估值、月營收 CSV／趨勢、多指標批次、TAIEX／TPEx benchmark、reaction signals、官方重大訊息／法說會事件、current official catalyst snapshots、latest 候選篩選四柱與 funnel、stateless cursor、quality／as-of／structured errors，以及 MCP initialize/tools/list/tools/call。

Live contract tests 預設從一般測試跳過，只有明確設定時才會查詢原站。只執行低流量的 screening semantic catalog canary：

```bash
npm run test:live:catalog-screen
```

只執行 TWSE／TPEx 年度開休市日曆與 exact benchmark session 的 completed-session canary：

```bash
npm run test:live:completed-session
```

只執行低流量的公司行動 focused canary：

```bash
npm run test:live:corporate-actions
```

只執行低流量的 catalyst focused canaries：

```bash
npm run test:live:catalysts
```

只執行 caller-supplied observed-price 的單一公司 production contract：

```bash
npm run test:live:observed-price
```

只執行單一 2330、bounded 的 valuation-model input contract（檢查財報 label、單位、期別與 TTM bridge drift）：

```bash
npm run test:live:valuation-model-inputs
```

完整 live suite 則使用：

```bash
npm run test:live
```

既有 GitHub Actions 以每週一次、單一 concurrency group 的低頻 live contract workflow 稽核官方 schema／snapshot identity。`catalog-screen` suite 會先強制取得即時 Mopsfin catalog，驗證七項 screening semantic roles 均唯一解析至 `family=data`，再以單一 `2330` bounded screen 確認 `company_metrics_batch` 沒有失敗且 `deepScored=1`；這是避免 catalog 代號或名稱漂移再次被寬鬆 screen test 漏掉的低成本 production canary。`completed-session` suite 會以兩個市場各一份官方年度開休市日曆與一個 exact benchmark session marker 驗證 resolver contract、source identity 與 bounded work budget。公司行動 focused canary 覆蓋 TWSE／TPEx 各自除權息、減資與面額變更六組 range-family 來源的空與非空回應、必要欄位與 range identity schema drift，並另外驗證選定事件的 TWSE `TWT49UDetail`。`catalysts` suite 會同時執行原有 events canary 與 `catalyst-snapshots.live.test.ts`：前者以兩個 current OpenAPI 請求及三個固定歷史 MOPS 查詢工作單位，後者低頻稽核 current snapshot routes 的 schema、sourceSnapshotDate、freshness 與 unsupported 語意。`observed-price` suite 以單一 `2330` 實際走過 market=all master、compatible current-market 95% 防截斷門檻與目標公司精確 identity 核對，避免非目標公司的正常母體差異讓單一公司比較失敗。`valuation-model-inputs` suite 只查單一 `2330`，在最多七個 statement calls 與一次 official valuation dependency 內檢查三大報表 label、HTML unit provenance、共同期別、合併範圍與 TTM bridge，防止 row-role 或 unit drift。只有可核對 identity 的合法空回應才是 `verified_empty`；缺少 identity、stale、failed 或 unsupported 不能解釋為 current no-data。這些 canary 直接讀取官方來源，不使用資料庫、不寫入 persistence，也不改變 MCP runtime result contract。`workflow_dispatch` 的 `suite` 可選 `catalog-screen`、`completed-session`、`corporate-actions`、`catalysts`、`observed-price`、`valuation-model-inputs` 或 `all`；每週排程固定執行六類 focused canaries。請勿提高排程頻率或加入高基數掃描，以免對官方來源造成不必要流量。

公司行動 canary 中，缺少可核對 range identity 的空回應仍是 `unverified_empty`，不能宣稱已證明沒有事件。

## 部署到 Vercel

1. 將 repository 匯入 Vercel。
2. Build command 使用 `npm run build`；Vercel 會依 `package-lock.json` 執行 npm 安裝。
3. `package.json` 已固定 Node.js `24.x`；`vercel.json` 已啟用 Fluid Compute。
4. 部署後先以 `npm run test:client -- https://<preview>/api/mcp` 驗收 deterministic deployment contract，再以 `npm run test:client:functional -- https://<preview>/api/mcp` 獨立驗證一次 `find_companies` 上游功能；前者會拒絕版本、health、instructions 或 public tool contract 不一致的部署。
5. 視公開流量在 Vercel Firewall 設定適當規則；應用本身不建立跨 instance rate-limit 資料庫。

建議 Preview 驗收：latest 非金融研究候選篩選、指定公司官方 catalyst events 與 current snapshots、台積電最近 12 季營收、台積電與聯發科 ROE、多家公司多指標 batch、2026-08-24 上市櫃 OHLC、台積電 raw／公司行動調整價格序列與 event ledger、指定日估值、歷史月營收／趨勢、台積電相對 TAIEX reaction signals、指定季資產負債表、半導體產業趨勢、臺企銀最近非 null 資本適足率及台積電財報附註。

## 錯誤碼

- `INVALID_ARGUMENT`
- `NOT_FOUND`
- `NO_DATA`
- `INCOMPLETE_COVERAGE`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_RATE_LIMITED`
- `UPSTREAM_BAD_RESPONSE`

不同市場別的申報季度不同：上市／上櫃公司通常有 Q1–Q4，興櫃及公開發行公司可能只有 Q2/Q4，部分公司只申報年度。`NO_DATA` 不必然表示公司不存在。

工具 handler 錯誤另在 `structuredContent` 回傳 `ok=false`、原有 error code、細分 `reason`、`category`、`retryable`、`retryAfterMs` 與建議 `action`。Zod input 錯誤仍使用 MCP protocol `InvalidParams`。無伺服器端 cursor persistence；續頁會重新核對該工具宣告的 snapshot scope，能偵測的 scope 變更時要求從第一頁重啟，batch／reaction 尚未讀取的逐公司值則明確不宣稱被鎖定。

## 資料來源、更新與使用條件

財務、報表、附註、產業與金融機構資料來源是 [Mopsfin](https://mopsfin.twse.com.tw/)。依其[網站使用說明](https://mopsfin.twse.com.tw/terms)，Mopsfin 財務資料每日更新一次，可能較申報落後約一日；這項描述只適用於 Mopsfin 財務資料，不代表所有 TWSE／TPEx 資料都固定落後一天。公司母體來源是 [TWSE 上市公司基本資料](https://openapi.twse.com.tw/v1/opendata/t187ap03_L)與 [TPEx 上櫃股票基本資料](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O)，freshness 依各來源自己的 `reportDate` 判讀。OHLC 與估值以官方交易日為時間身分，`latest` 指最近可驗證的完成交易日而非固定延遲；月營收按資料年月與 `sourceReportDate` 判讀；重大訊息、法說會與 current catalyst snapshots 則分別保留事件日期、發布時間或 `sourceSnapshotDate`，不可套用 Mopsfin 的約一日規則。

事件資料的近期重大訊息來自 [TWSE 上市公司每日重大訊息](https://openapi.twse.com.tw/v1/opendata/t187ap04_L)與 [TPEx 上櫃公司每日重大訊息](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O)；指定範圍的歷史重大訊息與法說會分別由 MOPS 官方 [重大訊息歷史查詢](https://mopsov.twse.com.tw/mops/web/ajax_t05st01)與 [法人說明會歷史查詢](https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1)即時取得。這些是官方公告／排定事件，不是分析師 consensus、情緒或市場反應判斷。

Current snapshot families 來自 TWSE [t187ap15_L](https://openapi.twse.com.tw/v1/opendata/t187ap15_L)、[t187ap16_L](https://openapi.twse.com.tw/v1/opendata/t187ap16_L)、[t187ap41_L](https://openapi.twse.com.tw/v1/opendata/t187ap41_L)、[t187ap45_L](https://openapi.twse.com.tw/v1/opendata/t187ap45_L)，以及 TPEx [mopsfin_t187ap15_O](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O)、[mopsfin_t187ap16_O](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap16_O)、[t187ap41_O](https://www.tpex.org.tw/openapi/v1/t187ap41_O)。TPEx current dividend route 是 `unsupported`，故不將 stale `mopsfin_t187ap39_O` 列為 current 來源。

估值的 latest 日期由 [TWSE BWIBBU_ALL](https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL)與 [TPEx 本益比分析](https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis)發現，再以 TWSE `BWIBBU_d` 與 TPEx `peQryDate` 指定日端點補強；歷史日直接使用相同指定日端點。月營收 latest 由 [TWSE t187ap05_L](https://openapi.twse.com.tw/v1/opendata/t187ap05_L)與 [TPEx t187ap05_O](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O)發現月份，再與 `https://mopsov.twse.com.tw/nas/t21/{sii|otc}/t21sc03_{民國年}_{月}.csv` archive 核對；指定月與趨勢直接讀 archive。completed-session resolver 使用 [TWSE 年度開休市日曆](https://www.twse.com.tw/holidaySchedule/holidaySchedule)、[TPEx 年度開休市日曆](https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate)，以及 TWSE `MI_5MINS_HIST`／TPEx `tradingIndex` 官方價格指數端點確認 exact session。

每次結果會保留各官方來源、擷取時間、可由回應驗證的資料日期或年月、coverage 與統一 `meta`；若空回應缺少 snapshot identity，會明示 unverified 而不填造日期，不把不同日期、不同年月或局部頁面冒充完整資料。本服務不使用測試 fixtures 作為正式資料或 fallback。

公開上線前，專案擁有者必須自行確認 TWSE、TPEx 與 Mopsfin 對公開代理、再散布及使用頻率的授權。公司基本資料集標示採政府資料開放授權條款第 1 版；Mopsfin 網站使用說明對資料範圍與更新頻率的描述，不等同明確授予再散布權。使用者也應以市場機構名錄與公開資訊觀測站原始申報作最後查核。

## 主要參考

- [OpenAI：Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Vercel：MCP for Next.js](https://github.com/vercel-labs/mcp-for-next.js)
- [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel Fluid Compute](https://vercel.com/docs/fluid-compute)
