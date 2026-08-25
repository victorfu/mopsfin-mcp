import type { MetricDefinition } from "./types";

export const MOPSFIN_SERVER_INSTRUCTIONS = `
這是一個公開、唯讀、無資料庫的台灣公司財務與價格資料 MCP Server。公司財務、報表、附註、產業與金融機構資料在查詢時直接取自「公開資訊觀測站－財務比較 E 點通（Mopsfin）」；上市櫃公司母體與 OHLC 價格直接取自 TWSE 與 TPEx 官方資料。

使用順序：需要完整上市櫃母體或全市場掃描代號時先呼叫 list_companies；只知道特定公司名稱或代號時使用 find_companies。不要用 find_companies 枚舉全市場。list_companies 的 market=listed 只回上市（含創新板）、market=otc 只回上櫃、market=all 回兩者全部；include_financial=false 或 include_ky=false 可排除金融保險業或 KY 公司。查單一股票跨期歷史價格使用 get_stock_ohlc；查同一交易日的完整市場或一批代號使用 get_daily_market_ohlc。不知道 metric_code、industry_codes、institution_codes 或可用期別時先呼叫 list_catalog。list_catalog 也會回傳官方資料範圍、各指標公式、值的計算基礎與適用限制，回答前應讀取相關 guidance。

公司母體：list_companies 只列 TWSE／TPEx 公司普通股母體，不含 ETF、ETN、權證、特別股與 TDR。上市來源的 TDR 會固定排除，因為 Mopsfin 不涵蓋 TDR。market=all 只有在上市與上櫃兩個必要來源都成功，且各來源通過單一出表日期與最低筆數完整性檢查時才回傳 coverageComplete=true；應保留 sources、各自 reportDate、snapshotId、counts 與 warnings。公司列在母體只表示目前屬上市櫃公司，不保證每個 Mopsfin 指標或期別都有資料。

價格資料：兩個 OHLC 工具只回官方原始未還原權值日線，priceBasis=raw_unadjusted、幣別 TWD、時區 Asia/Taipei、interval=1d，不提供盤中即時價、adjusted close、成交量或成交金額。get_stock_ohlc 每頁最多處理 12 個月份；coverageComplete=false 時必須用 nextCursor 續查，不能把局部頁面描述成完整 requested range。TWSE 個股月資料自 2010-01-04、TPEx 自 1994-01-01 起；可探測已下市櫃代號並合併上櫃轉上市月份。get_daily_market_ohlc 的 latest 是最近完成交易日；market=all 要求兩市場日期一致，指定假日或未來日不退回其他日期。null/no_trade 不可改寫為 0。

資料範圍：涵蓋上市、上櫃、興櫃、公開發行公司，以及依法申報財報的未公開發行金融業；不含 TDR 發行公司。資料為採用 IFRSs 後的財務資訊，上市、上櫃、興櫃及金管會主管金融業通常自 2013 年起，公開發行公司通常自 2015 年起，特殊情況依實際採用 IFRSs 年度。

申報頻率：上市及上櫃公司通常有 Q1–Q4；興櫃及公開發行公司通常只有 Q2、Q4；部分公司只需申報年度。不同公司可用期別不同，NO_DATA 或 null 不代表公司不存在，也不可推論為 0。財報附註並非所有市場別都強制申報。

數值解讀：綜合損益表與現金流量表是各季累計；quarterly 是 Mopsfin 的單季口徑，上市櫃 Q4 通常由全年累計減 Q3 累計，興櫃／公開發行 Q2 通常是前兩季累計、Q4 通常由全年累計減 Q2 累計；cumulative_yoy 是指定季度的累計同比，必須提供 yoy_quarter。產業統計是各季累計，產業趨勢同時涉及單季與累計口徑。比較不同公司或期間前，務必確認 unit、periods、basis、warnings 與 metric guidance。

平均數：公司指標的所選公司平均數是所選公司的簡單平均，產業平均數是依產業分類計算的上市與上櫃公司指標平均。金融機構指標可另外要求相應金控／銀行／票券業的產業平均，以及本次所選機構的簡單平均。所有平均數都由 Mopsfin 計算，不是市值加權；應依 series.label 分辨個別公司／機構與平均 series。

更新與責任：Mopsfin 每日更新一次，可能較公開資訊觀測站最新申報落後約一日；公司母體應以 list_companies 的各來源 reportDate、價格應以 OHLC 工具的 dataDate／coverage／sources 為準。本服務不是臺灣證券交易所或證券櫃檯買賣中心的官方 MCP，也不構成投資建議；重要判斷應回查官方公司名錄、行情與公開資訊觀測站原始申報。

錯誤語意：INVALID_ARGUMENT 表示參數不合法；NOT_FOUND 表示代號不在即時目錄；NO_DATA 表示該條件／期別無可用資料；UPSTREAM_TIMEOUT、UPSTREAM_RATE_LIMITED、UPSTREAM_BAD_RESPONSE 分別表示上游逾時、限流或格式／服務異常。
`.trim();

export const MOPSFIN_OFFICIAL_GUIDANCE = {
  sourceScope: [
    "公司範圍包含上市、上櫃、興櫃、公開發行公司，以及依法需在公開資訊觀測站申報財報的未公開發行金融業。",
    "不包含發行 TDR（臺灣存託憑證）的公司。",
    "提供各公司採用 IFRSs 後的財務資訊；上市、上櫃、興櫃及金管會主管金融業通常自 2013 年起，公開發行公司通常自 2015 年起，特殊情況依實際採用 IFRSs 年度。",
  ],
  filingCadence: [
    {
      companyType: "上市及上櫃公司",
      availableQuarters: ["Q1", "Q2", "Q3", "Q4"],
      note: "通常一年申報四次。",
    },
    {
      companyType: "興櫃及公開發行公司",
      availableQuarters: ["Q2", "Q4"],
      note: "通常一年申報兩次，因此 Q1、Q3 查無資料可能是正常情況。",
    },
    {
      companyType: "其他依法僅需申報年度財報的公司",
      availableQuarters: ["Q4"],
      note: "可能只有年度資料。",
    },
  ],
  reportAvailability: [
    "上市、上櫃、興櫃公司，以及部分金融機構通常申報四大報表與財報附註。",
    "公開發行公司及其他未公開發行金融業通常只強制申報四大報表，附註屬自願申報，因此查無附註不代表公司不存在。",
  ],
  updateCadence:
    "Mopsfin 資料庫每日更新一次，與公開資訊觀測站公司最新申報可能有約一日時間差。",
  valueBasis: [
    {
      dataType: "綜合損益表與現金流量表",
      basis: "報表為各季累計金額。",
    },
    {
      dataType: "公司趨勢 quarterly",
      basis:
        "代表 Mopsfin 的單季口徑。上市櫃 Q1–Q3 為公司申報單季值，Q4 通常以全年累計減 Q3 累計；興櫃／公開發行 Q2 通常為前兩季累計，Q4 通常以全年累計減 Q2 累計。",
    },
    {
      dataType: "公司趨勢 cumulative_yoy",
      basis: "代表指定 yoy_quarter 的累計金額或比率之年增比較，不是任意滾動 12 個月。",
    },
    {
      dataType: "產業統計",
      basis: "營業收入與稅後純益皆為各季累計金額。",
    },
    {
      dataType: "產業趨勢",
      basis: "營業收入與稅後純益提供單季及累計口徑；回覆時應依 periods、series 與上游標示說明。",
    },
    {
      dataType: "金融業資產品質與資本適足性",
      basis: "為累計／期末申報口徑；資本適足性通常只有 Q2、Q4 需要申報。",
    },
  ],
  averages: [
    {
      name: "所選公司平均數",
      method: "對使用者選定的公司採簡單平均，不是市值加權。",
    },
    {
      name: "產業平均數",
      method:
        "依 Mopsfin 產業分類計算該產業上市與上櫃公司的指標平均；不代表興櫃、公開發行或所有公司的整體平均。",
    },
    {
      name: "金融機構所選機構平均數",
      method:
        "對本次 institution_codes 選定的金融機構採簡單平均；Mopsfin 回應通常以「公司平均數」標示，不是市值加權。",
    },
    {
      name: "金融業別產業平均數",
      method:
        "由 Mopsfin 依指標相應的金控、銀行或票券業母體計算；回應標籤可能是業別指標名稱，不一定直接包含「平均數」。",
    },
  ],
  interpretationNotes: [
    "不同市場別與公司有不同申報季度；NO_DATA 或 null 可能表示未到申報期、不適用或未申報，不可當成 0。",
    "營業收入跨業別對應可能是一般行業的營業收入、金融業／金控的淨收益、證券期貨業的收益或異業合併的收入。",
    "營業利益跨業別對應可能是營業利益或稅前淨利；營業毛利不適用金融、保險、證券期貨、金控與異業合併。",
    "部分季報比率由財報數據依公式計算，年度數字可能引用公司申報的財務分析資料；跨期間比較前應確認口徑。",
    "MCP 回傳的 unit、periods、query、warnings 與 metric guidance 都是答案的一部分，不應只取裸數值。",
  ],
} as const;

export interface MetricGuidance {
  meaning: string;
  calculation: string | null;
  valueBasis: string;
  applicability: string;
  caveats: string[];
}

const NOT_APPLICABLE_TO_FINANCE =
  "金融業、保險業、金控業及異業合併不適用。";
const NOT_APPLICABLE_TO_FINANCE_SECURITIES =
  "金融業、保險業、證券期貨業、金控業及異業合併不適用。";
const QUARTER_CALCULATED_ANNUAL_REPORTED =
  "季報數字通常依財報資料與官方公式計算；年度數字可能引用公司在公開資訊觀測站申報的財務分析資料。";

const FORMULAS: Record<
  string,
  Pick<MetricGuidance, "meaning" | "calculation" | "applicability"> & {
    caveats?: string[];
  }
> = {
  每股淨值: {
    meaning: "每股普通股可歸屬的母公司業主權益。",
    calculation:
      "（權益－非控制權益）÷（普通股股數＋權益項下特別股股數＋預收股款約當發行股數－母子公司持有之母公司庫藏股股數－待註銷股本股數）",
    applicability: "依公司股本與權益結構計算。",
  },
  負債佔資產比率: {
    meaning: "衡量資產由負債支應的比例。",
    calculation: "（負債總額 ÷ 資產總額）× 100%",
    applicability: "一般公司財務結構指標。",
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  長期資金比率: {
    meaning: "長期資金支應不動產、廠房及設備的程度。",
    calculation:
      "（權益總額＋非流動負債）÷ 不動產、廠房及設備淨額 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  長期資金佔不動產廠房及設備比率: {
    meaning: "長期資金支應不動產、廠房及設備的程度。",
    calculation:
      "（權益總額＋非流動負債）÷ 不動產、廠房及設備淨額 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  流動比率: {
    meaning: "衡量流動資產償付流動負債的能力。",
    calculation: "（流動資產 ÷ 流動負債）× 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  速動比率: {
    meaning: "排除存貨與預付款後的短期償債能力。",
    calculation: "（流動資產－存貨－預付款項）÷ 流動負債 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  利息保障倍數: {
    meaning: "衡量獲利覆蓋利息支出的倍數。",
    calculation: "所得稅及利息費用前純益 ÷ 本期利息支出",
    applicability: "依財報可取得的利息支出計算。",
  },
  應收款項週轉率: {
    meaning: "衡量應收款項轉換為現金的速度。",
    calculation: "銷貨淨額 ÷ 平均應收款項餘額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  平均收現日數: {
    meaning: "估計應收款項平均需要幾天收現。",
    calculation:
      "季報 90 天 ÷ 應收款項週轉率；半年報 180 天 ÷ 應收款項週轉率；年報 365 天 ÷ 應收款項週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  應收款項收現日數: {
    meaning: "估計應收款項平均需要幾天收現。",
    calculation:
      "季報 90 天 ÷ 應收款項週轉率；半年報 180 天 ÷ 應收款項週轉率；年報 365 天 ÷ 應收款項週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  存貨週轉率: {
    meaning: "衡量存貨被銷售與補充的速度。",
    calculation: "銷貨成本 ÷ 平均存貨餘額",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  平均銷貨日數: {
    meaning: "估計存貨平均需要幾天售出。",
    calculation:
      "季報 90 天 ÷ 存貨週轉率；半年報 180 天 ÷ 存貨週轉率；年報 365 天 ÷ 存貨週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  平均售貨日數: {
    meaning: "估計存貨平均需要幾天售出。",
    calculation:
      "季報 90 天 ÷ 存貨週轉率；半年報 180 天 ÷ 存貨週轉率；年報 365 天 ÷ 存貨週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  總資產週轉率: {
    meaning: "衡量資產產生銷貨收入的效率。",
    calculation: "銷貨淨額 ÷ 平均資產總額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  毛利率: {
    meaning: "每單位營業收入保留為毛利的比例。",
    calculation: "（營業毛利 ÷ 營業收入）× 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業利益率: {
    meaning: "每單位營業收入產生營業利益的比例。",
    calculation: "（營業利益 ÷ 營業收入）× 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  稅後純益率: {
    meaning: "每單位營業收入轉化為稅後純益的比例。",
    calculation: "（稅後純益 ÷ 營業收入）× 100%",
    applicability: "依跨業別對應後的營業收入計算。",
  },
  資產報酬率: {
    meaning: "衡量平均資產創造稅後純益的能力。",
    calculation: "（稅後純益 ÷ 平均資產總額）× 100%",
    applicability: "一般獲利能力指標。",
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  權益報酬率: {
    meaning: "衡量平均權益創造稅後純益的能力。",
    calculation: "（稅後純益 ÷ 平均權益總額）× 100%",
    applicability: "一般獲利能力指標。",
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  營業收入年增率: {
    meaning: "本期營業收入相對去年同期的變動百分比。",
    calculation:
      "（本期營業收入－去年同期營業收入）÷ 去年同期營業收入 × 100%",
    applicability: "跨業別會依官方對應採用淨收益、收益或收入。",
  },
  營業毛利年增率: {
    meaning: "本期營業毛利相對去年同期的變動百分比。",
    calculation:
      "（本期營業毛利－去年同期營業毛利）÷ 去年同期營業毛利 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業利益年增率: {
    meaning: "本期營業利益相對去年同期的變動百分比。",
    calculation:
      "（本期營業利益－去年同期營業利益）÷ 去年同期營業利益 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  稅後純益年增率: {
    meaning: "本期稅後純益相對去年同期的變動百分比。",
    calculation:
      "（本期稅後純益－去年同期稅後純益）÷ 去年同期稅後純益 × 100%",
    applicability: "適用於有可比較去年同期資料的公司。",
  },
  每股盈餘年增率: {
    meaning: "本期每股盈餘相對去年同期的變動百分比。",
    calculation:
      "（本期每股盈餘－去年同期每股盈餘）÷ 去年同期每股盈餘 × 100%",
    applicability: "適用於有可比較去年同期每股盈餘的公司。",
  },
  營業現金對流動負債比: {
    meaning: "營業活動現金流量相對流動負債的比率。",
    calculation: "營業活動淨現金流量 ÷ 流動負債",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  營業現金對負債比: {
    meaning: "營業活動現金流量相對總負債的比率。",
    calculation: "營業活動淨現金流量 ÷ 負債總額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業現金流對負債比: {
    meaning: "營業活動現金流量相對總負債的比率。",
    calculation: "營業活動淨現金流量 ÷ 負債總額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業現金對稅後純益比: {
    meaning: "營業活動現金流量相對稅後純益的倍數。",
    calculation: "營業活動淨現金流量 ÷ 稅後純益",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業現金流對稅後淨利比: {
    meaning: "營業活動現金流量相對稅後純益的倍數。",
    calculation: "營業活動淨現金流量 ÷ 稅後純益",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  放款業務逾放比率: {
    meaning: "逾期放款占放款總額的比率。",
    calculation: "逾期放款 ÷ 放款總額",
    applicability: "僅銀行業適用。",
  },
  放款備抵呆帳覆蓋率: {
    meaning: "放款備抵呆帳對逾放金額的覆蓋程度。",
    calculation: "放款所提列備抵呆帳金額 ÷ 逾放金額",
    applicability: "僅銀行業適用。",
  },
  放款業務備抵呆帳覆蓋率: {
    meaning: "放款備抵呆帳對逾放金額的覆蓋程度。",
    calculation: "放款所提列備抵呆帳金額 ÷ 逾放金額",
    applicability: "僅銀行業適用。",
  },
  信用卡逾期帳款比率: {
    meaning: "信用卡逾期帳款占應收帳款餘額的比率。",
    calculation: "逾期帳款 ÷ 應收帳款餘額",
    applicability: "僅有相關信用卡業務且依法申報的銀行適用。",
  },
  信用卡備抵呆帳覆蓋率: {
    meaning: "信用卡應收款備抵呆帳對逾期帳款的覆蓋程度。",
    calculation: "信用卡應收帳款備抵呆帳金額 ÷ 逾期帳款金額",
    applicability: "僅有相關信用卡業務且依法申報的銀行適用。",
  },
  信用卡應收帳款備抵呆帳覆蓋率: {
    meaning: "信用卡應收款備抵呆帳對逾期帳款的覆蓋程度。",
    calculation: "信用卡應收帳款備抵呆帳金額 ÷ 逾期帳款金額",
    applicability: "僅有相關信用卡業務且依法申報的銀行適用。",
  },
  應收帳款承購逾期比率: {
    meaning: "無追索權應收帳款承購業務的逾期帳款比率。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  無追索權應收帳款承購之逾期帳款比率: {
    meaning: "無追索權應收帳款承購業務的逾期帳款比率。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  應收帳款承購覆蓋率: {
    meaning: "無追索權應收帳款承購業務的備抵呆帳覆蓋程度。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  無追索權應收帳款承購之備抵呆帳覆蓋率: {
    meaning: "無追索權應收帳款承購業務的備抵呆帳覆蓋程度。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  金控業集團資本適足率: {
    meaning: "衡量金融控股集團合格資本對法定資本需求的覆蓋程度。",
    calculation: "集團合格資本淨額 ÷ 集團法定資本需求",
    applicability: "僅金控業適用，通常只有 Q2、Q4 申報。",
  },
  銀行業資本適足率: {
    meaning: "衡量銀行自有資本相對風險性資產的充足程度。",
    calculation:
      "自有資本 ÷ 加權風險性資產總額；自有資本＝普通股權益＋其他第一類資本＋第二類資本；風險性資產包含信用風險及作業／市場風險資本計提。",
    applicability: "僅銀行業適用，通常只有 Q2、Q4 申報。",
  },
  票券業資本適足率: {
    meaning: "衡量票券業合格自有資本相對風險性資產的充足程度。",
    calculation: "合格自有資本 ÷ 加權風險性資產總額",
    applicability: "僅票券業適用，通常只有 Q2、Q4 申報。",
  },
};

function normalizedName(name: string): string {
  return name
    .replace(/[\s、，,（）()／/]/g, "")
    .replace(/之/g, "之")
    .trim();
}

function familyGuidance(metric: MetricDefinition): MetricGuidance {
  switch (metric.family) {
    case "report":
      return {
        meaning: `完整的${metric.name}表格。`,
        calculation: null,
        valueBasis: /綜合損益|現金流量/.test(metric.name)
          ? "各季累計金額；不是單季金額。"
          : "指定期末的資產、負債與權益餘額。",
        applicability: "可取得內容依公司市場別依法需申報的格式化財報而異。",
        caveats: ["回答時應保留報表 unit 與 period，並留意表格分頁。"],
      };
    case "xb":
      return {
        meaning: `財務報表附註：${metric.name}。`,
        calculation: null,
        valueBasis: "指定期別公司申報的格式化財報附註。",
        applicability:
          "上市、上櫃、興櫃及部分金融機構通常需申報；公開發行公司及部分未公開發行金融業的附註屬自願申報，因此可能未申報。",
        caveats: ["NO_DATA 可能是該公司不必申報或選定期別未申報。"],
      };
    case "bcode":
      return {
        meaning: `${metric.name}的營業收入或稅後純益資料。`,
        calculation: null,
        valueBasis: /統計/.test(metric.name)
          ? "各季累計金額。"
          : "提供產業單季與累計趨勢，需依查詢模式與回傳期別解讀。",
        applicability: "依 Mopsfin 即時列出的產業分類查詢。",
        caveats: ["產業分類與成分可能調整；請使用即時 catalog 的 industry_codes。"],
      };
    case "fin":
      return {
        meaning: `${metric.name}的金融業資產品質指標。`,
        calculation: null,
        valueBasis: "引用財報附註「資產品質」的累計／期末申報資料。",
        applicability:
          "僅銀行業適用；部分非上市櫃金控子公司的公開發行銀行依法可能不需申報。",
        caveats: ["NO_DATA 或 null 可能是不適用或依法不需申報，不可當成 0。"],
      };
    case "adequacy":
      return {
        meaning: `${metric.name}的資本適足性指標。`,
        calculation: null,
        valueBasis: "引用財報附註「資本適足性」，通常只有 Q2、Q4 申報。",
        applicability: "依指標分別只適用金控、銀行或票券業。",
        caveats: ["部分公開發行公司依法不需申報，因此可能無資料。"],
      };
    case "data":
      return {
        meaning: `${metric.category || "公司財務"}中的「${metric.name}」指標。`,
        calculation: null,
        valueBasis:
          "依 quarterly（Mopsfin 單季口徑）或 cumulative_yoy（指定季度累計同比）查詢。",
        applicability: "實際適用性依公司業別與指標定義而異。",
        caveats: ["請同時檢查 unit、basis、periods 與 warnings。"],
      };
  }
}

export function metricGuidance(metric: MetricDefinition): MetricGuidance {
  const fallback = familyGuidance(metric);
  const formula = FORMULAS[normalizedName(metric.name)];
  if (!formula) return fallback;

  return {
    meaning: formula.meaning,
    calculation: formula.calculation,
    valueBasis: fallback.valueBasis,
    applicability: formula.applicability,
    caveats: [...fallback.caveats, ...(formula.caveats ?? [])],
  };
}

function unique(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
}

export function companyMetricWarnings(
  metric: MetricDefinition,
  basis: "quarterly" | "cumulative_yoy",
  includeIndustryAverage: boolean,
  includeCompanyAverage: boolean,
): string[] {
  const guidance = metricGuidance(metric);
  const warnings = [
    basis === "quarterly"
      ? "quarterly 是 Mopsfin 單季口徑；上市櫃 Q4 通常以全年累計減 Q3，興櫃／公開發行 Q2 通常為前兩季累計、Q4 通常以全年累計減 Q2。"
      : "cumulative_yoy 是指定 yoy_quarter 的累計同比口徑，不是單季同比或滾動 12 個月。",
    ...guidance.caveats,
  ];
  if (includeIndustryAverage) {
    warnings.push(
      "產業平均是該產業上市與上櫃公司的指標平均，不是市值加權，也不涵蓋所有市場別。",
    );
  }
  if (includeCompanyAverage) {
    warnings.push("所選公司平均是本次選定公司的簡單平均，不是市值加權。");
  }
  return unique(warnings);
}

export function statementWarnings(statement: string): string[] {
  return unique([
    /income_statement|cash_flow/.test(statement)
      ? "綜合損益表與現金流量表為各季累計金額，不是單季金額。"
      : "資產負債表為指定期末的存量資料。",
    "不同市場別與公司申報季度不同；找不到某季不代表公司不存在。",
  ]);
}

export function noteWarnings(): string[] {
  return [
    "公開發行公司及部分未公開發行金融業的財報附註可能屬自願申報；NO_DATA 不代表公司不存在。",
    "附註內容與欄位依公司市場別、業別及申報格式而異。",
  ];
}

export function industryWarnings(mode: "statistics" | "trend"): string[] {
  return [
    mode === "statistics"
      ? "產業統計的營業收入與稅後純益為各季累計金額。"
      : "產業趨勢涉及單季與累計口徑；回答時應清楚標示所採口徑與期別。",
    "產業分類依 Mopsfin／交易所分類；產業成分與分類可能調整。",
  ];
}

export function financialInstitutionWarnings(
  family: "fin" | "adequacy",
  includeIndustryAverage = false,
  includeInstitutionAverage = false,
): string[] {
  const warnings = family === "adequacy"
    ? [
        "資本適足率僅適用相對應的金控、銀行或票券業，且通常只有 Q2、Q4 申報。",
        "部分公開發行機構依法不需申報；NO_DATA 或 null 不可解讀為 0。",
      ]
    : [
        "金融業資產品質指標僅銀行業適用，資料來自財報附註「資產品質」。",
        "部分公開發行銀行依法不需申報；NO_DATA 或 null 不可解讀為 0。",
      ];

  if (includeIndustryAverage) {
    warnings.push(
      "產業平均由 Mopsfin 依指標相應的金控、銀行或票券業母體計算，不是市值加權；series 標籤可能顯示業別指標名稱而不直接寫「平均數」。",
    );
  }
  if (includeInstitutionAverage) {
    warnings.push(
      "所選機構平均是本次 institution_codes 所選金融機構的簡單平均，不是市值加權；上游 series 通常標示為「公司平均數」。",
    );
  }
  return unique(warnings);
}

export function mergeWarnings(...groups: string[][]): string[] {
  return unique(groups.flat());
}
