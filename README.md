# Mopsfin 台股 MCP Server

公開、唯讀、無資料庫的台灣公司財務與價格資料 MCP Server。服務以 Next.js 16 App Router 與 MCP TypeScript SDK v2 實作，透過 Stateless Streamable HTTP `/api/mcp` 暴露十個工具；財務查詢直接存取[公開資訊觀測站－財務比較 E 點通](https://mopsfin.twse.com.tw/)，上市櫃公司母體與 OHLC 價格直接取自 TWSE 與 TPEx 官方資料。

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
       └─ TWSE／TPEx 盤後行情 → 原始日線 OHLC
```

- 不使用資料庫、Redis 或已淘汰的 HTTP+SSE transport。
- 財務資料不快取；Mopsfin 動態目錄快取 5 分鐘、TWSE／TPEx 公司母體快取 6 小時、OHLC 最新／當月快取 5 分鐘、歷史月份／日期快取 24 小時，全部只存在單一 Vercel instance 記憶體。
- 上游 URL 完全固定，工具參數不能提供 URL，因此不會形成任意 proxy/SSRF。
- 上游 timeout 20 秒；網路錯誤、429、5xx 只重試一次，其他 4xx 不重試。
- 不保留或轉送 Mopsfin cookies。
- 報表的 `latest` 會從上一個完成季度往前探測最多 12 季，並核對回應期別，避免原站靜默退回其他季度。
- Vercel 使用 Node.js `24.x`、東京 `hnd1`、60 秒 function duration 與 Fluid Compute。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `find_companies` | 搜尋公司代號與名稱 |
| `get_stock_ohlc` | 查詢單一目前或歷史公司股票的跨期原始日線 OHLC，支援時間游標與轉板合併 |
| `get_daily_market_ohlc` | 查詢最近完成交易日或指定日期的上市、上櫃或全部市場 OHLC |
| `list_companies` | 取得全部、僅上市或僅上櫃的完整公司母體；可排除金融業與 KY 公司 |
| `list_catalog` | 即時列出指標、endpoint family、產業、金融機構及期間 |
| `get_company_metric` | 一般公司財務趨勢、比率、YOY 與現金流指標 |
| `get_financial_statement` | 資產負債表、綜合損益表、現金流量表 |
| `get_financial_note` | 五類財報附註 |
| `get_industry_data` | 產業統計與產業趨勢，支援營收／稅後純益 |
| `get_financial_institution_metric` | 金融業資產品質與資本適足率，可加入產業平均及所選機構簡單平均 |

每個工具都有嚴格 Zod input/output schema，回傳短 `content` 摘要及完整 `structuredContent`。工具 annotations 標記為唯讀、非破壞、冪等、無開放世界副作用。

LLM 可從三層取得解讀資料：MCP `initialize` 的 server instructions 說明整體資料範圍與呼叫順序；`tools/list` 對十個工具及每個 input/output 欄位提供用途與口徑；`list_catalog` 的 `officialGuidance` 與每個 metric 的 `guidance` 則提供公式、數值基礎、適用業別與注意事項。實際查詢結果的 `warnings` 會再帶入與本次查詢直接相關的母體／時間覆蓋、價格口徑、申報頻率、缺值、平均數或分頁警示。

需要完整上市櫃代號母體或全市場掃描時使用 `list_companies`；只知道特定公司名稱或代號時使用 `find_companies`，不要以 `find_companies` 枚舉全市場。不知道資料指標或期間時使用 `list_catalog`。`list_catalog` 的 `family` 對應如下：

| family | 使用工具 |
|---|---|
| `data` | `get_company_metric` |
| `report` | `get_financial_statement` |
| `bcode` | `get_industry_data` |
| `xb` | `get_financial_note` |
| `fin`, `adequacy` | `get_financial_institution_metric` |

### `list_companies` 公司母體

`market` 是必須正確理解的 MCP 介面語意，預設為 `all`：

| `market` | 母體 |
|---|---|
| `all` | 上市與上櫃全部公司；兩個官方來源都成功才回傳 |
| `listed` | 只取 TWSE 上市公司，包含創新板 |
| `otc` | 只取 TPEx 上櫃公司 |

`include_financial=false` 會依產業代號 17 排除金融保險業；`include_ky=false` 會排除註冊地為 KY 或官方簡稱標示 `-KY` 的公司。兩者預設皆為 `true`，因此預設母體不會默默漏掉金融業或 KY 公司。

工具回傳不分頁的完整 `companies` 陣列，並附上 `coverageComplete`、`snapshotId`、各來源 `reportDate`、原始／排除／最終筆數及 `warnings`。TWSE 公司基本資料中的 TDR 會固定排除；ETF、ETN、權證與特別股不屬於此公司母體。同一來源若混入不同出表日期，或排除 TDR 後上市少於 1,000 家、上櫃少於 800 家，工具會拒絕把疑似截斷資料標示為完整。`coverageComplete=true` 只代表要求的市場名錄完整取得並通過這些檢查，不代表每家公司在每個 Mopsfin 指標與期別都有資料。

### MCP descriptions 是介面契約

MCP descriptions 必須與實際行為同步，不能只更新程式邏輯或 README。新增或修改任何工具時，必須一起檢查並更新：

1. MCP `initialize` 的 server instructions。
2. `tools/list` 的 tool-level `description`，包括資料來源、參數路由、完整性與限制。
3. 每個 input/output 欄位的 Zod `.describe(...)`，包括 enum 各值的精確語意。
4. README、首頁工具清單、設定 prompt、smoke client 與 MCP integration tests。

整合測試會直接稽核 MCP `tools/list` 的實際輸出：每個工具必須有 title 與足夠完整的 tool description，所有 input/output 的巢狀 object、array item 與其欄位都必須有 description。測試也會特別鎖定 `list_companies` 的市場／TDR 完整性，以及兩個 OHLC 工具的 `raw_unadjusted`、時間游標、`coverageComplete`、`selectionComplete` 與 latest 非即時語意。

### 官方 OHLC 價格

`get_stock_ohlc` 每次只接受一個四碼 `company_code`，以含頭含尾的 `start_date`／`end_date` 查詢。每頁最多處理 12 個日曆月份；若 `coverage.coverageComplete=false`，必須以完全相同的代號與日期範圍帶回 `nextCursor`。TWSE 個股月資料自 `2010-01-04`、TPEx 自 `1994-01-01` 起支援；已下市櫃代號會探測兩個市場，轉板月份會合併 TPEx 與 TWSE 日線。

`get_daily_market_ohlc` 的 `market=all | listed | otc` 與公司母體一致。`date=latest` 代表最近完成交易日，不是盤中即時價；也可指定 `YYYY-MM-DD`，但假日或未來日期不會退回前一日。指定日期的上市市場最早為 `2004-02-11`、上櫃與全部市場最早為 `2007-04-23`。`company_codes` 最多 500 家，省略時回完整市場；指定代號有缺漏時必須讀取 `selectionComplete` 與 `missingCompanyCodes`。

兩個工具都固定回 `currency=TWD`、`timezone=Asia/Taipei`、`interval=1d`、`priceBasis=raw_unadjusted`，第一版不提供盤中即時報價、成交量、成交金額、adjusted close 或 corporate actions。官方 `--`／無成交會正規化為 `null` OHLC 與 `status=no_trade`，不可當成 0；週末、休市與停牌日期不會補合成 bar。

趨勢預設回最近 12 季，可用 `start_period`、`end_period` 或 `history: "all"`。大型 HTML 表格使用 `offset`、`limit` 分頁，預設 100 列、上限 500 列。期別格式為 `YYYYQn`。

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

健康檢查不會呼叫 Mopsfin，避免監控流量變成對原站的固定查詢。

可用官方 MCP Inspector 或內附 client 驗證：

```bash
npm run test:client
# 或指定 Preview URL
npm run test:client -- https://your-preview.vercel.app/api/mcp
```

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
5. 建立後確認 ChatGPT 能辨識十個工具。
6. 開始新對話，從工具選單加入這個 MCP connection，再直接以自然語言詢問台股。

Developer mode 是否可用取決於帳號方案與 workspace policy。詳細流程見 [OpenAI 官方連接說明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

範例問題：

- 「查台積電最近 12 季營業收入，整理成表格並標示期別、單位與 warnings。」
- 「查台積電 2025-01-01 到 2026-08-24 的原始日線 OHLC，若尚未完整請沿 nextCursor 繼續。」
- 「列出 2026-08-24 全部上市與上櫃公司的原始日線 OHLC，標示實際資料日期與來源。」
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

一般測試只使用固定 fixtures，涵蓋 README 已驗證範例清單、TWSE／TPEx 公司母體與 OHLC 正規化、上市／上櫃／全部路由、TDR 與金融／KY 排除、跨月游標、轉板、下市代號、無成交、日期／選擇完整性、暫時性 520、53 個 `compareItem` 分類、六個 endpoint family、timeout、429、5xx 及 MCP initialize/tools/list/tools/call。

Live contract tests 預設跳過，只有明確設定時才會查詢原站：

```bash
npm run test:live
```

請勿把 live tests 設為定時 CI，以免對 Mopsfin 造成固定流量。

## 部署到 Vercel

1. 將 repository 匯入 Vercel。
2. Build command 使用 `npm run build`；Vercel 會依 `package-lock.json` 執行 npm 安裝。
3. `package.json` 已固定 Node.js `24.x`；`vercel.json` 已啟用 Fluid Compute。
4. 部署後以 `npm run test:client -- https://<preview>/api/mcp` 驗收。
5. 視公開流量在 Vercel Firewall 設定適當規則；應用本身不建立跨 instance rate-limit 資料庫。

建議 Preview 驗收：台積電最近 12 季營收、台積電與聯發科 ROE、2026-08-24 上市櫃 OHLC、指定季資產負債表、半導體產業趨勢、臺企銀最近非 null 資本適足率及台積電財報附註。

## 錯誤碼

- `INVALID_ARGUMENT`
- `NOT_FOUND`
- `NO_DATA`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_RATE_LIMITED`
- `UPSTREAM_BAD_RESPONSE`

不同市場別的申報季度不同：上市／上櫃公司通常有 Q1–Q4，興櫃及公開發行公司可能只有 Q2/Q4，部分公司只申報年度。`NO_DATA` 不必然表示公司不存在。

## 資料來源、更新與使用條件

財務、報表、附註、產業與金融機構資料來源是 [Mopsfin](https://mopsfin.twse.com.tw/)。依其[網站使用說明](https://mopsfin.twse.com.tw/terms)，網站資料每日更新一次，可能較申報落後約一日。公司母體來源是 [TWSE 上市公司基本資料](https://openapi.twse.com.tw/v1/opendata/t187ap03_L)與 [TPEx 上櫃股票基本資料](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O)；OHLC 來源是 TWSE／TPEx 個股日成交與每日收盤行情。每次結果會保留各官方來源、擷取時間、資料日期與 coverage，不把不同日期或局部頁面冒充完整資料。本服務不使用測試 fixtures 作為正式資料或 fallback。

公開上線前，專案擁有者必須自行確認 TWSE、TPEx 與 Mopsfin 對公開代理、再散布及使用頻率的授權。公司基本資料集標示採政府資料開放授權條款第 1 版；Mopsfin 網站使用說明對資料範圍與更新頻率的描述，不等同明確授予再散布權。使用者也應以市場機構名錄與公開資訊觀測站原始申報作最後查核。

## 主要參考

- [OpenAI：Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Vercel：MCP for Next.js](https://github.com/vercel-labs/mcp-for-next.js)
- [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel Fluid Compute](https://vercel.com/docs/fluid-compute)
