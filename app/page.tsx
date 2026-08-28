import { CopyButton } from "./copy-button";
import {
  PUBLIC_TOOL_NAMES,
  TOOL_COUNT,
  type McpToolName,
} from "@/lib/mcp/tool-manifest";
import { PUBLIC_MCP_URL, SERVER_VERSION } from "@/lib/server/identity";

const endpoint = PUBLIC_MCP_URL;

const setupPrompt = `請協助我把「Mopsfin 台股財務」設定為遠端 MCP Server／自訂連接器。

連線資訊：
- 名稱：Mopsfin 台股財務
- 版本：${SERVER_VERSION}
- 說明：篩選台股研究候選，可選擇只替實際入選的最多 5 家 candidates 附上不影響分數的 current official catalyst snapshots，並查詢 TWSE／TPEx 上市櫃公司母體、官方日線價量、歷史估值、月營收趨勢、公司行動實際結果、benchmark reaction signals、重大訊息與法說會，以及 Mopsfin 財務比較 E 點通提供的公司財報與財務指標。
- MCP URL：https://mopsfin-mcp.vercel.app/api/mcp
- 傳輸方式：Streamable HTTP
- 驗證方式：不需要登入、API Key、Token 或 OAuth
- 權限：唯讀

請依照以下規則協助我：
1. 先判斷我目前使用的是 ChatGPT、Claude Web，或其他支援遠端 MCP 的用戶端。
2. 如果你能操作目前應用程式的設定介面，請帶我完成新增，並在任何會改變帳號設定的步驟前讓我確認。
3. 如果你不能直接操作設定，請不要聲稱已完成；請按照目前平台的最新介面名稱，一次只告訴我一個清楚步驟，等我完成後再繼續。
4. URL 必須完整使用 /api/mcp，請勿改成網站首頁、/mcp 或其他路徑；若出現 OAuth 進階欄位，請保持空白。
5. 連線後確認可以看到 ${TOOL_COUNT} 個唯讀工具，包含 screen_taiwan_stock_candidates、screen_taiwan_stock_candidates_with_catalyst_snapshots、get_company_catalyst_events、get_company_catalyst_snapshots、get_monthly_revenue_trend、get_company_metrics_batch 與 get_stock_reaction_signals。
6. 最後在新對話啟用此連接器，並測試：「請先找出 2330 對應的公司，再查詢最近 12 季營業收入；標示期別、單位、來源與資料擷取時間。」
7. 若我的方案或工作區政策不允許新增自訂 MCP，請明確告訴我限制及需要聯絡的管理員角色。`;

const toolSummaries = {
  find_companies: "用代號或名稱尋找台灣公司",
  get_stock_ohlc: "查詢單一台股跨期原始日線價量",
  get_daily_market_ohlc: "查詢單日上市、上櫃或全部市場價量",
  get_stock_reaction_signals:
    "比較個股原始／price-index-compatible 報酬、量能與市場價格指數",
  get_company_catalyst_events: "查詢官方重大訊息與法說會事件",
  get_company_catalyst_snapshots:
    "查詢財測達成／差異、股東會與股利決議的 current official snapshot evidence",
  screen_taiwan_stock_candidates:
    "以四柱 latest 資料分流最多 5 個非金融研究候選",
  screen_taiwan_stock_candidates_with_catalyst_snapshots:
    "四柱篩選後只替實際最多 5 名 candidates 附 current snapshots，不改分數",
  get_daily_market_valuation: "查詢官方 latest 或指定日估值與參考財報欄位",
  get_monthly_revenue: "查詢官方 latest 或指定月份營收",
  get_monthly_revenue_trend: "查詢 3–24 個月營收序列與透明衍生趨勢",
  list_companies: "列出目前上市／上櫃公司母體，並揭露 heuristic coverage",
  list_catalog: "查看可用指標、報表、附註與期別",
  get_company_metric: "查詢公司財務趨勢、比率與年增率",
  get_company_metrics_batch: "批次取得多家公司 × 多項基本面指標",
  get_financial_statement: "取得資產負債、損益與現金流量表",
  get_financial_note: "取得財報附註與重要明細",
  get_industry_data: "查詢產業統計與產業趨勢",
  get_financial_institution_metric: "查詢金融業資產品質與資本適足性",
} satisfies Record<McpToolName, string>;

const tools = PUBLIC_TOOL_NAMES.map(
  (name) => [name, toolSummaries[name]] as const,
);

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
        <p className="eyebrow">V{SERVER_VERSION} · REMOTE MCP · TAIWAN EQUITY RESEARCH</p>
        <h1>把台股財報<br />接進你的 AI</h1>
        <p className="lede">
          直接在 ChatGPT、Claude 或其他支援 MCP 的 AI 中，取得 TWSE／TPEx
          上市櫃公司母體、官方日線價量、歷史估值、月營收趨勢、市場反應代理、重大訊息與法說會、current official catalyst snapshots，並用透明四柱規則產生待深入研究的台股候選；需要時只替實際入選的最多 5 家 candidates 附上不影響分數的快照證據，再查詢 Mopsfin 提供的公司財報、批次指標、附註、產業與金融機構資料。
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
          <li>{TOOL_COUNT} 個唯讀工具</li>
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
              <div><strong>檢查並開始使用</strong><p>建立後確認辨識出 {TOOL_COUNT} 個工具。開啟新對話，從工具選單加入這個 MCP 連線。</p></div>
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
            <p>公司母體、原始日線價量、歷史估值、月營收與大盤指數直接讀取 MOPS／TWSE／TPEx 官方資料；財務查詢直接讀取公開資訊觀測站「財務比較 E 點通」。本服務不另建財務或市場資料庫。</p>
            <p><code>list_companies</code> 可用 <code>market=all</code>、<code>listed</code> 或 <code>otc</code> 合併或分別取得當次 TWSE／TPEx 公司名錄；TDR、ETF、ETN、權證與特別股不在公司母體內。官方來源沒有 declared row count，因此 <code>coverageComplete</code> 只代表 heuristic safety gate 通過，請一併讀取 <code>coverageVerification</code>、warnings 與 <code>meta.quality</code>，不可宣稱已證明完整 rowset。</p>
            <p>OHLC 價格為新台幣原始未還原權值日線，另提供官方成交股數、成交金額、成交筆數與漲跌；不是盤中即時價，也不提供 adjusted close。長區間個股查詢需依 <code>coverageComplete</code> 與 <code>nextCursor</code> 續查。</p>
            <p><code>get_daily_market_valuation</code> 可查單一歷史交易日，<code>get_monthly_revenue</code> 與 trend 可查 2013-01 起月份；空白或 N/A 保留為 null 並附資料狀態，不會改寫成 0。歷史月營收是目前修訂後 archive，不是 point-in-time vintage。</p>
            <p><code>get_stock_reaction_signals</code> 保留原始未還原權值報酬，另以 TWSE／TPEx 除權息、減資與面額變更實際結果建立 price-index-compatible 報酬。現金股利的價格效果會保留以配合 price index；它不是 adjusted close 或 total return。coverage、調整因子、前收盤或 marker 證據不足時回 unknown，跨股數變動的 volume 不直接比較。</p>
            <p><code>screen_taiwan_stock_candidates</code> 固定使用 <code>balanced_non_financial_v2</code>／<code>taiwan_stock_screen.v2</code>，是 latest-only、有工作量上限的非金融研究分流：以月營收領先粗篩，再對有限名單評估 <code>companyQuality</code>、<code>fundamentalImprovement</code>、<code>reasonableValuation</code> 與 <code>marketUnderreactionProxy</code>，最多回傳 5 個候選。七項財務需求先由穩定 semantic roles 對即時 catalog 解析；缺少、重複或語意衝突會以 <code>CATALOG_CONTRACT_MISMATCH</code> fail closed，當次 role→code/name/family 證據則保留在 <code>screenDefinition.evidencePolicies</code>。market pillar 只接受可比的公司行動調整證據。deep stage 會在 24-unit 預算內隔離 company-level identity／metric errors；受影響代號以 <code>dependencyStatus</code> 與 <code>notReactionScored</code> 標示 unknown，不會被誤判為 fail 或 0 分。其餘 deepSelected 公司繼續，但不從 deepSelected 之外自動遞補。不同資料來源的 as-of 可能不同；結果不是完整全市場深篩、point-in-time 回測、錯價證明或投資建議。</p>
            <p><code>screen_taiwan_stock_candidates_with_catalyst_snapshots</code> 先執行相同四柱 screen，再對 <code>screen.candidates</code> 中所有實際 candidates 查 current official catalyst snapshots，最多 5 家；不論 bucket 是 research_candidate、watchlist、insufficient_data 或 deprioritized 都會查。只有 notDeepScored、notReactionScored、excluded，以及進入 deepSelected 但未形成 candidate 的公司會排除。快照不是歷史事件，也不是分析師 consensus；<code>affectsScreenScore=false</code>，因此不是第五柱、加分項或投資建議。原本的 <code>screen_taiwan_stock_candidates</code>、<code>get_company_catalyst_snapshots</code> 與 <code>get_company_catalyst_events</code> standalone tools 都保留。</p>
            <p><code>get_company_catalyst_events</code> 依 selected company 與日期範圍即時查 MOPS 歷史重大訊息、法說會日曆，並用 TWSE／TPEx 每日重大訊息補強近期資料。<code>publishedAt</code>、<code>factDate</code>、<code>scheduledAt</code> 與 <code>effectiveAt</code> 分開；官方無事件、查詢失敗與 parser/security block 也分開。它不提供分析師 consensus、預估修正、情緒分數或投資建議，且不會改變四柱 screening 分數。</p>
            <p><code>get_company_catalyst_snapshots</code> 只讀取當次官方 snapshot evidence：<code>forecast_achievement</code>、<code>forecast_material_variance</code>、<code>shareholder_meeting</code> 與 <code>dividend_decision</code>，不是歷史事件查詢。應檢查 <code>sourceSnapshotDate</code>、<code>freshness</code>、<code>pointInTimeHistoryAvailable</code>、<code>firstKnownAt</code> 與 <code>upcomingEligible</code>；公司財測不是分析師 consensus，stale／unsupported 不是 current no-data。TPEx 沒有可用的 current dividend source，不會以舊的 <code>mopsfin_t187ap39_O</code> 冒充當期股利決議。此工具與現有 events 工具都不納入四柱 screening 評分。</p>
            <p>成功結果固定提供 <code>meta.asOf</code>、<code>meta.quality</code> 與 <code>meta.page</code>。<code>data cutoff</code>、<code>retrievedAt</code>、<code>servedAt</code> 與 cache age 分開保留；<code>freshnessDetails</code> 會列出逐來源 policy、observed/expected as-of 與 lag，無法驗證時是 <code>FRESHNESS_UNVERIFIED</code>，不會因查詢參數是 latest 就自動宣稱 fresh。reaction cursor v2 會把公司行動 range contracts/summaries 與 requested-company 權息 detail fingerprint 納入來源 snapshot，但不儲存在伺服器。若來源在續頁間改變，須依錯誤 <code>action=restart_pagination</code> 從第一頁重啟。</p>
            <p>資料 freshness 依來源分開判讀：Mopsfin 財務資料依官方說明每日更新、可能較申報落後約一日；這不代表所有 TWSE／TPEx 資料固定落後一天。OHLC／估值依完成交易日，月營收依資料年月與出表日，事件與 current snapshots 則依各自發布、事件或 snapshot 日期判讀。</p>
            <p>每個請求都有整體 deadline，暫時性上游錯誤會在期限內依 <code>Retry-After</code> 或 backoff 有限重試；response、cache、併發與等待 queue 均設上限。行程內 telemetry 只彙總 method、tool name、延遲、狀態與錯誤碼，不記錄 tool arguments 或 request body，也不持久化。服務狀態頁是 shallow health，不呼叫上游；<code>liveness=ok</code> 與 <code>applicationReadiness=ready</code> 只表示應用程式可回應，<code>upstreamContracts.status=not_checked</code> 明示該次請求未驗證官方資料契約。官方資料契約另以每週一次的低頻 live checks 驗證。</p>
            <p>上市櫃公司通常一年申報 4 次；興櫃與公開發行公司可能僅申報半年與年度，部分公司只需申報年度。查不到某季不一定代表連線失敗。</p>
            <p>本服務不是臺灣證券交易所或證券櫃檯買賣中心的官方服務，僅供資訊查詢，不構成投資建議。重要決策前請回到官方市場名錄與原始申報資料查核。</p>
            <div className="sourceLinks">
              <a href="https://mopsfin.twse.com.tw/" target="_blank" rel="noreferrer">Mopsfin 原始資料 <span aria-hidden="true">↗</span></a>
              <a href="https://openapi.twse.com.tw/v1/opendata/t187ap03_L" target="_blank" rel="noreferrer">TWSE 上市公司名錄 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O" target="_blank" rel="noreferrer">TPEx 上櫃公司名錄 <span aria-hidden="true">↗</span></a>
              <a href="https://www.twse.com.tw/zh/trading/historical/stock-day.html" target="_blank" rel="noreferrer">TWSE 個股日成交 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html" target="_blank" rel="noreferrer">TPEx 個股日成交 <span aria-hidden="true">↗</span></a>
              <a href="https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL" target="_blank" rel="noreferrer">TWSE latest 估值日期 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis" target="_blank" rel="noreferrer">TPEx latest 估值日期 <span aria-hidden="true">↗</span></a>
              <a href="https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=20250102&selectType=ALL&response=json" target="_blank" rel="noreferrer">TWSE 指定日估值 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=2025%2F01%2F02&response=json" target="_blank" rel="noreferrer">TPEx 指定日估值 <span aria-hidden="true">↗</span></a>
              <a href="https://openapi.twse.com.tw/v1/opendata/t187ap05_L" target="_blank" rel="noreferrer">TWSE latest 月營收 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O" target="_blank" rel="noreferrer">TPEx latest 月營收 <span aria-hidden="true">↗</span></a>
              <a href="https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7.csv" target="_blank" rel="noreferrer">MOPS 歷史月營收 archive 範例 <span aria-hidden="true">↗</span></a>
              <a href="https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?date=20250101&response=json" target="_blank" rel="noreferrer">TWSE TAIEX 歷史指數 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=2025%2F01%2F01&response=json" target="_blank" rel="noreferrer">TPEx 櫃買歷史指數 <span aria-hidden="true">↗</span></a>
              <a href="https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html" target="_blank" rel="noreferrer">TWSE 除權除息結果 <span aria-hidden="true">↗</span></a>
              <a href="https://www.twse.com.tw/zh/announcement/reduction/twtauu.html" target="_blank" rel="noreferrer">TWSE 減資參考價 <span aria-hidden="true">↗</span></a>
              <a href="https://www.twse.com.tw/zh/announcement/change/twtb8u.html" target="_blank" rel="noreferrer">TWSE 面額變更參考價 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ" target="_blank" rel="noreferrer">TPEx 除權息結果 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/www/zh-tw/bulletin/revivt" target="_blank" rel="noreferrer">TPEx 減資參考價 <span aria-hidden="true">↗</span></a>
              <a href="https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt" target="_blank" rel="noreferrer">TPEx 面額變更參考價 <span aria-hidden="true">↗</span></a>
              <a href="https://mopsfin.twse.com.tw/terms" target="_blank" rel="noreferrer">官方使用說明 <span aria-hidden="true">↗</span></a>
              <a href="/api/health">服務狀態 <span aria-hidden="true">→</span></a>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <span>Mopsfin 台股 MCP · v{SERVER_VERSION}</span>
        <span>公開 · 唯讀 · 無資料庫</span>
      </footer>
    </main>
  );
}
