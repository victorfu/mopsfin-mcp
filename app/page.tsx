const tools = [
  "find_companies",
  "list_catalog",
  "get_company_metric",
  "get_financial_statement",
  "get_financial_note",
  "get_industry_data",
  "get_financial_institution_metric",
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <p className="eyebrow">MODEL CONTEXT PROTOCOL</p>
        <h1>Mopsfin 台股 MCP Server</h1>
        <p className="lede">
          公開、唯讀、無資料庫的台灣公司財務資料介面。MCP endpoint：
          <code>/api/mcp</code>
        </p>
      </section>

      <section>
        <h2>可用工具</h2>
        <ul className="toolGrid">
          {tools.map((tool) => (
            <li key={tool}>
              <code>{tool}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="notice">
        <h2>資料與免責</h2>
        <p>
          資料即時取自公開資訊觀測站「財務比較 E 點通」。原站每日更新一次，可能與公司最新申報有約一日時間差；不同市場別的申報季度亦可能不同。
        </p>
        <p>
          本服務不是臺灣證券交易所官方服務，資料僅供資訊查詢，不構成投資建議。使用前請自行查核原始申報資料。
        </p>
        <p>
          <a href="https://mopsfin.twse.com.tw/" rel="noreferrer">
            原始資料來源
          </a>
          <span aria-hidden="true"> · </span>
          <a href="https://mopsfin.twse.com.tw/terms" rel="noreferrer">
            Mopsfin 使用說明
          </a>
          <span aria-hidden="true"> · </span>
          <a href="/api/health">服務狀態</a>
        </p>
      </section>
    </main>
  );
}
