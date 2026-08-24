# Mopsfin 台股 MCP Server

公開、唯讀、無資料庫的台灣公司財務資料 MCP Server。服務以 Next.js 16 App Router 與 MCP TypeScript SDK v2 實作，透過 Stateless Streamable HTTP `/api/mcp` 暴露七個工具；每次財務查詢都直接存取 [公開資訊觀測站－財務比較 E 點通](https://mopsfin.twse.com.tw/)。

這不是臺灣證券交易所官方 MCP Server，也不構成投資建議。

## 架構

```text
LLM / MCP client
       │ Streamable HTTP
       ▼
Next.js /api/mcp on Vercel
       │ 固定 allowlist endpoint、form-urlencoded、無 cookie
       ▼
mopsfin.twse.com.tw
       │
       ├─ JSON → periods + series
       └─ HTML → 展開 rowspan/colspan 的二維 tables
```

- 不使用資料庫、Redis 或已淘汰的 HTTP+SSE transport。
- 財務資料不快取；只有從首頁解析出的動態目錄會在單一 Vercel instance 記憶體快取 5 分鐘。
- 上游 URL 完全固定，工具參數不能提供 URL，因此不會形成任意 proxy/SSRF。
- 上游 timeout 20 秒；網路錯誤、429、5xx 只重試一次，其他 4xx 不重試。
- 不保留或轉送 Mopsfin cookies。
- 報表的 `latest` 會從上一個完成季度往前探測最多 12 季，並核對回應期別，避免原站靜默退回其他季度。
- Vercel 使用 Node.js `24.x`、東京 `hnd1`、60 秒 function duration 與 Fluid Compute。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `find_companies` | 搜尋公司代號與名稱 |
| `list_catalog` | 即時列出指標、endpoint family、產業、金融機構及期間 |
| `get_company_metric` | 一般公司財務趨勢、比率、YOY 與現金流指標 |
| `get_financial_statement` | 資產負債表、綜合損益表、現金流量表 |
| `get_financial_note` | 五類財報附註 |
| `get_industry_data` | 產業統計與產業趨勢，支援營收／稅後純益 |
| `get_financial_institution_metric` | 金融業資產品質與資本適足率，可加入產業平均及所選機構簡單平均 |

每個工具都有嚴格 Zod input/output schema，回傳短 `content` 摘要及完整 `structuredContent`。工具 annotations 標記為唯讀、非破壞、冪等、無開放世界副作用。

LLM 可從三層取得解讀資料：MCP `initialize` 的 server instructions 說明整體資料範圍與呼叫順序；`tools/list` 對七個工具及每個 input/output 欄位提供用途與口徑；`list_catalog` 的 `officialGuidance` 與每個 metric 的 `guidance` 則提供公式、數值基礎、適用業別與注意事項。實際查詢結果的 `warnings` 會再帶入與本次查詢直接相關的申報頻率、單季／累計、缺值、平均數或分頁警示。

不知道代號時先呼叫 `find_companies` 或 `list_catalog`。`list_catalog` 的 `family` 對應如下：

| family | 使用工具 |
|---|---|
| `data` | `get_company_metric` |
| `report` | `get_financial_statement` |
| `bcode` | `get_industry_data` |
| `xb` | `get_financial_note` |
| `fin`, `adequacy` | `get_financial_institution_metric` |

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
5. 建立後確認 ChatGPT 能辨識七個工具。
6. 開始新對話，從工具選單加入這個 MCP connection，再直接以自然語言詢問台股。

Developer mode 是否可用取決於帳號方案與 workspace policy。詳細流程見 [OpenAI 官方連接說明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

範例問題：

- 「查台積電最近 12 季營業收入，整理成表格並指出趨勢。」
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

一般測試只使用固定 fixtures，涵蓋 53 個 `compareItem` 分類、六個 endpoint family、缺值、負數、百分比、多公司、HTML 合併儲存格、分頁、timeout、429、5xx、錯誤季度及 MCP initialize/tools/list/tools/call。

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

資料唯一來源是 [Mopsfin](https://mopsfin.twse.com.tw/)。依其[網站使用說明](https://mopsfin.twse.com.tw/terms)，網站資料每日更新一次，可能較申報落後約一日；本服務不使用測試 fixtures 作為正式資料或 fallback。

公開上線前，專案擁有者必須自行確認 TWSE/Mopsfin 對公開代理、再散布及使用頻率的授權。網站使用說明對資料範圍與更新頻率的描述，不等同明確授予再散布權。使用者也應以公開資訊觀測站的原始申報作最後查核。

## 主要參考

- [OpenAI：Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Vercel：MCP for Next.js](https://github.com/vercel-labs/mcp-for-next.js)
- [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel Fluid Compute](https://vercel.com/docs/fluid-compute)
