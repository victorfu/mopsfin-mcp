# TradingView MCP × mopsfin：台股小樣本實測

實測日期：2026-09-17（Asia/Taipei）。資料由當前連線的 TradingView、MopsFin MCP 唯讀工具取得；mopsfin 程式碼對照版本為工作目錄 v0.11.0。沒有修改服務程式碼或帳戶設定。

結論：一般企業的季營收與日線 OHLC 有高度重疊，但金融業營收、EPS 定義、成交量、歷史可取得範圍與公司行動調整契約不能直接互換。四家公司均有季財務資料；金融股歷史行情在本次呼叫失敗，不能据此斷言不支援。

## 樣本與方法

| 角色 | 公司 | TradingView symbol |
|---|---|---|
| 上市非金融 | 2330 台積電 | TWSE:2330 |
| 上櫃非金融 | 6488 環球晶 | TPEX:6488 |
| 金融（原始樣本） | 2881 富邦金 | TWSE:2881 |
| 金融（行情失敗後補測） | 2886 兆豐金 | TWSE:2886 |

這是目的性小樣本；金融股同時也是上市公司，分類不是三個互斥市場。不能把 4/4 財務可取得推論為全台股 100% 覆蓋率。

- symbol 經 TradingView search_symbols 核對；mopsfin 財務 series identity 及價格 current master 核對公司。
- TradingView get_financial_history：FQ，2000-01-01 至 2026-09-17；三個原始樣本另查 FY 同範圍。
- mopsfin get_company_metric：Revenue、EPS，basis=quarterly、history=all。
- TradingView get_ohlcv：1D、count=5000、summary=false；金融股失敗後縮小筆數補測。
- mopsfin get_stock_price_series：2025-07-01 至 2026-09-16，price_index_compatible_corporate_action_adjusted，附 event ledger。
- 排除 2026-09-17 盤中／未完成日線，以完成的共同交易日比較。
- 比價容差：每個 OHLC 欄位 0.001 TWD。季營收先將 mopsfin 仟元乘 1000，容差 1 元以容納浮點誤差。
- 所有報告中的「歷史深度」皆是本次介面實際取得範圍，不代表資料商全部資料庫或永久上限。

原始 structuredContent、錯誤回應及逐日差異保存在 [evidence.json](./evidence.json)。財務與行情完整原始序列均保留。TradingView 未提供精確逐次取得時間，沒有補造；mopsfin 原有來源時間與品質 metadata 均保留。

## 1. 實際可取得的範圍

| 公司 | 季財務 | 日線歷史 | mopsfin 對照 |
|---|---|---|---|
| 台積電 | 成功，16 季 | 成功，5000 根 | 財務與 298 根共同日線成功 |
| 環球晶 | 成功，16 季 | 成功，2885 根 | 財務與 298 根共同日線成功 |
| 富邦金 | 成功，16 季 | 未成功 | 財務與 298 根官方日線成功 |
| 兆豐金 | 成功，16 季 | 未成功 | 財務與 298 根官方日線成功 |

富邦金 5000 根請求及相同參數重試均回 INVALID_ARGUMENT；縮至 1000、300 根均回 tvws request timeout。兆豐金 5000 根回 INVALID_ARGUMENT，300 根回同類 timeout。本次不再重試；錯誤可能來自工具／行情後端／權限或特定商品路由，證據不足以定位原因，更不能當成合法「沒有行情」。

查到 symbol 或財務數字，不代表另一個行情工具可用；這兩種覆蓋需分開記錄。

## 2. 財報期別與單位

三個原始樣本的 fiscal_period_current 均為 2026-Q2；fiscal_period_end_current=1782777600，即 2026-06-30 UTC。四檔的財務歷史最後一季均為 2026Q2，與 mopsfin 一致。這個日期是財報期末，不是公告日或市場首次知道資料的日期。

| 2026Q2 | mopsfin Revenue（仟元） | TradingView revenue（原始值） | 換算結果 |
|---|---:|---:|---|
| 台積電 | 1,270,380,250 | 1,270,380,250,000 | 相同 |
| 環球晶 | 15,214,310 | 15,214,310,000 | 相同 |
| 富邦金 | 106,275,016 | 256,684,647,000 | 不同 |
| 兆豐金 | 25,524,113 | 47,786,510,000 | 不同 |

台積電與環球晶在全部 16 個共同季度，Revenue × 1000 均與 TradingView revenue 相同（浮點誤差容差 1 元）。因此，這兩檔實測金額是新台幣元的尺度；TradingView 財務歷史回應本身沒有明示 currency/unit，不能把這個推論泛化到其他商品。

金融兩檔的 16 個共同季度營收均不相同。mopsfin 的跨業別 Revenue 對金控是「淨收益」：
- 富邦金 2026 上半年損益表淨收益 172,468,262 仟元，減 Q1 66,193,246 仟元，得到 Q2 106,275,016 仟元。
- 兆豐金上半年 46,292,555 仟元，減 Q1 20,768,442 仟元，得到 Q2 25,524,113 仟元。

這兩個計算均由 get_financial_statement 取得的累計損益表驗證。TradingView revenue 的完整組成尚未對帳，不能只把差額稱為利息費用，也不能直接判定任一方錯誤。TradingView 官方說明財務資料經標準化，可能不同於申報值；其銀行業營收說明也區分 total revenue 與 net revenue。這是差異的合理背景，不是已證實的逐科目調節表。

### EPS 不是同名即同義

2026Q2 實際回應：

| 公司 | mopsfin EPS | TV history eps | TV basic_fq | TV diluted_fq | TV reported earnings_per_share_fq |
|---|---:|---:|---:|---:|---:|
| 台積電 | 27.25 | 27.2470 | 27.2482 | 27.2470 | 27.25 |
| 環球晶 | 7.90 | 7.8992 | 7.9042 | 7.8992 | 7.90 |
| 富邦金 | 4.27 | 4.2746 | 4.2746 | 4.2746 | 4.38 |

這三檔當季 history eps 與 diluted_fq 相符；不能以 history 的簡稱 eps 當作所有來源相同的 EPS。reported 欄位也不保證與 mopsfin 相同。

歷史差異更大：
- 環球晶 2022Q3：mopsfin 11.74；TV history 10.3137。
- 富邦金 2025Q1：mopsfin +3.00；TV history -2.0433。
- 富邦金 2025Q2：mopsfin +0.49；TV history -2.1614。

這不是單純四捨五入。標準化、基本／稀釋口徑、股數調整及重編資料版本均需另外追溯。富邦官方已說明 2026 起會計準則及金融資產處理變動，但本次沒有足夠逐期證據把上述差異全部歸因於 IFRS 17。兩邊的當前資料亦不能當成歷史 point-in-time vintage。

### FQ 選項的實測陷阱

對富邦金呼叫 get_financials(symbol=TWSE:2881, period=fq)，省略 metric，回應仍包含 total_revenue_ttm=923,357,023,000 等 TTM 欄位。
改成 period=fq, metric=[revenue, eps]，才回 total_revenue_fq=256,684,647,000。
台積電明確指定相同 metric 也回正確的 FQ 欄位。

此為本次觀察到的行為，尚未推論所有指標或所有商品都相同。消費端必須驗證回傳欄位 suffix 與 fiscal period，不能只信任送出的 period。

mopsfin get_company_metric quarterly 是單季口徑；get_financial_statement 的損益／現金流是累計，必須先差分才可比較。mopsfin 財務 latest freshness 仍標 unknown，不能因兩边最新期別相同就宣稱資料一定無遺漏或已完成所有更新。

## 3. 歷史深度

| 公司 | TV 季財務本次範圍 | mopsfin Revenue／EPS 本次範圍 |
|---|---|---|
| 台積電 | 2022Q3–2026Q2，16 季 | 2013Q1–2026Q2，54 個有效季度 |
| 環球晶 | 2022Q3–2026Q2，16 季 | 2014Q2–2026Q2，48 個有效期別，缺 2014Q3 |
| 富邦金 | 2022Q3–2026Q2，16 季 | 2013Q1–2026Q2，54 個有效季度 |
| 兆豐金 | 2022Q3–2026Q2，16 季 | 2013Q1–2026Q2，54 個有效季度 |

對台積電另指定 2013-01-01 至 2020-12-31，TV 回 no fundamental history in the requested range。這支持「本次 MCP FQ 介面未提供更早資料」，不代表 TradingView 網站或其他付費介面也只能取得 16 季。

環球晶早期未上市櫃時的申報頻率與單季／累計意義另需依 mopsfin guidance 解讀，48 個期別不等於 48 個全都可直接同比的獨立單季。

TV FY 結果較長：台積電、富邦金為 2010–2025（16 年），環球晶為 2012–2025（14 年）；兆豐金沒有補測 FY。mopsfin 本次測的是 IFRSs 季資料，不能宣稱其所有歷史一律比 TV 長。

TV 日線：
- 台積電：2006-04-17 至 2026-09-17，共 5000 根，已碰到請求筆數上限；首日不能視為上市日或資料庫最早日。
- 環球晶：2014-10-28 至 2026-09-17，共 2885 根，少於請求上限。
- 最後一根 2026-09-17 為未完成日線，不納入跨來源比對。
- mopsfin 本次實測的是上述 15 個月；文件契約支援 TWSE 個股原始日線自 2010-01-04、TPEx 自 1994-01-01，但這不是每家公司從該日起都有成交資料的保證。

## 4. OHLC 與成交量

2025-07-01 至 2026-09-16，每檔共有 298 個共同交易日：

| 公司 | 共同日期 | 四個 OHLC 欄位全相同 | 成交量差小於 1 股 |
|---|---:|---:|---:|
| 台積電 | 298 | 298 | 4 |
| 環球晶 | 298 | 298 | 1 |
| 富邦金、兆豐金 | TV 查詢失敗 | 未驗證 | 未驗證 |

價格依官方 TWD 值與逐日數字比對成立。TradingView volume_unit_note 明示股票成交量以 shares 計；mopsfin volumeShares 也以股計。

成交量仍不能直接互換：
- 台積電 2026-06-01：mopsfin 60,942,792 股；TV 37,878,764 股，少 23,064,028 股，約 37.85%。同日 OHLC 仍全部相同。統計全視窗最大的相對量差約 40.97%，不是單位乘 1000 可解決。
- 環球晶全部 298 天量差均在 500 股內，最大 498 股。mopsfin 的 TPEx 月資料以仟股來源轉成股，與來源精度差異相符；這是有資料支持的解釋，仍不等於 TV 比官方更準確。
- 台積電量差究竟來自交易範圍、鉅額交易、時段或資料供應商處理，本次未有足夠證據定位，不作確定歸因。

## 5. 還原價格口徑

TV get_ohlcv 回應明示價格僅做 split adjustment，並且有延遲、沒有盤前盤後 bar；工具沒有公開 raw／股利調整切換參數。

本次可實證的是：
- 台積電共同視窗有 5 次現金除息，環球晶有 3 次；mopsfin ledger 的 cash-only factor=1。
- 兩檔在整個視窗內的 TV OHLC 均與官方 raw OHLC 相同，支持本次回傳沒有向前調整現金股利。
- 兩者都不能直接當成含息總報酬；mopsfin 的 price-index-compatible 也明示不是 total return。
- 富邦金官方 ledger 找到 2025-09-25 除權，前收 89、參考價 86.82，mopsfin backward factor=86.82/89=0.975505617977528。
- 然而富邦金 TV OHLC 未成功，無法驗證 TV 對這次配股是否採相同因子；台積電與環球晶共同視窗沒有股數改變事件，因此不能把它們價格相同的結果泛化為拆股／配股／減資全部等價。
- mopsfin 調整以指定窗口最後 raw bar 為錨，成交量維持 raw shares，附事件證據；TV 回應未提供同等事件 ledger。更換查詢終點也可能使調整基準不可比。

因此，現金股利不還原已有樣本驗證；股數變動事件的跨來源等價性仍未確認。

## 對 mopsfin 的實際意義

1. 台股一般企業季營收及日線 OHLC 的功能重疊已由數值證實，但先保留官方來源工具。
2. 金融股 Revenue／EPS 不宜自動 fallback 或拼接 TradingView 與 mopsfin，需保留 metric definition、period、unit、source 及 data vintage。
3. 量能策略不能把兩邊 volume 當同一序列，尤其 TWSE 樣本已有大幅差異。
4. 長期季財務、官方附註、金融業口徑與公司行動證據仍是 mopsfin 的差異。
5. 不應因 TradingView 能找到商品，就宣稱行情、財務、預估、文件等全部工具都有覆蓋；本報告也沒有測試全市場、共識、月營收或盤中資料。
6. 欲證明完整可替換，下一輪需先取得金融股 OHLC 的穩定回應，再針對股票股利、拆股、減資三類各選事件核對；同時對富邦歷史 EPS 作逐科目／重編版本調節。本次證據不足的部分保留未確認。

## 參考資料

- [TradingView MCP 官方文件](https://www.tradingview.com/mcp/docs)
- [TradingView：財務資料標準化與其他來源差異](https://www.tradingview.com/support/solutions/43000540145-why-does-financial-data-differ-from-other-sources/)
- [TradingView：銀行業 net revenue 與 total revenue](https://www.tradingview.com/support/solutions/43000699487-revenue-breakdown-by-source/)
- [富邦：2026 起 IFRS 17 與金融資產處理變動](https://www.fubon.com/financialholdings/news/news_1260213_966609.htm)
- mopsfin README、lib/mopsfin/guidance.ts，以及 evidence.json 內逐筆官方來源 URL。

