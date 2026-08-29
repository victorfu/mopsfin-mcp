import { z } from "zod";

import {
  OBSERVED_PRICE_REQUIRED_QUALITY_ISSUE_CODES,
  observedPriceFreshnessDetailsMatch,
  observedPriceMetaContract,
} from "../observed-price-meta-contract";

import {
  calendarDateSchema,
  sourceCacheObservationSchema,
  successResultShape,
  yearMonthSchema,
} from "./common";

const OFFSET_ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const OBSERVED_YEAR_SUPPORTED_FROM = 1900;
const CONSERVATIVE_SESSION_COMPLETION_TAIPEI = "13:33:00";

interface ParsedOffsetIso {
  timestampMs: number;
  taipeiDate: string;
}

function taipeiDate(timestampMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseOffsetIso(value: string): ParsedOffsetIso | null {
  const match = OFFSET_ISO_DATE_TIME.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < OBSERVED_YEAR_SUPPORTED_FROM) return null;
  const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const hours = Number(match[10]);
    const minutes = Number(match[11]);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
      return null;
    }
    if (match[9] === "-" && hours === 0 && minutes === 0) return null;
    offsetMinutes =
      (match[9] === "+" ? 1 : -1) * (hours * 60 + minutes);
  }
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const timestampMs =
    Date.UTC(
      year,
      month - 1,
      day,
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      milliseconds,
    ) -
    offsetMinutes * 60_000;
  return Number.isFinite(timestampMs)
    ? { timestampMs, taipeiDate: taipeiDate(timestampMs) }
    : null;
}

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3])
  );
}

function completionMs(dataDate: string): number {
  return Date.parse(
    `${dataDate}T${CONSERVATIVE_SESSION_COMPLETION_TAIPEI}+08:00`,
  );
}

function round(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function officialSingleStockSourceUrlMatches(value: {
  sourceUrl: string;
  market: "listed" | "otc";
  companyCode: string;
  dataMonth: string;
}): boolean {
  let url: URL;
  try {
    url = new URL(value.sourceUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  const [year, month] = value.dataMonth.split("-");
  if (value.market === "listed") {
    return (
      url.hostname === "www.twse.com.tw" &&
      url.pathname === "/rwd/zh/afterTrading/STOCK_DAY" &&
      [...url.searchParams.keys()].sort().join(",") ===
        "date,response,stockNo" &&
      url.searchParams.get("date") === `${year}${month}01` &&
      url.searchParams.get("stockNo") === value.companyCode &&
      url.searchParams.get("response") === "json"
    );
  }
  return (
    url.hostname === "www.tpex.org.tw" &&
    url.pathname === "/www/zh-tw/afterTrading/tradingStock" &&
    [...url.searchParams.keys()].sort().join(",") === "code,date,response" &&
    url.searchParams.get("code") === value.companyCode &&
    url.searchParams.get("date") === `${year}/${month}/01` &&
    url.searchParams.get("response") === "json"
  );
}

const offsetIsoSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => parseOffsetIso(value) !== null, {
    message:
      "必須是年份不早於 1900、含明確 Z 或 UTC offset 的有效 ISO 8601 日期時間",
  })
  .describe("含明確 Z 或 UTC offset、可無歧義轉換成 UTC instant 的 ISO 8601 時間");

const realCalendarDateSchema = calendarDateSchema
  .refine(isRealCalendarDate, "必須是有效的西元日曆日期")
  .describe("經日曆有效性核對的 YYYY-MM-DD 日期");

const marketSchema = z
  .enum(["listed", "otc"])
  .describe("目前公司 master 核對後的市場：listed=TWSE、otc=TPEx");

const exchangeSchema = z
  .enum(["TWSE", "TPEx"])
  .describe("目前公司所屬的官方交易市場機構");

export const analyzeObservedPriceInputSchema = z
  .object({
    company_code: z
      .string()
      .regex(/^\d{4}$/)
      .describe("目前上市櫃公司 master 中的單一四碼公司股票代號"),
    observed_price_twd: z
      .number()
      .finite()
      .positive()
      .describe("caller 提供且大於 0 的有限 TWD 觀察價格；不是官方報價"),
    observed_at: offsetIsoSchema.describe(
      "caller 實際觀察價格的時間；必須明示 Z 或 UTC offset，且 core 會拒絕未來時間",
    ),
    source_label: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("caller 對觀察價格來源的非空標籤，最多 200 個字元"),
  })
  .strict()
  .describe("分析 caller-supplied 價格相對官方最近完成交易日收盤價的輸入");

const sourceIdSchema = z
  .string()
  .min(1)
  .max(500)
  .describe("本結果內唯一且可由 stage、市場與資料日期重建的來源識別碼");

const observedSourceCacheSchema = sourceCacheObservationSchema
  .safeExtend({
    observedAt: offsetIsoSchema.describe(
      "此 caller 觀察 cache 狀態的 acquisition-layer 時間",
    ),
    storedAt: offsetIsoSchema
      .nullable()
      .describe("cached upstream value 的儲存時間；未儲存時為 null"),
  })
  .superRefine((cache, context) => {
    const stored =
      cache.status === "hit" ||
      cache.status === "miss" ||
      cache.status === "shared";
    if (stored) {
      if (
        cache.storedAt === null ||
        cache.ageMs === null ||
        cache.ttlMs === null ||
        cache.ttlMs <= 0
      ) {
        context.addIssue({
          code: "custom",
          path: [],
          message:
            "hit/miss/shared 必須有 storedAt、非負 ageMs 與正數 ttlMs",
        });
      }
      return;
    }
    if (cache.storedAt !== null || cache.ageMs !== null) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "未儲存的 cache status 必須使用 storedAt=null 與 ageMs=null",
      });
    }
    if (cache.status === "bypass" && cache.ttlMs !== 0) {
      context.addIssue({
        code: "custom",
        path: ["ttlMs"],
        message: "bypass 的 ttlMs 必須為 0",
      });
    }
    if (
      (cache.status === "not_applicable" || cache.status === "unknown") &&
      cache.ttlMs !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["ttlMs"],
        message: "not_applicable/unknown 的 ttlMs 必須為 null",
      });
    }
  })
  .describe(
    "具明確 observation time、status/null coherence 與可重算 age 的 caller-specific cache provenance",
  );

const companyMasterSourceSchema = z
  .object({
    sourceId: sourceIdSchema.describe("格式為 company_master:{market}:{reportDate} 的來源識別碼"),
    stage: z
      .literal("company_master")
      .describe("此來源只用於目前公司 identity 與市場核對"),
    market: marketSchema.describe("此公司 master source 負責的市場"),
    exchange: exchangeSchema.describe("提供此公司 master 的官方市場機構"),
    sourceName: z.string().min(1).describe("官方公司基本資料集名稱"),
    sourceUrl: z.string().url().describe("本次取得公司 master 的官方固定 URL"),
    reportDate: realCalendarDateSchema.describe("官方公司 master 的實際出表日期"),
    retrievedAt: offsetIsoSchema.describe("真正取得此公司 master source 的時間，不以 generatedAt 代填"),
    rawCount: z
      .number()
      .int()
      .nonnegative()
      .describe("此市場排除 TDR 前的官方原始資料列數"),
    excludedTdrCount: z
      .number()
      .int()
      .nonnegative()
      .describe("此公司 master source 排除的 TDR 資料列數"),
    companyCount: z
      .number()
      .int()
      .nonnegative()
      .describe("此市場排除 TDR 後的公司資料列數"),
    minimumExpectedCount: z
      .number()
      .int()
      .positive()
      .describe("偵測官方回應截斷的最低公司筆數 heuristic"),
    cache: observedSourceCacheSchema.describe(
      "公司 master source 的必要 caller-specific cache provenance",
    ),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.rawCount !== source.companyCount + source.excludedTdrCount) {
      context.addIssue({
        code: "custom",
        path: ["rawCount"],
        message: "rawCount 必須等於 companyCount + excludedTdrCount",
      });
    }
    if (source.companyCount < source.minimumExpectedCount) {
      context.addIssue({
        code: "custom",
        path: ["companyCount"],
        message: "companyCount 不得低於 minimumExpectedCount",
      });
    }
  })
  .describe("本次唯一核對 caller company identity 的官方 current-master source");

const volumeNormalizationSchema = z
  .object({
    sourceUnit: z
      .enum(["share", "lot"])
      .describe("官方成交量原始單位：股或張"),
    outputUnit: z.literal("share").describe("成交量標準輸出固定為股"),
    multiplier: z
      .union([z.literal(1), z.literal(1000)])
      .describe("share 使用 1、lot 使用 1000 的成交量換算倍率"),
  })
  .strict()
  .refine(
    (value) =>
      (value.sourceUnit === "share" && value.multiplier === 1) ||
      (value.sourceUnit === "lot" && value.multiplier === 1000),
    { path: ["multiplier"], message: "成交量 multiplier 必須與 sourceUnit 一致" },
  )
  .describe("官方成交量轉成 shares 的單位正規化證據");

const turnoverNormalizationSchema = z
  .object({
    sourceUnit: z
      .enum(["TWD", "TWD_thousand"])
      .describe("官方成交金額原始單位：TWD 或 TWD 千元"),
    outputUnit: z.literal("TWD").describe("成交金額標準輸出固定為 TWD"),
    multiplier: z
      .union([z.literal(1), z.literal(1000)])
      .describe("TWD 使用 1、TWD_thousand 使用 1000 的換算倍率"),
  })
  .strict()
  .refine(
    (value) =>
      (value.sourceUnit === "TWD" && value.multiplier === 1) ||
      (value.sourceUnit === "TWD_thousand" && value.multiplier === 1000),
    { path: ["multiplier"], message: "成交金額 multiplier 必須與 sourceUnit 一致" },
  )
  .describe("官方成交金額轉成 TWD 的單位正規化證據");

const tradeCountNormalizationSchema = z
  .object({
    sourceUnit: z.literal("trade").describe("官方成交筆數原始單位固定為 trade"),
    outputUnit: z.literal("trade").describe("成交筆數輸出單位固定為 trade"),
    multiplier: z.literal(1).describe("成交筆數不換算，倍率固定為 1"),
  })
  .strict()
  .describe("官方成交筆數的 identity 單位正規化證據");

const officialCloseSourceSchema = z
  .object({
    sourceId: sourceIdSchema.describe(
      "格式為 official_close:{market}:{selectedBarDate} 的來源識別碼",
    ),
    stage: z
      .literal("latest_official_completed_close")
      .describe("此來源提供官方最近完成交易日的 raw close baseline"),
    companyCode: z
      .string()
      .regex(/^[1-9]\d{3}$/)
      .describe("官方單股 endpoint query 與 outer current master 共同核對的公司代號"),
    market: marketSchema.describe("此 completed-close source 負責的市場"),
    exchange: exchangeSchema.describe("提供單股 completed close 的官方市場機構"),
    sourceName: z.string().min(1).describe("TWSE／TPEx 官方單股月成交資訊資料集名稱"),
    sourceUrl: z.string().url().describe("本次取得 exact single-stock OHLC 的官方 query URL"),
    retrievedAt: offsetIsoSchema.describe("真正取得此 completed-close response 的時間，不以 generatedAt 代填"),
    cache: observedSourceCacheSchema.describe(
      "completed-close source 的必要 caller-specific cache provenance",
    ),
    snapshotIdentity: z
      .literal("verified")
      .describe("官方 response 的 company、market 與 requested month identity 已核對"),
    dataMonth: yearMonthSchema.describe("官方單股 response 經核對的 requested snapshot month"),
    observedName: z.string().min(1).describe("直接由官方單股 response 取得並與 current master 核對的名稱"),
    selectedBarDate: realCalendarDateSchema.describe(
      "從 verified monthly snapshot 選出的唯一 exact completed-session bar date",
    ),
    normalization: z
      .object({
        volumeShares: volumeNormalizationSchema.describe("成交量由官方原始單位轉為 shares 的規則"),
        turnoverTwd: turnoverNormalizationSchema.describe("成交金額由官方原始單位轉為 TWD 的規則"),
        tradeCount: tradeCountNormalizationSchema.describe("成交筆數的標準化規則"),
      })
      .strict()
      .describe("官方價量欄位的完整單位正規化規則"),
  })
  .strict()
  .superRefine((source, context) => {
    if (!officialSingleStockSourceUrlMatches(source)) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message:
          "sourceUrl 必須是對應市場的官方單股 endpoint，且 query company code、month 與 response=json 必須精確一致",
      });
    }
  })
  .describe("具 verified monthly snapshot identity 與 exact selected bar date 的單一官方 completed-close source");

const observedPriceSourceSchema = z
  .discriminatedUnion("stage", [
    companyMasterSourceSchema,
    officialCloseSourceSchema,
  ])
  .describe("本次分析實際使用的 current-master 或 official-close source");

const querySchema = z
  .object({
    companyCode: z.string().regex(/^\d{4}$/).describe("core 正規化後實際查詢的四碼公司代號"),
    observedPriceTwd: z.number().finite().positive().describe("core 接受的 caller-supplied TWD 觀察價格"),
    observedAt: offsetIsoSchema.describe("core 接受的 caller 觀察時間與明確 UTC offset"),
    sourceLabel: z.string().min(1).max(200).describe("trim 後實際採用的 caller source label"),
  })
  .strict()
  .describe("core 正規化後實際執行的 observed-price query");

const companySchema = z
  .object({
    code: z.string().regex(/^\d{4}$/).describe("current master 唯一核對的四碼公司代號"),
    name: z.string().min(1).describe("current master 的公司完整名稱"),
    shortName: z.string().min(1).describe("current master 與官方行情列核對的公司簡稱"),
    market: marketSchema.describe("current master 核對的上市或上櫃市場"),
    exchange: exchangeSchema.describe("current master 核對的 TWSE 或 TPEx 機構"),
  })
  .strict()
  .describe("由 current master 與官方行情列雙重核對的公司 identity");

const provenanceSchema = z
  .object({
    observedPrice: z
      .object({
        evidenceClass: z.literal("CALLER_SUPPLIED").describe("觀察價格證據固定來自 caller"),
        official: z.literal(false).describe("false 表示觀察價格不是官方行情"),
        independentlyVerified: z.literal(false).describe("MopsFin 未獨立驗證 caller 提供的觀察價格"),
        sourceLabel: z.string().min(1).max(200).describe("caller 提供且 trim 後的來源標籤"),
        observedAt: offsetIsoSchema.describe("caller 提供的實際觀察 instant"),
      })
      .strict()
      .describe("caller-supplied 觀察價格的來源與驗證邊界"),
    currentMasterIdentity: z
      .object({
        evidenceClass: z
          .literal("OFFICIAL_MASTER_RAW")
          .describe("公司 identity 固定來自官方 current master"),
        queryMarket: z
          .literal("all")
          .describe("外層 identity resolution 固定查詢 market=all"),
        coverageMarkets: z
          .tuple([
            z.literal("listed").describe("TWSE listed master coverage"),
            z.literal("otc").describe("TPEx otc master coverage"),
          ])
          .describe("固定且有序的兩市場 current-master coverage"),
        companyMarket: marketSchema.describe(
          "指定公司由完整 current master 唯一解析到的市場",
        ),
        sourceIds: z
          .tuple([
            sourceIdSchema.describe("listed current-master sourceId"),
            sourceIdSchema.describe("otc current-master sourceId"),
          ])
          .describe("完整 current-master identity resolution 使用的兩份來源"),
      })
      .strict()
      .describe("market=all current-master identity 與完整兩市場 source lineage"),
    officialBaseline: z
      .object({
        evidenceClass: z.literal("OFFICIAL_MARKET_RAW").describe("baseline 是官方市場 raw value"),
        priceBasis: z.literal("raw_unadjusted").describe("baseline 固定為原始未還原權值收盤價"),
        dataDate: realCalendarDateSchema.describe("baseline 的官方完成交易日"),
        sourceIds: z
          .array(sourceIdSchema.describe("提供 baseline 的 official-close sourceId"))
          .length(1)
          .describe("精確一個 verified official-close source reference"),
      })
      .strict()
      .describe("官方最近完成交易日收盤價的 raw evidence"),
    comparison: z
      .object({
        evidenceClass: z.literal("MOPSFIN_CALC").describe("價差只由兩個明示輸入機械計算"),
        absoluteDifferenceFormula: z
          .literal("observed_price_twd - latest_official_completed_close_twd")
          .describe("TWD 絕對價差的固定可重算公式"),
        percentDifferenceFormula: z
          .literal("(observed_price_twd / latest_official_completed_close_twd - 1) * 100")
          .describe("相對官方 close 百分比價差的固定可重算公式"),
        inputOrigins: z
          .tuple([
            z.literal("CALLER_SUPPLIED").describe("第一個公式輸入是 caller 觀察價格"),
            z.literal("OFFICIAL_MARKET_RAW").describe("第二個公式輸入是官方 raw close"),
          ])
          .describe("固定順序的兩個 comparison input evidence classes"),
      })
      .strict()
      .describe("不含估值判斷的 deterministic 價差計算 lineage"),
  })
  .strict()
  .describe("caller input、官方 baseline 與 MopsFin 計算三層分離的 provenance");
const workBudgetSchema = z
  .object({
    requestedCompanies: z.literal(1).describe("每次固定只分析一家公司"),
    dependencyInvocations: z
      .object({
        orchestrationCompanyMaster: z
          .literal(1)
          .describe("外層 current company-master invocation 固定一次"),
        authoritativeCompletedSessionResolver: z
          .literal(1)
          .describe("authoritative completed-session resolver invocation 固定一次"),
        officialExactSingleStockOhlc: z
          .literal(1)
          .describe("exact single-stock OHLC dependency invocation 固定一次"),
        maximumIncludingNestedDependencies: z
          .literal(3)
          .describe("三個 logical dependency invocations 的固定上限"),
      })
      .strict()
      .describe("不含重複 current-master 或 metadata resolver 的 logical invocation budget"),
    plannedOfficialSourceRequests: z
      .object({
        orchestrationCompanyMasterMarkets: z
          .literal(2)
          .describe("外層 market=all 核對 TWSE 與 TPEx 兩份 master sources"),
        completedSessionResolver: z
          .object({
            actual: z.literal(2).describe("成功解析單一市場固定取得 calendar 與 exact benchmark marker"),
            maximum: z.literal(2).describe("單一市場 resolver 最多兩份 logical official source loads"),
          })
          .strict()
          .describe("單一市場 authoritative completed-session resolver 的 source-load budget"),
        exactSingleStockOhlc: z
          .object({
            actual: z
              .union([z.literal(1), z.literal(2)])
              .describe("initial exact-month load，加上必要時唯一一次 bounded cache refresh"),
            maximum: z.literal(2).describe("exact OHLC 最多 initial + one bounded refresh"),
            cacheRefreshPerformed: z
              .boolean()
              .describe("是否因 current-month cache 缺 expectedAsOf 而失效重取一次"),
          })
          .strict()
          .describe("exact single-stock OHLC initial load 與 bounded cache refresh budget"),
        actualTotal: z
          .union([z.literal(5), z.literal(6)])
          .describe("兩份 master + 兩份 resolver + 一或兩次 exact OHLC logical loads"),
        maximumTotal: z.literal(6).describe("成功路徑的 bounded logical source-load 上限"),
        unitDefinition: z
          .literal("one_logical_official_source_load_before_cache_and_bounded_retry")
          .describe("logical source load 位於 transport retry 之前；有界 cache refresh 另計一個 logical load"),
      })
      .strict()
      .superRefine((value, context) => {
        const expectedExactLoads = value.exactSingleStockOhlc
          .cacheRefreshPerformed
          ? 2
          : 1;
        if (
          value.exactSingleStockOhlc.actual !== expectedExactLoads ||
          value.actualTotal !==
            value.orchestrationCompanyMasterMarkets +
              value.completedSessionResolver.actual +
              value.exactSingleStockOhlc.actual
        ) {
          context.addIssue({
            code: "custom",
            path: ["actualTotal"],
            message:
              "actualTotal 與 exact OHLC loads 必須可由 master、resolver 與 cache refresh evidence 精確重算",
          });
        }
      })
      .describe("包含 resolver 與 bounded exact-OHLC refresh 的實際／最大 source-load budget"),
    priceRoutingPolicy: z
      .literal(
        "authoritative_completed_session_expected_as_of_then_exact_single_stock_ohlc",
      )
      .describe("先解析 expectedAsOf，再只取同日單股 OHLC；不可使用 bulk latest fallback"),
    selectedCompanyIdentityPolicy: z
      .literal("outer_market_all_master_plus_exact_single_stock_source")
      .describe("外層完整 current master 與官方單股 response 的 code/name/market 必須精確一致"),
  })
  .strict()
  .describe("單公司 observed-price authoritative completed-close orchestration budget");

const dependencyLedgerSchema = z
  .tuple([
    z
      .object({
        dependency: z
          .literal("orchestration_company_master")
          .describe("外層 market=all current-master dependency"),
        logicalInvocations: z.literal(1).describe("固定一次 logical invocation"),
        plannedOfficialSourceLoads: z
          .literal(2)
          .describe("固定規劃載入 listed 與 otc 兩份官方 master"),
        sourceEvidence: z
          .literal("exposed")
          .describe("dependency 回傳完整 acquisition source evidence"),
        sourceIds: z
          .tuple([
            sourceIdSchema.describe("listed master sourceId"),
            sourceIdSchema.describe("otc master sourceId"),
          ])
          .describe("外層 market=all dependency 實際回傳的兩份來源"),
      })
      .strict()
      .describe("外層 current-master dependency ledger entry"),
    z
      .object({
        dependency: z
          .literal("authoritative_completed_session_resolver")
          .describe("固定 request-start evaluatedAt 的 authoritative session resolver"),
        logicalInvocations: z.literal(1).describe("固定一次 logical invocation"),
        plannedOfficialSourceLoads: z
          .literal(2)
          .describe("單一市場固定一份 calendar 與一份 exact benchmark marker"),
        sourceEvidence: z
          .literal("exposed_in_meta_resolver_evidence")
          .describe("resolver acquisition evidence 位於 completed-session freshness metadata"),
        sourceIds: z
          .tuple([])
          .describe("resolver sources 不冒用 top-level domain sourceId"),
      })
      .strict()
      .describe("authoritative completed-session resolver ledger entry"),
    z
      .object({
        dependency: z
          .literal("official_exact_single_stock_ohlc")
          .describe("以 resolver expectedAsOf 查詢的 exact single-stock OHLC dependency"),
        logicalInvocations: z.literal(1).describe("固定一次 logical dependency invocation"),
        plannedOfficialSourceLoads: z
          .union([z.literal(1), z.literal(2)])
          .describe("initial load，必要時加唯一一次 bounded cache refresh"),
        sourceEvidence: z
          .literal("exposed")
          .describe("exact OHLC dependency 回傳 acquisition source evidence"),
        sourceIds: z
          .tuple([sourceIdSchema.describe("official completed-close sourceId")])
          .describe("exact OHLC dependency 實際回傳的唯一來源"),
      })
      .strict()
      .describe("exact single-stock completed-close dependency ledger entry"),
  ])
  .describe(
    "依實際執行順序分開 master、resolver 與 exact single-stock OHLC 的完整 ledger",
  );

export const analyzeObservedPriceDataSchema = z
  .object({
    query: querySchema.describe("core 正規化後實際執行的 query"),
    generatedAt: offsetIsoSchema.describe("所有 dependencies 完成後組裝 domain result 的時間"),
    priceOrigin: z.literal("caller_supplied").describe("觀察價格固定由 caller 提供，不是官方 quote"),
    officialBaselineOrigin: z.literal("official_latest_completed_close").describe("比較基準固定為官方最近完成交易日收盤價"),
    company: companySchema.describe("current master 與行情列共同核對的公司 identity"),
    observedPriceTwd: z.number().finite().positive().describe("caller-supplied TWD 觀察價格"),
    observedAt: offsetIsoSchema.describe("caller 觀察價格的明確 instant"),
    observedTaipeiDate: realCalendarDateSchema.describe("observedAt 轉換至 Asia/Taipei 後的日曆日期"),
    sourceLabel: z.string().min(1).max(200).describe("trim 後的 caller source label"),
    latestOfficialCompletedClose: z.number().finite().positive().describe("官方最近完成交易日的正數 raw close"),
    latestOfficialCloseDate: realCalendarDateSchema.describe("官方 raw close 的實際完成交易日"),
    changeFromOfficialCloseTwd: z.number().finite().describe("observed price 減官方 close、四捨五入至六位小數的 TWD 價差"),
    changeFromOfficialClosePercent: z.number().finite().describe("observed price 相對官方 close、四捨五入至六位小數的百分比價差"),
    officialHistoryCutoff: realCalendarDateSchema.describe("官方歷史資料截止日，必須等於 latestOfficialCloseDate"),
    market: marketSchema.describe("本次公司與行情共同核對的市場"),
    exchange: exchangeSchema.describe("本次公司目前所屬的官方市場機構"),
    currency: z.literal("TWD").describe("觀察價、官方 close 與絕對價差的幣別固定為 TWD"),
    timezone: z.literal("Asia/Taipei").describe("市場日期與 session completion guard 的時區"),
    officialPriceBasis: z.literal("raw_unadjusted").describe("官方基準固定為 raw unadjusted close，不是 adjusted close"),
    sources: z
      .array(observedPriceSourceSchema.describe("一份實際使用且具 acquisition-time provenance 的官方 source"))
      .length(3)
      .describe("固定依序包含 listed master、otc master 與一份 verified official completed-close source"),
    provenance: provenanceSchema.describe("caller、official raw 與 deterministic calculation 的分離 lineage"),
    dependencyLedger: dependencyLedgerSchema.describe(
      "logical dependency loads 與 actual source evidence 的分離 ledger",
    ),
    workBudget: workBudgetSchema.describe(
      "精確揭露 master、resolver 與 exact single-stock OHLC 的 bounded source-load budget",
    ),
    warnings: z
      .array(z.string().min(1).describe("不可忽略的來源、時點、價格基礎或非投資建議限制"))
      .min(4)
      .max(10)
      .describe("明示 caller price 非官方／非 real-time、13:33 guard、raw close 與非 fair-value 判斷的警語"),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: "custom", path, message });
    const generated = parseOffsetIso(value.generatedAt);
    const observed = parseOffsetIso(value.observedAt);
    if (!generated || !observed) return;

    if (
      value.query.companyCode !== value.company.code ||
      value.query.companyCode !== value.query.companyCode.trim()
    ) {
      issue(["query", "companyCode"], "query companyCode 必須等於 current-master company code 且不得含空白");
    }
    if (
      value.query.observedPriceTwd !== value.observedPriceTwd ||
      value.query.observedAt !== value.observedAt ||
      value.query.sourceLabel !== value.sourceLabel
    ) {
      issue(["query"], "query 的 caller-supplied fields 必須與頂層正規化欄位完全一致");
    }
    if (value.company.market !== value.market || value.company.exchange !== value.exchange) {
      issue(["company"], "company market/exchange 必須與頂層 identity 一致");
    }
    const expectedExchange = value.market === "listed" ? "TWSE" : "TPEx";
    if (value.exchange !== expectedExchange) {
      issue(["exchange"], "listed 必須對應 TWSE，otc 必須對應 TPEx");
    }
    if (value.observedTaipeiDate !== observed.taipeiDate) {
      issue(["observedTaipeiDate"], "observedTaipeiDate 必須由 observedAt 轉 Asia/Taipei 精確計算");
    }
    if (observed.timestampMs > generated.timestampMs) {
      issue(["observedAt"], "observedAt 不得晚於 generatedAt");
    }
    if (value.officialHistoryCutoff !== value.latestOfficialCloseDate) {
      issue(["officialHistoryCutoff"], "officialHistoryCutoff 必須等於 latestOfficialCloseDate");
    }
    if (value.observedTaipeiDate < value.latestOfficialCloseDate) {
      issue(["observedAt"], "觀察值的台北日期不得早於官方 completed-close 日期");
    } else if (
      value.observedTaipeiDate === value.latestOfficialCloseDate &&
      observed.timestampMs < completionMs(value.latestOfficialCloseDate)
    ) {
      issue(["observedAt"], "同日觀察值不得早於保守的 13:33 Asia/Taipei session completion guard");
    }

    const rawAbsolute = value.observedPriceTwd - value.latestOfficialCompletedClose;
    const rawPercent =
      (value.observedPriceTwd / value.latestOfficialCompletedClose - 1) * 100;
    if (
      !Number.isFinite(rawAbsolute) ||
      !Number.isFinite(rawPercent) ||
      value.changeFromOfficialCloseTwd !== round(rawAbsolute, 6) ||
      value.changeFromOfficialClosePercent !== round(rawPercent, 6) ||
      Object.is(value.changeFromOfficialCloseTwd, -0) ||
      Object.is(value.changeFromOfficialClosePercent, -0)
    ) {
      issue(["changeFromOfficialCloseTwd"], "TWD 與百分比價差必須是可由兩個價格重算的有限六位小數值，且不得為 -0");
    }

    if (value.sources.length !== 3) {
      issue(
        ["sources"],
        "sources 必須精確包含 listed master、otc master 與一份 official close",
      );
      return;
    }
    const [listedMasterSource, otcMasterSource, closeSource] = value.sources;
    if (
      listedMasterSource.stage !== "company_master" ||
      otcMasterSource.stage !== "company_master" ||
      closeSource.stage !== "latest_official_completed_close"
    ) {
      issue(["sources"], "sources 必須依序為 listed master、otc master 與 latest official completed close");
      return;
    }
    if (
      listedMasterSource.market !== "listed" ||
      listedMasterSource.exchange !== "TWSE" ||
      otcMasterSource.market !== "otc" ||
      otcMasterSource.exchange !== "TPEx"
    ) {
      issue(["sources"], "兩份 current-master sources 必須唯一涵蓋 listed/TWSE 與 otc/TPEx；各自 reportDate 可不同");
    }
    if (
      closeSource.companyCode !== value.company.code ||
      closeSource.market !== value.market ||
      closeSource.exchange !== value.exchange ||
      closeSource.selectedBarDate !== value.latestOfficialCloseDate ||
      closeSource.dataMonth !== value.latestOfficialCloseDate.slice(0, 7) ||
      canonicalName(closeSource.observedName) !==
        canonicalName(value.company.shortName)
    ) {
      issue(
        ["sources", 2],
        "official-close source companyCode/market/exchange/month/selectedBarDate/observedName 必須與頂層 baseline 及 company identity 一致",
      );
    }
    const expectedListedMasterId = `company_master:listed:${listedMasterSource.reportDate}`;
    const expectedOtcMasterId = `company_master:otc:${otcMasterSource.reportDate}`;
    const expectedCloseId = `official_close:${closeSource.market}:${closeSource.selectedBarDate}`;
    if (listedMasterSource.sourceId !== expectedListedMasterId) {
      issue(["sources", 0, "sourceId"], "listed master sourceId 必須由 market/reportDate 重建");
    }
    if (otcMasterSource.sourceId !== expectedOtcMasterId) {
      issue(["sources", 1, "sourceId"], "otc master sourceId 必須由 market/reportDate 重建");
    }
    if (closeSource.sourceId !== expectedCloseId) {
      issue(["sources", 2, "sourceId"], "official-close sourceId 必須由 market/selectedBarDate 重建");
    }
    if (new Set(value.sources.map((source) => source.sourceId)).size !== 3) {
      issue(["sources"], "sourceId 不得重複");
    }
    for (const [index, source] of value.sources.entries()) {
      const retrieved = parseOffsetIso(source.retrievedAt);
      if (!retrieved || retrieved.timestampMs > generated.timestampMs) {
        issue(["sources", index, "retrievedAt"], "每個 source retrievedAt 必須是有效時間且不得晚於 generatedAt");
        continue;
      }
      const cacheObserved = parseOffsetIso(source.cache.observedAt);
      const cacheStored = source.cache.storedAt
        ? parseOffsetIso(source.cache.storedAt)
        : null;
      if (!cacheObserved || cacheObserved.timestampMs > generated.timestampMs) {
        issue(["sources", index, "cache", "observedAt"], "cache.observedAt 必須有效且不得晚於 generatedAt");
      } else if (retrieved.timestampMs > cacheObserved.timestampMs) {
        issue(["sources", index, "cache", "observedAt"], "retrievedAt 不得晚於 cache.observedAt");
      }
      if (source.cache.storedAt !== null) {
        if (!cacheStored || !cacheObserved) {
          issue(["sources", index, "cache", "storedAt"], "cache.storedAt 必須是有效時間");
        } else {
          const expectedAgeMs =
            cacheObserved.timestampMs - cacheStored.timestampMs;
          if (
            retrieved.timestampMs > cacheStored.timestampMs ||
            cacheStored.timestampMs > cacheObserved.timestampMs ||
            source.cache.ageMs !== expectedAgeMs
          ) {
            issue(
              ["sources", index, "cache"],
              "必須符合 retrievedAt <= storedAt <= observedAt <= generatedAt，且 ageMs 可精確重算",
            );
          }
        }
      }
      const sourceDate =
        source.stage === "company_master"
          ? source.reportDate
          : source.selectedBarDate;
      if (sourceDate > retrieved.taipeiDate) {
        issue(["sources", index, "retrievedAt"], "source 資料日期不得晚於 retrievedAt 的台北日期");
      }
      if (
        source.stage === "latest_official_completed_close" &&
        sourceDate === retrieved.taipeiDate &&
        retrieved.timestampMs < completionMs(sourceDate)
      ) {
        issue(["sources", index, "retrievedAt"], "同日 official-close source 不得早於 13:33 Asia/Taipei 取得");
      }
    }

    if (
      value.provenance.observedPrice.sourceLabel !== value.sourceLabel ||
      value.provenance.observedPrice.observedAt !== value.observedAt
    ) {
      issue(["provenance", "observedPrice"], "caller provenance 必須與頂層 observation 完全一致");
    }
    const masterSourceIds = [
      listedMasterSource.sourceId,
      otcMasterSource.sourceId,
    ];
    if (
      value.provenance.currentMasterIdentity.companyMarket !== value.market ||
      JSON.stringify(value.provenance.currentMasterIdentity.sourceIds) !==
        JSON.stringify(masterSourceIds)
    ) {
      issue(
        ["provenance", "currentMasterIdentity"],
        "current-master identity provenance 必須依序引用完整 listed 與 otc sources",
      );
    }
    if (
      value.provenance.officialBaseline.dataDate !== value.latestOfficialCloseDate ||
      value.provenance.officialBaseline.sourceIds.length !== 1 ||
      value.provenance.officialBaseline.sourceIds[0] !== closeSource.sourceId
    ) {
      issue(["provenance", "officialBaseline"], "official baseline provenance 必須精確引用唯一 close source");
    }
    const [masterDependency, resolverDependency, priceDependency] =
      value.dependencyLedger;
    if (
      JSON.stringify(masterDependency.sourceIds) !==
        JSON.stringify(masterSourceIds) ||
      resolverDependency.sourceIds.length !== 0 ||
      JSON.stringify(priceDependency.sourceIds) !==
        JSON.stringify([closeSource.sourceId]) ||
      resolverDependency.plannedOfficialSourceLoads !==
        value.workBudget.plannedOfficialSourceRequests.completedSessionResolver
          .actual ||
      priceDependency.plannedOfficialSourceLoads !==
        value.workBudget.plannedOfficialSourceRequests.exactSingleStockOhlc
          .actual
    ) {
      issue(
        ["dependencyLedger"],
        "dependency ledger 必須精確連到 master、resolver metadata 與 exact OHLC source evidence/work budget",
      );
    }
    const warningText = value.warnings.join(" ");
    for (const required of [
      "caller",
      "不是官方報價",
      "13:33",
      "fair value",
      "買賣建議",
      "外層 market=all master",
      "code、name、market 精確核對",
      "expectedAsOf",
      "exact single-stock OHLC",
      "不退回前一日價格",
      "不重複取得 current master",
      "兩市場 reportDate 可不同",
    ]) {
      if (!warningText.includes(required)) {
        issue(["warnings"], `warnings 必須明示 ${required}`);
      }
    }
  })
  .describe("caller-supplied observation 與 verified official completed close 的嚴格、可重算分析結果");

export const analyzeObservedPriceOutputSchema =
  analyzeObservedPriceDataSchema
  .safeExtend(successResultShape)
  .superRefine((value, context) => {
    const officialFreshness = value.meta.quality.freshnessDetails.find(
      (detail) => detail.policyId === "official.completed-session.v1",
    );
    const resolverEvidence = officialFreshness?.resolverEvidence;
    if (!resolverEvidence) {
      context.addIssue({
        code: "custom",
        path: ["meta", "quality", "freshnessDetails"],
        message:
          "observed-price official completed-session freshness 必須嵌入 resolver evidence。",
      });
      return;
    }
    const expectedMeta = observedPriceMetaContract(value, resolverEvidence);
    const resolverEvaluatedAt = parseOffsetIso(resolverEvidence.evaluatedAt);
    const generatedAt = parseOffsetIso(value.generatedAt);
    const observedAt = parseOffsetIso(value.observedAt);
    const resolverMarket = resolverEvidence.marketResolutions[0];
    if (
      resolverEvidence.markets.length !== 1 ||
      resolverEvidence.markets[0] !== value.company.market ||
      resolverEvidence.marketResolutions.length !== 1 ||
      resolverEvidence.marketResolutions[0]?.market !== value.company.market ||
      resolverEvidence.status !== "resolved" ||
      resolverEvidence.expectedAsOf !== value.latestOfficialCloseDate ||
      resolverEvidence.marketResolutions[0]?.status !== "resolved" ||
      resolverEvidence.marketResolutions[0]?.expectedAsOf !==
        value.latestOfficialCloseDate ||
      !resolverEvaluatedAt ||
      !generatedAt ||
      !observedAt ||
      observedAt.timestampMs > resolverEvaluatedAt.timestampMs ||
      resolverEvaluatedAt.timestampMs > generatedAt.timestampMs
    ) {
      context.addIssue({
        code: "custom",
        path: [
          "meta",
          "quality",
          "freshnessDetails",
          "resolverEvidence",
          "markets",
        ],
        message:
          "observed-price resolver evidence 必須只涵蓋 company market，符合 observedAt <= request-start evaluatedAt <= generatedAt，且 resolved expectedAsOf 必須等於公開 close date。",
      });
    }
    const resolverBudget = resolverEvidence.workBudget;
    const marketBudget = resolverMarket?.workBudget;
    const publicResolverBudget =
      value.workBudget.plannedOfficialSourceRequests.completedSessionResolver;
    if (
      resolverBudget.scope !== "freshness_meta_layer" ||
      resolverBudget.marketCount !== 1 ||
      resolverBudget.calendarLogicalLoads !== 1 ||
      resolverBudget.sessionMarkerLogicalLoads !== 1 ||
      resolverBudget.actualTotal !== 2 ||
      resolverBudget.maximumTotal !== 2 ||
      marketBudget?.calendarLogicalLoads !== 1 ||
      marketBudget.sessionMarkerLogicalLoads !== 1 ||
      marketBudget.actualTotal !== 2 ||
      marketBudget.maximumTotal !== 2 ||
      publicResolverBudget.actual !== resolverBudget.actualTotal ||
      publicResolverBudget.maximum !== resolverBudget.maximumTotal ||
      value.dependencyLedger[1].plannedOfficialSourceLoads !==
        resolverBudget.actualTotal
    ) {
      context.addIssue({
        code: "custom",
        path: ["workBudget", "plannedOfficialSourceRequests"],
        message:
          "公開 ledger/workBudget 必須與 embedded single-market resolver 的 calendar、marker、actual 與 maximum loads 完全一致。",
      });
    }
    if (generatedAt && resolverEvaluatedAt) {
      const storedStatuses = new Set(["hit", "miss", "shared"]);
      for (const source of resolverEvidence.marketResolutions.flatMap(
        (resolution) => resolution.sources,
      )) {
        const retrievedAt = parseOffsetIso(source.retrievedAt);
        const cacheObservedAt = source.cache.observedAt
          ? parseOffsetIso(source.cache.observedAt)
          : null;
        const cacheStoredAt = source.cache.storedAt
          ? parseOffsetIso(source.cache.storedAt)
          : null;
        const stored = storedStatuses.has(source.cache.status);
        const storedAge =
          cacheObservedAt && cacheStoredAt
            ? cacheObservedAt.timestampMs - cacheStoredAt.timestampMs
            : null;
        const coherent =
          retrievedAt !== null &&
          cacheObservedAt !== null &&
          retrievedAt.timestampMs <= generatedAt.timestampMs &&
          cacheObservedAt.timestampMs <= generatedAt.timestampMs &&
          resolverEvaluatedAt.timestampMs <= cacheObservedAt.timestampMs &&
          retrievedAt.timestampMs <= cacheObservedAt.timestampMs &&
          (stored
            ? cacheStoredAt !== null &&
              retrievedAt.timestampMs <= cacheStoredAt.timestampMs &&
              cacheStoredAt.timestampMs <= cacheObservedAt.timestampMs &&
              source.cache.ageMs === storedAge &&
              source.cache.ttlMs !== null &&
              source.cache.ttlMs > 0
            : cacheStoredAt === null &&
              source.cache.ageMs === null &&
              ((source.cache.status === "bypass" &&
                source.cache.ttlMs === 0) ||
                ((source.cache.status === "not_applicable" ||
                  source.cache.status === "unknown") &&
                  source.cache.ttlMs === null)));
        if (!coherent) {
          context.addIssue({
            code: "custom",
            path: [
              "meta",
              "quality",
              "freshnessDetails",
              "resolverEvidence",
              "marketResolutions",
              "sources",
            ],
            message:
              "resolver source 必須符合 retrievedAt/cache chronology、request-start observation 與 generatedAt 上限。",
          });
        }
      }
    }
    if (
      officialFreshness?.status !== "within_expected_window" ||
      officialFreshness.observedAsOf !== value.latestOfficialCloseDate ||
      officialFreshness.expectedAsOf !== value.latestOfficialCloseDate ||
      officialFreshness.lag?.value !== 0 ||
      officialFreshness.lag.unit !== "trading_session" ||
      officialFreshness.reasonCode !== "MATCHES_EXPECTED_AS_OF"
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "quality", "freshnessDetails"],
        message:
          "成功的 observed-price completed-close freshness 必須精確證明 observedAsOf=expectedAsOf=public close date 且 trading-session lag=0。",
      });
    }
    if (
      value.meta.asOf.selector !== "snapshot" ||
      value.meta.asOf.resolved.granularity !== "mixed" ||
      value.meta.asOf.resolved.from !== null ||
      value.meta.asOf.resolved.through !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "asOf"],
        message:
          "observed-price envelope 必須使用 selector=snapshot 與 mixed null/null resolved as-of",
      });
    }
    const page = value.meta.page;
    if (
      page.mode !== "none" ||
      page.unit !== "none" ||
      page.limit !== null ||
      page.returned !== null ||
      page.total !== null ||
      page.next !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "page"],
        message: "observed-price 是單一 snapshot，page metadata 必須固定為 none/null",
      });
    }
    const quality = value.meta.quality;
    if (
      quality.status !== "partial" ||
      quality.source !== "partial" ||
      quality.universe !== "unverified" ||
      quality.selection !== "complete" ||
      quality.values !== "complete"
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "quality"],
        message:
          "observed-price quality 必須保守固定為 partial/source partial/universe unverified/selection complete/values complete",
      });
    }
    if (
      quality.freshness !== expectedMeta.freshness ||
      !observedPriceFreshnessDetailsMatch(
        quality.freshnessDetails,
        expectedMeta.freshnessDetails,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "quality", "freshnessDetails"],
        message:
          "freshness 必須由兩份 current-master sources 與唯一 official-close source 的固定兩項 policy evidence 精確重算",
      });
    }
    const requiredFreshnessIssues = new Set(
      expectedMeta.requiredFreshnessIssueCodes,
    );
    for (const code of OBSERVED_PRICE_REQUIRED_QUALITY_ISSUE_CODES) {
      if (quality.issues.filter((issue) => issue.code === code).length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["meta", "quality", "issues"],
          message: `${code} 必須在 observed-price quality issues 中精確出現一次`,
        });
      }
    }
    for (const code of ["DATA_STALE", "FRESHNESS_UNVERIFIED"] as const) {
      const count = quality.issues.filter((issue) => issue.code === code).length;
      if (
        (requiredFreshnessIssues.has(code) && count !== 1) ||
        (!requiredFreshnessIssues.has(code) && count !== 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["meta", "quality", "issues"],
          message: `${code} 必須與 freshnessDetails 的 stale／unknown evidence 一致且不得重複`,
        });
      }
    }
    const expectedIssueCodes = [
      ...OBSERVED_PRICE_REQUIRED_QUALITY_ISSUE_CODES,
      ...expectedMeta.requiredFreshnessIssueCodes,
    ].sort();
    const actualIssueCodes = quality.issues
      .map((issue) => issue.code)
      .sort();
    if (
      actualIssueCodes.length !== expectedIssueCodes.length ||
      actualIssueCodes.some(
        (code, index) => code !== expectedIssueCodes[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "quality", "issues"],
        message:
          "observed-price quality issues 必須精確包含五項 domain issues 與 freshness evidence 所需動態 issues，不得夾帶其他代碼",
      });
    }
    if (
      value.meta.asOf.snapshotId === null ||
      !/^[A-Za-z0-9_-]{32}$/.test(value.meta.asOf.snapshotId) ||
      value.meta.asOf.snapshotId !== expectedMeta.snapshotId
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "asOf", "snapshotId"],
        message:
          "snapshotId 必須由 canonical query/company/baseline/top-level sources 與 resolver calendar/marker provenance（排除 caller cache 與 dependency ledger）重算為 32 字元 base64url fingerprint",
      });
    }
    const served = parseOffsetIso(value.meta.asOf.servedAt);
    const generated = parseOffsetIso(value.generatedAt);
    if (
      !served ||
      !generated ||
      served.timestampMs < generated.timestampMs ||
      value.meta.asOf.assembledAt !== value.meta.asOf.servedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "asOf", "servedAt"],
        message:
          "servedAt 必須是有效時間、不得早於 generatedAt，且 assembledAt 必須是相同 instant",
      });
    }
    const resolverSources = [
      ...new Map(
        resolverEvidence.marketResolutions
          .flatMap((resolution) => resolution.sources)
          .map((source) => [
            [
              source.sourceUrl,
              source.retrievedAt,
              source.asOfGranularity,
              source.asOf,
            ].join("\u0000"),
            source,
          ]),
      ).values(),
    ];
    if (
      value.meta.asOf.sourceCutoffs.length !==
      value.sources.length + resolverSources.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "asOf", "sourceCutoffs"],
        message:
          "sourceCutoffs 必須完整一對一保留三份 top-level sources 與 deduped resolver calendar／marker sources",
      });
      return;
    }
    const unusedCutoffIndexes = new Set(
      value.meta.asOf.sourceCutoffs.map((_, index) => index),
    );
    const consumeCutoff = (
      matches: (
        cutoff: (typeof value.meta.asOf.sourceCutoffs)[number],
      ) => boolean,
    ): boolean => {
      const index = [...unusedCutoffIndexes].find((candidate) =>
        matches(value.meta.asOf.sourceCutoffs[candidate]!),
      );
      if (index === undefined) return false;
      unusedCutoffIndexes.delete(index);
      return true;
    };
    for (const source of value.sources) {
      const asOf =
        source.stage === "company_master"
          ? source.reportDate
          : source.selectedBarDate;
      const granularity = "date";
      if (
        !consumeCutoff(
          (cutoff) =>
            cutoff.publishedAt === null &&
            cutoff.sourceUrl === source.sourceUrl &&
            cutoff.retrievedAt === source.retrievedAt &&
            cutoff.resolved.granularity === granularity &&
            cutoff.resolved.from === asOf &&
            cutoff.resolved.through === asOf &&
            JSON.stringify(cutoff.cache) === JSON.stringify(source.cache),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["meta", "asOf", "sourceCutoffs"],
          message:
            "每個 top-level source 都必須有唯一 cutoff，其 URL、as-of、retrievedAt 與 cache 完全一致",
        });
      }
    }
    for (const source of resolverSources) {
      const resolved =
        source.asOfGranularity === "year"
          ? {
              granularity: "date" as const,
              from: `${source.asOf}-01-01`,
              through: `${source.asOf}-12-31`,
            }
          : {
              granularity: "month" as const,
              from: source.asOf,
              through: source.asOf,
            };
      if (
        !consumeCutoff(
          (cutoff) =>
            cutoff.publishedAt === null &&
            cutoff.sourceUrl === source.sourceUrl &&
            cutoff.retrievedAt === source.retrievedAt &&
            cutoff.resolved.granularity === resolved.granularity &&
            cutoff.resolved.from === resolved.from &&
            cutoff.resolved.through === resolved.through &&
            JSON.stringify(cutoff.cache) === JSON.stringify(source.cache),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["meta", "asOf", "sourceCutoffs"],
          message:
            "每個 deduped resolver source 都必須有唯一 cutoff，其 granularity、as-of、retrievedAt 與 cache 完全一致",
        });
      }
    }
    if (unusedCutoffIndexes.size > 0) {
      context.addIssue({
        code: "custom",
        path: ["meta", "asOf", "sourceCutoffs"],
        message: "sourceCutoffs 不得包含 top-level 或 resolver evidence 以外的來源。",
      });
    }
  })
  .describe("analyze_observed_price 的成功 MCP envelope、共用 metadata 與嚴格 domain result");
