import { CopyButton } from "./copy-button";

const endpoint = "https://mopsfin-mcp.vercel.app/api/mcp";

const setupPrompt = `請協助我把「Mopsfin 台股財務」設定為遠端 MCP Server／自訂連接器。

連線資訊：
- 名稱：Mopsfin 台股財務
- 說明：查詢 Mopsfin 財務比較 E 點通提供的台灣公司財報、財務指標、附註、產業與金融機構資料。
- MCP URL：https://mopsfin-mcp.vercel.app/api/mcp
- 傳輸方式：Streamable HTTP
- 驗證方式：不需要登入、API Key、Token 或 OAuth
- 權限：唯讀

請依照以下規則協助我：
1. 先判斷我目前使用的是 ChatGPT、Claude Web，或其他支援遠端 MCP 的用戶端。
2. 如果你能操作目前應用程式的設定介面，請帶我完成新增，並在任何會改變帳號設定的步驟前讓我確認。
3. 如果你不能直接操作設定，請不要聲稱已完成；請按照目前平台的最新介面名稱，一次只告訴我一個清楚步驟，等我完成後再繼續。
4. URL 必須完整使用 /api/mcp，請勿改成網站首頁、/mcp 或其他路徑；若出現 OAuth 進階欄位，請保持空白。
5. 連線後確認可以看到 7 個唯讀工具：find_companies、list_catalog、get_company_metric、get_financial_statement、get_financial_note、get_industry_data、get_financial_institution_metric。
6. 最後在新對話啟用此連接器，並測試：「請先找出 2330 對應的公司，再查詢最近 12 季營業收入；標示期別、單位、來源與資料擷取時間。」
7. 若我的方案或工作區政策不允許新增自訂 MCP，請明確告訴我限制及需要聯絡的管理員角色。`;

const tools = [
  ["find_companies", "用代號或名稱尋找台灣公司"],
  ["list_catalog", "查看可用指標、報表、附註與期別"],
  ["get_company_metric", "查詢公司財務趨勢、比率與年增率"],
  ["get_financial_statement", "取得資產負債、損益與現金流量表"],
  ["get_financial_note", "取得財報附註與重要明細"],
  ["get_industry_data", "查詢產業統計與產業趨勢"],
  ["get_financial_institution_metric", "查詢金融業資產品質與資本適足性"],
] as const;

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Mopsfin 台股 MCP 首頁">
          <span className="brandMark" aria-hidden="true">M</span>
          <span>Mopsfin 台股 MCP</span>
        </a>
        <nav aria-label="頁面導覽">
          <a href="#chatgpt">ChatGPT</a>
          <a href="#claude">Claude Web</a>
          <a href="#prompt">設定 Prompt</a>
        </nav>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">REMOTE MCP · TAIWAN FINANCIAL DATA</p>
        <h1>把台股財報<br />接進你的 AI</h1>
        <p className="lede">
          直接在 ChatGPT、Claude 或其他支援 MCP 的 AI 中，查詢 Mopsfin
          提供的台灣公司財報、指標、附註、產業與金融機構資料。
        </p>

        <div className="endpointCard">
          <div>
            <span className="fieldLabel">MCP SERVER URL</span>
            <code className="endpoint">{endpoint}</code>
          </div>
          <CopyButton value={endpoint} label="複製網址" />
        </div>

        <ul className="facts" aria-label="服務特性">
          <li><span aria-hidden="true">●</span> 服務已上線</li>
          <li>Streamable HTTP</li>
          <li>免登入、免 API Key</li>
          <li>7 個唯讀工具</li>
        </ul>
      </section>

      <section className="intro" aria-labelledby="setup-title">
        <p className="sectionNumber">01</p>
        <div>
          <h2 id="setup-title">選擇你的 AI</h2>
          <p>這是雲端 MCP，不必下載程式或編輯本機設定檔。請務必貼上包含 <code>/api/mcp</code> 的完整網址。</p>
        </div>
      </section>

      <div className="platformGrid">
        <section className="platformCard chatgptCard" id="chatgpt" aria-labelledby="chatgpt-title">
          <div className="platformHeading">
            <span className="platformIcon" aria-hidden="true">◎</span>
            <div>
              <p className="platformKicker">OPENAI</p>
              <h2 id="chatgpt-title">ChatGPT Web</h2>
            </div>
          </div>

          <ol className="steps">
            <li>
              <span className="stepNumber">1</span>
              <div><strong>開啟開發者模式</strong><p>進入「設定」→「安全性與登入」→ 開啟「開發者模式」。</p></div>
            </li>
            <li>
              <span className="stepNumber">2</span>
              <div><strong>新增 MCP</strong><p>前往「Plugins」，按右上角的 <b>＋</b> 建立連線。</p></div>
            </li>
            <li>
              <span className="stepNumber">3</span>
              <div>
                <strong>填入連線資訊</strong>
                <dl className="settingsList">
                  <div><dt>名稱</dt><dd>Mopsfin 台股財務</dd></div>
                  <div><dt>說明</dt><dd>台灣公司財報與財務指標查詢</dd></div>
                  <div><dt>Connection</dt><dd><code>{endpoint}</code></dd></div>
                </dl>
              </div>
            </li>
            <li>
              <span className="stepNumber">4</span>
              <div><strong>檢查並開始使用</strong><p>建立後確認辨識出 7 個工具。開啟新對話，從工具選單加入這個 MCP 連線。</p></div>
            </li>
          </ol>

          <div className="platformFooter">
            <p>若看不到開發者模式或新增按鈕，通常是帳號方案或工作區政策尚未開放，請洽工作區管理員。</p>
            <div className="linkRow">
              <a className="buttonLink" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">開啟 ChatGPT Plugins <span aria-hidden="true">↗</span></a>
              <a href="https://developers.openai.com/plugins/deploy/connect-chatgpt" target="_blank" rel="noreferrer">OpenAI 官方說明</a>
            </div>
          </div>
        </section>

        <section className="platformCard claudeCard" id="claude" aria-labelledby="claude-title">
          <div className="platformHeading">
            <span className="platformIcon" aria-hidden="true">C</span>
            <div>
              <p className="platformKicker">ANTHROPIC</p>
              <h2 id="claude-title">Claude Web</h2>
            </div>
          </div>

          <ol className="steps">
            <li>
              <span className="stepNumber">1</span>
              <div><strong>開啟連接器設定</strong><p>在 Claude 進入「自訂（Customize）」→「連接器（Connectors）」。</p></div>
            </li>
            <li>
              <span className="stepNumber">2</span>
              <div><strong>新增自訂連接器</strong><p>按連接器旁的 <b>＋</b>，選擇「Add custom connector」。</p></div>
            </li>
            <li>
              <span className="stepNumber">3</span>
              <div>
                <strong>輸入名稱與網址</strong>
                <dl className="settingsList">
                  <div><dt>名稱</dt><dd>Mopsfin 台股財務</dd></div>
                  <div><dt>URL</dt><dd><code>{endpoint}</code></dd></div>
                  <div><dt>Advanced settings</dt><dd>OAuth Client ID／Secret 留空</dd></div>
                </dl>
              </div>
            </li>
            <li>
              <span className="stepNumber">4</span>
              <div><strong>在對話中啟用</strong><p>按輸入框左下角的 <b>＋</b> →「Connectors」，開啟 Mopsfin 台股財務。</p></div>
            </li>
          </ol>

          <div className="platformFooter">
            <p><strong>Team／Enterprise：</strong>必須先由 Owner 或 Primary Owner 在「Organization settings → Connectors」新增 Custom Web，成員才能連線。Free 帳號目前限 1 個自訂連接器。</p>
            <div className="linkRow">
              <a className="buttonLink" href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">開啟 Claude Connectors <span aria-hidden="true">↗</span></a>
              <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noreferrer">Anthropic 官方說明</a>
            </div>
          </div>
        </section>
      </div>

      <section className="promptSection" id="prompt" aria-labelledby="prompt-title">
        <div className="promptIntro">
          <p className="sectionNumber">02</p>
          <div>
            <h2 id="prompt-title">想讓 AI 帶你設定？</h2>
            <p>複製下面的 prompt 貼到 ChatGPT 或 Claude。AI 若能操作設定會請你確認；若不能，會依你的平台逐步引導，不會假裝已經完成。</p>
          </div>
        </div>
        <div className="promptBox">
          <div className="promptToolbar">
            <span>SETUP-PROMPT.TXT</span>
            <CopyButton value={setupPrompt} label="複製 Prompt" />
          </div>
          <pre><code>{setupPrompt}</code></pre>
        </div>
      </section>

      <section className="verifySection" aria-labelledby="verify-title">
        <div>
          <p className="sectionNumber">03</p>
          <h2 id="verify-title">確認連線成功</h2>
          <p>在已啟用連接器的新對話中貼上：</p>
          <blockquote>請使用 Mopsfin 台股財務，先找出 2330 對應的公司，再查詢最近 12 季營業收入；請標示期別、單位、來源網址與資料擷取時間。</blockquote>
          <CopyButton
            value="請使用 Mopsfin 台股財務，先找出 2330 對應的公司，再查詢最近 12 季營業收入；請標示期別、單位、來源網址與資料擷取時間。"
            label="複製測試問題"
          />
        </div>
        <aside className="successCard">
          <span className="successMark" aria-hidden="true">✓</span>
          <h3>成功時會看到</h3>
          <p>AI 呼叫 <code>find_companies</code> 與 <code>get_company_metric</code>，並回傳資料來源與擷取時間。</p>
        </aside>
      </section>

      <section className="toolsSection" aria-labelledby="tools-title">
        <p className="sectionNumber">04</p>
        <div>
          <h2 id="tools-title">可以問哪些資料？</h2>
          <ul className="toolGrid">
            {tools.map(([tool, description]) => (
              <li key={tool}>
                <code>{tool}</code>
                <span>{description}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="notice" aria-labelledby="notice-title">
        <p className="sectionNumber">05</p>
        <div>
          <h2 id="notice-title">資料來源與注意事項</h2>
          <div className="noticeContent">
            <p>每次查詢皆直接讀取公開資訊觀測站「財務比較 E 點通」，本服務不另建財務資料庫。原站每日更新一次，因此可能與公司最新申報約有一日時間差。</p>
            <p>上市櫃公司通常一年申報 4 次；興櫃與公開發行公司可能僅申報半年與年度，部分公司只需申報年度。查不到某季不一定代表連線失敗。</p>
            <p>本服務不是臺灣證券交易所官方服務，僅供資訊查詢，不構成投資建議。重要決策前請回到原始申報資料查核。</p>
            <div className="sourceLinks">
              <a href="https://mopsfin.twse.com.tw/" target="_blank" rel="noreferrer">Mopsfin 原始資料 <span aria-hidden="true">↗</span></a>
              <a href="https://mopsfin.twse.com.tw/terms" target="_blank" rel="noreferrer">官方使用說明 <span aria-hidden="true">↗</span></a>
              <a href="/api/health">服務狀態 <span aria-hidden="true">→</span></a>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <span>Mopsfin 台股 MCP</span>
        <span>公開 · 唯讀 · 無資料庫</span>
      </footer>
    </main>
  );
}
