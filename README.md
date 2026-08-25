# Mopsfin 台股 MCP Server

公開、唯讀、無資料庫的台灣公司財務資料 MCP Server。服務以 Next.js 16 App Router 與 MCP TypeScript SDK v2 實作，透過 Stateless Streamable HTTP `/api/mcp` 暴露八個工具；財務查詢直接存取[公開資訊觀測站－財務比較 E 點通](https://mopsfin.twse.com.tw/)，上市櫃公司母體直接取自 TWSE 與 TPEx 官方 OpenAPI。

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
       └─ www.tpex.org.tw/openapi → 上櫃公司母體
```

- 不使用資料庫、Redis 或已淘汰的 HTTP+SSE transport。
- 財務資料不快取；Mopsfin 動態目錄在單一 Vercel instance 記憶體快取 5 分鐘，TWSE／TPEx 公司母體各自快取 6 小時。
- 上游 URL 完全固定，工具參數不能提供 URL，因此不會形成任意 proxy/SSRF。
- 上游 timeout 20 秒；網路錯誤、429、5xx 只重試一次，其他 4xx 不重試。
- 不保留或轉送 Mopsfin cookies。
- 報表的 `latest` 會從上一個完成季度往前探測最多 12 季，並核對回應期別，避免原站靜默退回其他季度。
- Vercel 使用 Node.js `24.x`、東京 `hnd1`、60 秒 function duration 與 Fluid Compute。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `find_companies` | 搜尋公司代號與名稱 |
| `list_companies` | 取得全部、僅上市或僅上櫃的完整公司母體；可排除金融業與 KY 公司 |
| `list_catalog` | 即時列出指標、endpoint family、產業、金融機構及期間 |
| `get_company_metric` | 一般公司財務趨勢、比率、YOY 與現金流指標 |
| `get_financial_statement` | 資產負債表、綜合損益表、現金流量表 |
| `get_financial_note` | 五類財報附註 |
| `get_industry_data` | 產業統計與產業趨勢，支援營收／稅後純益 |
| `get_financial_institution_metric` | 金融業資產品質與資本適足率，可加入產業平均及所選機構簡單平均 |

每個工具都有嚴格 Zod input/output schema，回傳短 `content` 摘要及完整 `structuredContent`。工具 annotations 標記為唯讀、非破壞、冪等、無開放世界副作用。

LLM 可從三層取得解讀資料：MCP `initialize` 的 server instructions 說明整體資料範圍與呼叫順序；`tools/list` 對八個工具及每個 input/output 欄位提供用途與口徑；`list_catalog` 的 `officialGuidance` 與每個 metric 的 `guidance` 則提供公式、數值基礎、適用業別與注意事項。實際查詢結果的 `warnings` 會再帶入與本次查詢直接相關的母體完整性、申報頻率、單季／累計、缺值、平均數或分頁警示。

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

整合測試會驗證每個工具都有足夠完整的 tool description、所有頂層 input 欄位都有 description，並特別檢查 `list_companies` 的 `all | listed | otc`、TDR 排除及 `coverageComplete` 語意。

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
5. 建立後確認 ChatGPT 能辨識八個工具。
6. 開始新對話，從工具選單加入這個 MCP connection，再直接以自然語言詢問台股。

Developer mode 是否可用取決於帳號方案與 workspace policy。詳細流程見 [OpenAI 官方連接說明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

範例問題：

- 「查台積電最近 12 季營業收入，整理成表格並指出趨勢。」
- 「列出全部上市公司代號，不要包含上櫃公司。」
- 「列出全部上市與上櫃公司，排除金融業與 KY 公司。」
- 「比較台積電和聯發科最近 8 季 ROE。」
- 「列出台積電 2025Q4 資產負債表的主要項目。」
- 「比較半導體業最近 12 季營收趨勢。」
- 「查臺銀最近可用的銀行業資本適足率。」

## 驗證

```bash
npm run lint
npm run type-check
npm test
npm run build
```

一般測試只使用固定 fixtures，涵蓋 TWSE／TPEx 公司母體正規化、上市／上櫃／全部路由、TDR 與金融／KY 排除、完整性失敗、53 個 `compareItem` 分類、六個 endpoint family、缺值、負數、百分比、多公司、HTML 合併儲存格、分頁、timeout、429、5xx、錯誤季度及 MCP initialize/tools/list/tools/call。

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

建議 Preview 驗收：台積電最近 12 季營收、台積電與聯發科 ROE、指定季資產負債表、半導體產業趨勢、臺銀資本適足率及台積電財報附註。

## 錯誤碼

- `INVALID_ARGUMENT`
- `NOT_FOUND`
- `NO_DATA`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_RATE_LIMITED`
- `UPSTREAM_BAD_RESPONSE`

不同市場別的申報季度不同：上市／上櫃公司通常有 Q1–Q4，興櫃及公開發行公司可能只有 Q2/Q4，部分公司只申報年度。`NO_DATA` 不必然表示公司不存在。

## 資料來源、更新與使用條件

財務、報表、附註、產業與金融機構資料來源是 [Mopsfin](https://mopsfin.twse.com.tw/)。依其[網站使用說明](https://mopsfin.twse.com.tw/terms)，網站資料每日更新一次，可能較申報落後約一日。公司母體來源是 [TWSE 上市公司基本資料](https://openapi.twse.com.tw/v1/opendata/t187ap03_L)與 [TPEx 上櫃股票基本資料](https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O)；每次結果會分別回傳官方出表日期，不把兩個日期合併成無法驗證的單一日期。本服務不使用測試 fixtures 作為正式資料或 fallback。

公開上線前，專案擁有者必須自行確認 TWSE、TPEx 與 Mopsfin 對公開代理、再散布及使用頻率的授權。公司基本資料集標示採政府資料開放授權條款第 1 版；Mopsfin 網站使用說明對資料範圍與更新頻率的描述，不等同明確授予再散布權。使用者也應以市場機構名錄與公開資訊觀測站原始申報作最後查核。

## 主要參考

- [OpenAI：Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Vercel：MCP for Next.js](https://github.com/vercel-labs/mcp-for-next.js)
- [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel Fluid Compute](https://vercel.com/docs/fluid-compute)
