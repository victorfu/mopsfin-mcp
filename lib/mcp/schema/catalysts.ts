import { z } from "zod";

import {
  calendarDateSchema,
  calendarMonthSchema,
  sourceCacheObservationSchema,
  successResultShape,
  warningShape,
} from "./common";

const catalystEventTypeSchema = z.enum([
  "material_information",
  "investor_conference",
]);

const catalystSourceKeySchema = z.enum([
  "twse_material_information_current",
  "tpex_material_information_current",
  "mops_material_information_history",
  "mops_investor_conference_history",
]);

const catalystCurrentSourceKeySchema = z.enum([
  "twse_material_information_current",
  "tpex_material_information_current",
]);

const catalystSnapshotTypeSchema = z.enum([
  "forecast_achievement",
  "forecast_material_variance",
  "shareholder_meeting",
  "dividend_decision",
]);

const catalystSnapshotSourceKeySchema = z.enum([
  "twse_forecast_achievement_current",
  "tpex_forecast_achievement_current",
  "twse_forecast_material_variance_current",
  "tpex_forecast_material_variance_current",
  "twse_shareholder_meeting_current",
  "tpex_shareholder_meeting_current",
  "twse_dividend_decision_current",
  "tpex_dividend_decision_current_unsupported",
]);

function strictCalendarDateEpoch(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? epoch
    : null;
}

export const companyCatalystEventsInputSchema = z
  .object({
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("要查詢官方事件的四碼台股公司代號"),
      )
      .min(1)
      .max(20)
      .describe(
        "要查詢的 1 至 20 家公司；逐公司向官方 MOPS 歷史頁查詢，單一公司失敗不得抹除其他公司的成功結果",
      ),
    start_date: calendarDateSchema.describe(
      "事件查詢起始日（含），採 Asia/Taipei 日曆日期",
    ),
    end_date: calendarDateSchema.describe(
      "事件查詢結束日（含），不得早於 start_date，且含首尾最多 366 日；可涵蓋官方已公告的未來排定事件",
    ),
    event_types: z
      .array(
        catalystEventTypeSchema.describe(
          "material_information=重大訊息；investor_conference=法人說明會",
        ),
      )
      .min(1)
      .max(2)
      .default(["material_information", "investor_conference"])
      .describe(
        "要取得的官方事件 family；本版本不提供分析師 consensus、預估修正、目標價或事件情緒分數",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "組裝並依事件時間穩定排序後的零起算事件位移；續頁必須沿用完全相同的公司、日期與 event_types",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("本頁最多回傳事件數，預設 50、上限 100"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.company_codes).size !== value.company_codes.length) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message: "company_codes 不得包含重複代號",
      });
    }
    if (new Set(value.event_types).size !== value.event_types.length) {
      context.addIssue({
        code: "custom",
        path: ["event_types"],
        message: "event_types 不得包含重複 family",
      });
    }
    const start = strictCalendarDateEpoch(value.start_date);
    const end = strictCalendarDateEpoch(value.end_date);
    if (start === null) {
      context.addIssue({
        code: "custom",
        path: ["start_date"],
        message: "start_date 必須是真實存在的日曆日期",
      });
    }
    if (end === null) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date 必須是真實存在的日曆日期",
      });
    }
    if (start === null || end === null) return;
    if (end < start) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date 不得早於 start_date",
      });
    } else if ((end - start) / 86_400_000 + 1 > 366) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "事件查詢範圍含首尾最多 366 日",
      });
    }
    const startDate = new Date(start);
    const endDate = new Date(end);
    const calendarMonthCount =
      (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      endDate.getUTCMonth() -
      startDate.getUTCMonth() +
      1;
    const unitsPerCompanyMonth =
      (value.event_types.includes("material_information") ? 1 : 0) +
      (value.event_types.includes("investor_conference") ? 2 : 0);
    const minimumHistoricalWorkUnits =
      value.company_codes.length * calendarMonthCount * unitsPerCompanyMonth;
    if (minimumHistoricalWorkUnits > 40) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message:
          `歷史 catalyst 查詢至少需要 ${minimumHistoricalWorkUnits} 個工作單位，超過 40；重大訊息每 company×month 一單位，法說會因雙市場查詢為兩單位`,
      });
    }
  });

export const companyCatalystSnapshotsInputSchema = z
  .object({
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("要查詢 current official catalyst snapshots 的四碼台股公司代號"),
      )
      .min(1)
      .max(20)
      .describe(
        "要查詢的 1 至 20 家公司；目前 company master 只作 current market routing，未匹配代號會安全探測上市與上櫃來源",
      ),
    snapshot_types: z
      .array(
        catalystSnapshotTypeSchema.describe(
          "forecast_achievement=公司財測達成快照；forecast_material_variance=官方重大差異名單；shareholder_meeting=股東會排程；dividend_decision=股利決議",
        ),
      )
      .min(1)
      .max(4)
      .default([
        "forecast_achievement",
        "forecast_material_variance",
        "shareholder_meeting",
        "dividend_decision",
      ])
      .describe(
        "要讀取的 current snapshot families；公司財測不是分析師 consensus，TPEx current dividend route 會明示 unsupported",
      ),
    as_of: z
      .literal("latest")
      .default("latest")
      .describe(
        "固定為 latest；這些來源不支援 point-in-time 歷史 vintage，不接受 YYYY-MM-DD 回溯",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "組裝並穩定排序後的零起算 record 位移；續頁須沿用相同公司與 snapshot_types，並核對 fingerprint",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("本頁最多回傳 snapshot records 數，預設 50、上限 100"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.company_codes).size !== value.company_codes.length) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message: "company_codes 不得包含重複代號",
      });
    }
    if (new Set(value.snapshot_types).size !== value.snapshot_types.length) {
      context.addIssue({
        code: "custom",
        path: ["snapshot_types"],
        message: "snapshot_types 不得包含重複 family",
      });
    }
  });

const catalystEventSchema = z
  .object({
    eventId: z
      .string()
      .describe("由官方事件 identity 組成的穩定識別碼，可用於同次與後續查詢去重"),
    eventType: catalystEventTypeSchema.describe("官方事件 family"),
    companyCode: z.string().describe("事件所屬四碼公司股票代號"),
    companyName: z.string().describe("事件來源列所載公司名稱"),
    market: z.enum(["listed", "otc"]).describe("事件公司所屬上市或上櫃市場"),
    title: z.string().describe("官方重大訊息主旨或法說會摘要標題，不做正負面改寫"),
    description: z
      .string()
      .nullable()
      .describe("官方事件說明；來源未提供或尚未載入明細時為 null"),
    clause: z
      .string()
      .nullable()
      .describe("重大訊息符合條款原文；法說會或來源未提供時為 null"),
    publishedAt: z
      .string()
      .nullable()
      .describe("官方公告發布時間；來源只提供事件日期而沒有發布時間時為 null"),
    factDate: calendarDateSchema
      .nullable()
      .describe("重大訊息所載事實發生日；不適用或官方未提供時為 null"),
    scheduledAt: z
      .string()
      .nullable()
      .describe("官方已公告的法說會等排定時間；不是推估日期，不適用時為 null"),
    effectiveAt: z
      .string()
      .nullable()
      .describe("事件法律或交易生效時間；本來源未提供時為 null，不以公告日代填"),
    timezone: z
      .literal("Asia/Taipei")
      .describe("此事件官方日期時間的正規化時區"),
    status: z
      .enum(["announced", "revised", "cancelled", "scheduled"])
      .describe("只依官方公告文字辨識的事件狀態，不代表投資判斷"),
    statusBasis: z
      .enum(["announcement_publication", "title_prefix", "official_schedule"])
      .describe("status 的官方欄位或保守文字辨識依據"),
    dateConfidence: z
      .literal("confirmed")
      .describe("事件時間直接來自官方公告；不把法定時程或歷史慣例推成確定日期"),
    dateBasis: z
      .enum(["publication", "scheduled_event"])
      .describe("事件主日期是公告發布或官方排定事件，兩者不可混用"),
    datePrecision: z
      .enum(["day", "minute", "second"])
      .describe("官方來源能支持的事件時間精度"),
    isConsensus: z
      .literal(false)
      .describe("固定為 false；單筆官方公司事件不是分析師共識"),
    sourceKey: catalystSourceKeySchema.describe(
      "此事件實際使用的固定官方資料集或歷史查詢識別碼",
    ),
    sourceUrl: z
      .string()
      .url()
      .describe("此事件實際取自的官方 TWSE／TPEx／MOPS URL"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("官方來源出表日；歷史 HTML 沒有獨立出表日時為 null"),
    sourceRecordKey: z
      .string()
      .describe("由官方查詢列 key 組成的穩定原始紀錄識別碼"),
    eventDetails: z
      .object({
        location: z.string().nullable().describe("官方法說會地點；不適用或未提供時為 null"),
        presentationZhFileName: z.string().nullable().describe("官方中文簡報檔名；未提供時為 null"),
        presentationEnFileName: z.string().nullable().describe("官方英文簡報檔名；未提供時為 null"),
        companyIrUrl: z.string().nullable().describe("公司 IR 網址原文；未提供時為 null"),
        videoUrl: z.string().nullable().describe("官方列出的影音網址；未提供時為 null"),
        note: z.string().nullable().describe("官方法說會備註；未提供時為 null"),
      })
      .strict()
      .nullable()
      .describe("法說會專屬官方欄位；重大訊息為 null"),
  })
  .strict();

const catalystSourceSchema = z
  .object({
    eventType: catalystEventTypeSchema.describe("此來源負責的事件 family"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("current snapshot 的上市或上櫃市場；跨市場歷史 MOPS 摘要為 null"),
    exchange: z
      .enum(["TWSE", "TPEx", "MOPS"])
      .describe("發布 current snapshot 的市場機構，或跨市場歷史 MOPS"),
    sourceKey: catalystSourceKeySchema.describe(
      "官方資料集或歷史查詢 route 的固定識別碼",
    ),
    sourceName: z.string().describe("官方資料集或 MOPS 查詢頁名稱"),
    sourceUrl: z.string().url().describe("本次實際查詢的官方來源 URL"),
    retrievedAt: z
      .string()
      .nullable()
      .describe("本服務取得此官方回應的 ISO 8601 時間；沒有單一共同時間時為 null"),
    cache: sourceCacheObservationSchema.optional().describe("事件來源的 caller-specific cache provenance"),
    scope: z
      .enum(["current_official_snapshot", "selected_company_historical_months"])
      .describe("當期官方快照或依 selected company×calendar month 查詢的歷史結果"),
    queryStart: calendarDateSchema.describe("此來源實際查詢範圍起始日（含）"),
    queryEnd: calendarDateSchema.describe("此來源實際查詢範圍終止日（含）"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("官方來源出表日；歷史頁未另提供時為 null"),
    rawRowCount: z.number().int().nonnegative().describe("官方回應解析前的資料列數"),
    acceptedEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe("完成 identity、日期與去重檢查後接受的事件數"),
    snapshotIdentity: z
      .string()
      .describe("由通過 identity 核對的非空／合法空回應組成的來源快照 fingerprint"),
  })
  .strict();

const catalystFailureSchema = z
  .object({
    failureId: z.string().describe("穩定的逐 company×family×month failure 識別碼"),
    companyCode: z.string().describe("此 failure 隔離影響的公司代號"),
    eventType: catalystEventTypeSchema.describe("此 failure 影響的事件 family"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("已解析的公司市場；identity 無法確認時為 null"),
    queryMonth: calendarMonthSchema.describe(
      "此 failure 影響的歷史日曆月份；current snapshot failure 則為擷取當下的台北年月",
    ),
    code: z.string().describe("穩定的錯誤代號"),
    reason: z.string().nullable().describe("更精確的 failure reason；未提供時為 null"),
    message: z.string().describe("此公司與事件 family 的失敗原因"),
    retryable: z.boolean().describe("是否適合稍後以相同條件重試"),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("建議至少等待的毫秒數；未提供時為 null"),
    action: z
      .enum(["fix_input", "change_query", "retry", "restart_pagination", "none"])
      .describe("呼叫端針對此隔離 failure 建議採取的下一步"),
  })
  .strict();

const catalystFamilyCoverageSchema = z
  .object({
    companyCode: z.string().describe("此覆蓋列對應的 requested 公司代號"),
    eventType: catalystEventTypeSchema.describe("此覆蓋列對應的事件 family"),
    status: z
      .enum(["complete", "partial", "failed"])
      .describe("此公司在 requested 日期對此 family 歷史月份的完成狀態"),
    queryStart: calendarDateSchema.describe("此公司 family 查詢起始日（含）"),
    queryEnd: calendarDateSchema.describe("此公司 family 查詢終止日（含）"),
    requestCount: z.number().int().nonnegative().describe("此公司 family 的歷史月份／市場查詢工作單位數"),
    completedRequestCount: z.number().int().nonnegative().describe("成功且 identity 可驗證的歷史月份／市場工作單位數"),
    verifiedEmptyRequestCount: z.number().int().nonnegative().describe("已驗證合法無歷史事件的工作單位數"),
    nonemptyRequestCount: z.number().int().nonnegative().describe("通過 identity 核對且有歷史事件的工作單位數"),
    eventCount: z.number().int().nonnegative().describe("此公司 family 的歷史 accepted event 數；current 補強另見 coverage.currentSnapshots"),
    snapshotIdentity: z.string().describe("此 company×family 歷史月份查詢範圍的快照 fingerprint"),
    failures: z.array(catalystFailureSchema).describe("此 company×family 的逐歷史月份／市場隔離 failures"),
  })
  .strict();

const catalystAggregateFamilyCoverageSchema = z
  .object({
    eventType: catalystEventTypeSchema.describe("此彙總覆蓋列對應的事件 family"),
    scope: z
      .enum(["current_and_selected_company_history", "selected_company_history"])
      .describe("此 family 是否結合 current snapshot 與 selected-company history"),
    status: z.enum(["complete", "partial", "failed"]).describe("此 family 對全部 requested 公司的完成狀態"),
    requestedStart: calendarDateSchema.describe("requested 起始日（含）"),
    requestedEnd: calendarDateSchema.describe("requested 終止日（含）"),
    failedCompanyCodes: z.array(z.string()).describe("此 family 至少一個月份失敗的公司代號"),
  })
  .strict();

const catalystCompanyResultSchema = z
  .object({
    companyCode: z.string().describe("requested 公司代號"),
    status: z.enum(["complete", "partial", "failed"]).describe("此公司所有 requested families 的完成狀態"),
    eventCount: z.number().int().nonnegative().describe("此公司在分頁前的 accepted event 數"),
    failures: z.array(catalystFailureSchema).describe("此公司被隔離的 family×month failures"),
  })
  .strict();

const catalystCurrentSnapshotCoverageSchema = z
  .object({
    sourceKey: catalystCurrentSourceKeySchema.describe(
      "current 重大訊息官方市場來源",
    ),
    eventType: z
      .literal("material_information")
      .describe("current snapshot 固定補強重大訊息 family"),
    market: z.enum(["listed", "otc"]).describe("current snapshot 市場"),
    status: z
      .enum(["complete", "not_applicable", "failed"])
      .describe(
        "complete=快照可綁定 requested range；not_applicable=成功取得但出表日／事件不在範圍；failed=來源失敗",
      ),
    affectedCompanyCodes: z
      .array(z.string())
      .describe("此共享市場快照實際用來補強的 requested 公司代號"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("官方 current snapshot 出表日；無可綁定出表日時為 null"),
    eventCount: z
      .number()
      .int()
      .nonnegative()
      .describe("此 current snapshot 在 requested range 接受的 selected-company 事件數"),
    snapshotIdentity: z
      .string()
      .describe("current source、適用性、affected companies 與事件的 fingerprint"),
    failures: z
      .array(catalystFailureSchema)
      .describe("此 current 市場快照按 affected company 隔離的 failures"),
  })
  .strict();

export const companyCatalystEventsOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCodes: z.array(z.string()).describe("正規化後完整 requested 公司代號"),
        startDate: calendarDateSchema.describe("實際查詢起始日（含）"),
        endDate: calendarDateSchema.describe("實際查詢終止日（含）"),
        eventTypes: z.array(catalystEventTypeSchema).describe("實際查詢的官方事件 families"),
        offset: z.number().int().nonnegative().describe("正規化後的事件分頁位移"),
        limit: z.number().int().positive().describe("正規化後的事件分頁上限"),
      })
      .strict()
      .describe("本頁與續頁必須保持一致的事件查詢範圍"),
    generatedAt: z.string().describe("本服務完成事件組裝的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("官方日期與時間正規化使用的時區"),
    scope: z
      .literal("official_disclosure_events")
      .describe("只回官方公告與公司揭露事件，不含媒體傳聞或研究判斷"),
    isConsensus: z
      .literal(false)
      .describe("固定為 false；公司公告／指引不能冒充分析師 consensus"),
    events: z
      .array(catalystEventSchema)
      .describe("穩定排序後的本頁官方事件；沒有事件不代表負面訊號"),
    failures: z
      .array(catalystFailureSchema)
      .describe("逐公司、逐 family 隔離的查詢失敗；不得當成合法空事件"),
    coverage: z
      .object({
        sourceComplete: z.boolean().describe("所有 requested 官方來源是否均成功且可核對查詢 identity"),
        failureIsolation: z
          .literal("per_company_event_type_calendar_month")
          .describe("所有失敗均按 company×eventType×calendar month 隔離"),
        families: z
          .array(catalystAggregateFamilyCoverageSchema)
          .describe("逐 family 的 current／historical scope 與失敗公司彙總"),
        currentSnapshots: z
          .array(catalystCurrentSnapshotCoverageSchema)
          .describe(
            "近期重大訊息共享市場快照的成功、不適用或失敗覆蓋；不混入逐公司歷史月份計數",
          ),
      })
      .strict()
      .describe("來源完整性、failure isolation 與 family 查詢範圍"),
    familyCoverage: z
      .array(catalystFamilyCoverageSchema)
      .describe("逐 company×family 的歷史月份請求、合法空回應、事件與 failure 覆蓋"),
    companies: z
      .array(catalystCompanyResultSchema)
      .describe(
        "逐 requested 代號彙總來源狀態；complete 且 eventCount=0 只證明該代號範圍查無事件，公司 identity 是否已驗證仍須檢查 meta.quality.selection 與 issues",
      ),
    counts: z
      .object({
        requestedCompanies: z.number().int().nonnegative().describe("requested 公司數"),
        requestedEventTypes: z.number().int().nonnegative().describe("requested event family 數"),
        totalEvents: z.number().int().nonnegative().describe("分頁前 accepted event 總數"),
        returnedEvents: z.number().int().nonnegative().describe("本頁回傳事件數"),
        completeCompanies: z.number().int().nonnegative().describe("所有 requested families 完成的公司數"),
        partialCompanies: z.number().int().nonnegative().describe("部分 requested family 或月份失敗的公司數"),
        failedCompanies: z.number().int().nonnegative().describe("所有 requested families 均失敗的公司數"),
      })
      .strict()
      .describe("requested、事件與逐公司完成狀態計數"),
    workBudget: z
      .object({
        companyCount: z.number().int().nonnegative().describe("requested 公司數"),
        distinctCalendarMonths: z.number().int().nonnegative().describe("requested range 涵蓋的日曆月份數"),
        eventTypeCount: z.number().int().nonnegative().describe("requested event family 數"),
        historicalLogicalUnits: z.number().int().nonnegative().describe("company×family×calendar month 邏輯工作單位"),
        historicalUpstreamRequests: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "執行前按 company×family×month／market 計算的歷史查詢工作單位；retry attempt 不重複計數",
          ),
        currentSnapshotRequests: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "執行前按市場計算的 current snapshot 查詢工作單位；retry attempt 不重複計數",
          ),
        plannedUpstreamRequests: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "上述歷史與 current 查詢工作單位總和；不是包含 retry 或 master hint 的 HTTP attempt 計數",
          ),
        upstreamRequestLimit: z
          .literal(40)
          .describe("單次 tool call 固定 catalyst 查詢工作單位上限"),
      })
      .strict()
      .describe("避免公司、月份與 family 乘積造成無界工作量的透明 budget"),
    pagination: z
      .object({
        offset: z.number().int().nonnegative().describe("本頁事件的零起算位移"),
        limit: z.number().int().positive().describe("本頁事件數上限"),
        returnedRows: z.number().int().nonnegative().describe("本頁實際事件數"),
        totalRows: z.number().int().nonnegative().describe("本次重新組裝後的完整事件數"),
        hasMore: z.boolean().describe("本次重新組裝結果是否還有下一頁"),
        nextOffset: z.number().int().nonnegative().nullable().describe("下一頁 offset；無下一頁時為 null"),
      })
      .strict()
      .describe(
        "事件 offset 分頁；每頁會重新查詢官方來源，並非 point-in-time 快照，續頁前應檢查 meta.asOf.snapshotId 是否改變",
      ),
    sources: z.array(catalystSourceSchema).describe("本次成功且通過 identity 核對的官方事件來源"),
    fingerprint: z
      .string()
      .describe("完整分頁前事件、來源與 failure coverage 的 deterministic fingerprint；續頁不同表示來源已變動"),
    ...warningShape,
  })
  .strict();

const catalystSnapshotFreshnessSchema = z.enum([
  "within_expected_window",
  "stale",
  "not_applicable",
]);

const catalystSnapshotNumberRangeSchema = z
  .object({
    raw: z.string().describe("官方預測數原文；單值會正規化為 lower=upper"),
    lower: z.number().describe("由官方原文解析的區間下界"),
    upper: z.number().describe("由官方原文解析的區間上界"),
    unit: z
      .literal("source_not_declared")
      .describe("官方簡式 snapshot 未宣告數值單位，不得自行假設為千元或元"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lower > value.upper) {
      context.addIssue({
        code: "custom",
        path: ["lower"],
        message: "預測區間 lower 不得大於 upper",
      });
    }
  });

const catalystSnapshotDetailsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("forecast_achievement").describe("公司財測達成 current snapshot details"),
      fiscalYear: z.number().int().describe("正規化後的西元財測年度"),
      fiscalYearRaw: z.string().describe("官方財測年度原文，通常為民國年"),
      quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe("官方財測季別"),
      forecastSequence: z.string().describe("官方財測序號；同公司同季可能有多個版本"),
      coveragePeriod: z.string().describe("官方財測涵蓋期間原文"),
      actualCumulative: z.number().describe("截至該季經會計師查核或核閱的官方累計數"),
      actualCumulativeRaw: z.string().describe("官方累計查核／核閱數原文"),
      valueUnit: z
        .literal("source_not_declared")
        .describe("官方簡式 snapshot 未宣告 actual／forecast 的數值單位"),
      forecastCumulative: catalystSnapshotNumberRangeSchema.describe("截至該季公司財測數值或區間；不是分析師 consensus"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("forecast_material_variance").describe("官方公司財測重大差異名單 current snapshot details"),
      fiscalYear: z.number().int().describe("正規化後的西元財測年度"),
      fiscalYearRaw: z.string().describe("官方財測年度原文，通常為民國年"),
      quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe("官方資料季別"),
      forecastSequence: z.string().describe("官方財測序號"),
      coveragePeriod: z.string().describe("官方財測涵蓋期間原文"),
      actualQuarter: z.number().describe("官方當季查核／核閱數"),
      actualQuarterRaw: z.string().describe("官方當季查核／核閱數原文"),
      actualCumulative: z.number().describe("官方截至當季累計查核／核閱數"),
      actualCumulativeRaw: z.string().describe("官方截至當季累計查核／核閱數原文"),
      valueUnit: z
        .literal("source_not_declared")
        .describe("官方簡式 snapshot 未宣告 actual／forecast 的數值單位"),
      forecastQuarter: catalystSnapshotNumberRangeSchema.describe("公司當季財測數值或區間"),
      forecastCumulative: catalystSnapshotNumberRangeSchema.describe("公司截至當季累計財測數值或區間"),
      selectionBasis: z.literal("official_dataset_membership").describe("只確認該列出現在官方重大差異名單"),
      officialSelectionRule: z
        .literal(
          "quarter_difference_at_least_10_percent_or_cumulative_difference_at_least_20_percent",
        )
        .describe(
          "官方資料集整體收錄規則；不表示本列可由簡式欄位辨識實際觸發的是 10% 或 20%",
        ),
      thresholdDetail: z.null().describe("官方簡式資料未指出該列實際觸發 10% 或 20% 哪一門檻，固定為 null"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("shareholder_meeting").describe("股東會排程 current snapshot details"),
      companyAddress: z.string().nullable().describe("官方公司地址；缺值為 null"),
      meetingType: z.string().describe("股東常會或臨時會原文"),
      meetingDate: calendarDateSchema.describe("官方排定股東會日期"),
      meetingLocation: z.string().describe("官方開會地點"),
      directorSupervisorElection: z.string().describe("是否改選董監原文"),
      electronicVoting: z.string().describe("是否採電子投票原文"),
      contactPhone: z.string().nullable().describe("公司聯絡電話；缺值為 null"),
      stockTransferAgent: z.string().nullable().describe("股務單位；缺值為 null"),
      stockTransferAgentPhone: z.string().nullable().describe("股務單位電話；缺值為 null"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dividend_decision").describe("股利決議 current snapshot details"),
      decisionStage: z.string().describe("董事會擬議／決議或股東會確認等官方進度原文"),
      dividendYear: z.number().int().describe("正規化後的西元股利年度"),
      dividendYearRaw: z.string().describe("官方股利年度原文，通常為民國年"),
      periodType: z.string().describe("年度、半年或季別等官方期間類型"),
      periodRaw: z.string().describe("官方股利所屬期間原文"),
      periodStart: calendarDateSchema.nullable().describe("可解析時的股利所屬期間起始日"),
      periodEnd: calendarDateSchema.nullable().describe("可解析時的股利所屬期間終止日"),
      sequence: z.string().describe("官方期別／序號"),
      boardDecisionDate: calendarDateSchema.nullable().describe("董事會擬議或決議日；不是股利支付日，也不是首次公告日"),
      shareholderMeetingDate: calendarDateSchema.nullable().describe("官方股東會日期；未提供時為 null"),
      cashDividend: z
        .object({
          earningsPerShare: z.number().nullable().describe("盈餘分配現金股利，每股元"),
          legalReservePerShare: z.number().nullable().describe("法定盈餘公積發放現金，每股元"),
          capitalReservePerShare: z.number().nullable().describe("資本公積發放現金，每股元"),
          totalAmount: z.number().nullable().describe("股東配發現金股利總額，元"),
        })
        .strict()
        .describe("官方現金股利逐來源構成；缺值為 null，0 保留為 0"),
      stockDividend: z
        .object({
          earningsPerShare: z.number().nullable().describe("盈餘轉增資配股，每股元"),
          legalReservePerShare: z.number().nullable().describe("法定盈餘公積轉增資配股，每股元"),
          capitalReservePerShare: z.number().nullable().describe("資本公積轉增資配股，每股元"),
          totalShares: z.number().nullable().describe("股東配股總股數"),
        })
        .strict()
        .describe("官方股票股利逐來源構成；缺值為 null，0 保留為 0"),
      charterExcerpt: z.string().nullable().describe("官方摘錄公司章程股利分派部分；缺值為 null"),
      note: z.string().nullable().describe("官方備註；缺值為 null"),
    })
    .strict(),
]);

const catalystSnapshotRecordSchema = z
  .object({
    recordId: z.string().describe("由官方 snapshot row identity 組成的穩定 record id"),
    snapshotType: catalystSnapshotTypeSchema.describe("此筆 current snapshot evidence family"),
    companyCode: z.string().describe("requested 四碼公司代號"),
    companyName: z.string().describe("官方 snapshot 列所載公司名稱"),
    market: z.enum(["listed", "otc"]).describe("此列所屬上市或上櫃市場"),
    sourceMode: z.literal("current_official_snapshot").describe("固定為 current snapshot，不是歷史事件查詢"),
    sourceSnapshotDate: calendarDateSchema.describe("官方資料集出表／快照日；不是 factDate、publication date 或 firstKnownAt"),
    sourceSnapshotAgeDays: z.number().int().nonnegative().describe("相對 Asia/Taipei latest date 的快照日齡；未來日期會 fail closed"),
    freshness: z.enum(["within_expected_window", "stale"]).describe("快照日齡不超過 7 日才是 within_expected_window"),
    pointInTimeHistoryAvailable: z.literal(false).describe("固定 false；來源沒有可回放的 point-in-time vintage"),
    firstKnownAt: z.null().describe("來源不能證明首次為市場知悉的時間，固定為 null"),
    isConsensus: z.literal(false).describe("固定 false；公司財測與官方公司揭露不是分析師 consensus"),
    upcomingEligible: z.boolean().describe("只可能為 fresh 且會議日不早於 latest 的股東會；其他 family 固定 false"),
    sourceKey: catalystSnapshotSourceKeySchema.exclude([
      "tpex_dividend_decision_current_unsupported",
    ]).describe("實際提供此 record 的固定官方 dataset key"),
    sourceUrl: z.string().url().describe("實際提供此 record 的官方 TWSE／TPEx URL"),
    sourceRecordKey: z.string().describe("由官方 raw row identity 組成的穩定 key"),
    details: catalystSnapshotDetailsSchema.describe("依 snapshotType 分流的官方欄位"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.details.kind !== value.snapshotType) {
      context.addIssue({
        code: "custom",
        path: ["details", "kind"],
        message: "details.kind 必須與 snapshotType 相同",
      });
    }
    if (
      value.upcomingEligible &&
      (value.snapshotType !== "shareholder_meeting" ||
        value.freshness !== "within_expected_window")
    ) {
      context.addIssue({
        code: "custom",
        path: ["upcomingEligible"],
        message: "upcomingEligible 只適用於 fresh shareholder meeting",
      });
    }
  });

const catalystSnapshotFailureSchema = z
  .object({
    failureId: z.string().describe("穩定的 snapshotType×market failure id"),
    snapshotType: catalystSnapshotTypeSchema.describe("失敗的 snapshot family"),
    market: z.enum(["listed", "otc"]).describe("失敗來源市場"),
    sourceKey: catalystSnapshotSourceKeySchema.describe("失敗的官方 route key"),
    affectedCompanyCodes: z.array(z.string()).describe("由此來源失敗影響的 requested 公司代號"),
    code: z.string().describe("穩定錯誤代號"),
    message: z.string().describe("此來源的失敗原因；不得解讀為合法空值"),
    reason: z.string().nullable().describe("更精確 failure reason；未提供時為 null"),
    retryable: z.boolean().describe("是否適合稍後用相同條件重試"),
    retryAfterMs: z.number().int().nonnegative().nullable().describe("建議至少等待毫秒數；未提供時為 null"),
    action: z.enum(["fix_input", "change_query", "retry", "restart_pagination", "none"]).describe("呼叫端建議下一步"),
  })
  .strict();

const catalystSnapshotSourceSchema = z
  .object({
    snapshotType: catalystSnapshotTypeSchema.describe("此官方 route 負責的 snapshot family"),
    market: z.enum(["listed", "otc"]).describe("此 route 的上市或上櫃市場"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("此 route 的官方市場機構"),
    sourceKey: catalystSnapshotSourceKeySchema.describe("固定官方 dataset 或 unsupported route key"),
    sourceName: z.string().describe("官方資料集名稱或 unsupported route 說明"),
    sourceUrl: z.string().url().nullable().describe("實際官方 URL；沒有可用 current route 時為 null"),
    sourceMode: z.literal("current_official_snapshot").describe("固定為 current snapshot"),
    pointInTimeHistoryAvailable: z.literal(false).describe("固定 false；此 route 沒有 point-in-time 歷史 vintage"),
    isConsensus: z.literal(false).describe("固定 false；不是分析師共識資料"),
    requestedCompanyCodes: z.array(z.string()).describe("實際由此 route 負責的 requested 公司代號"),
    status: z.enum(["nonempty", "verified_empty", "failed", "unsupported"]).describe("官方非空、exact blank sentinel、查詢失敗或 current route 不存在"),
    freshness: catalystSnapshotFreshnessSchema.describe("依 sourceSnapshotDate 判定；失敗或 unsupported 為 not_applicable"),
    retrievedAt: z.string().nullable().describe("成功取得來源的 ISO 8601 時間；失敗或 unsupported 為 null"),
    cache: sourceCacheObservationSchema.optional().describe("current snapshot 來源的 caller-specific cache provenance"),
    sourceSnapshotDate: calendarDateSchema.nullable().describe("官方出表／snapshot 日期；失敗或 unsupported 為 null"),
    sourceSnapshotAgeDays: z.number().int().nonnegative().nullable().describe("相對台北 latest 日的 snapshot age；未來日期 fail closed，不適用為 null"),
    rawRowCount: z.number().int().nonnegative().describe("官方 payload raw row 數；未取得為 0"),
    eligibleRecordCount: z.number().int().nonnegative().describe("通過 schema 與 identity 檢查的 full-market record 數"),
    duplicateRecordCount: z.number().int().nonnegative().describe("完全重複 raw identity 的列數"),
    selectedRecordCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "requested 代號且通過 current identity market reconciliation 後保留的 record 數",
      ),
    emptyVerification: z.enum(["not_applicable", "official_blank_sentinel"]).describe("verified_empty 只能來自 exact official blank sentinel"),
    officialDeclaredRowCount: z.null().describe("官方 OpenAPI 未提供 declared row count，固定為 null"),
    rowsetCompleteness: z.enum(["unverified_no_official_declared_count", "not_applicable"]).describe("成功來源仍不額外宣稱 full rowset completeness"),
    snapshotIdentity: z.string().nullable().describe("成功 schema-valid snapshot fingerprint；失敗／unsupported 為 null"),
    failureId: z.string().nullable().describe("status=failed 時對應 failure id；其餘為 null"),
  })
  .strict()
  .superRefine((value, context) => {
    const successful =
      value.status === "nonempty" || value.status === "verified_empty";
    if (
      successful &&
      (value.sourceUrl === null ||
        value.retrievedAt === null ||
        value.sourceSnapshotDate === null ||
        value.sourceSnapshotAgeDays === null ||
        value.snapshotIdentity === null ||
        value.freshness === "not_applicable")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "成功 source 必須具備 URL、retrievedAt、sourceSnapshotDate、age、freshness 與 snapshotIdentity",
      });
    }
    if (
      value.status === "verified_empty" &&
      value.emptyVerification !== "official_blank_sentinel"
    ) {
      context.addIssue({
        code: "custom",
        path: ["emptyVerification"],
        message: "verified_empty 必須來自 exact official blank sentinel",
      });
    }
    if (
      value.status !== "verified_empty" &&
      value.emptyVerification !== "not_applicable"
    ) {
      context.addIssue({
        code: "custom",
        path: ["emptyVerification"],
        message: "只有 verified_empty 可標 official_blank_sentinel",
      });
    }
    if (value.status === "failed" && value.failureId === null) {
      context.addIssue({
        code: "custom",
        path: ["failureId"],
        message: "failed source 必須引用 failureId",
      });
    }
    if (value.status !== "failed" && value.failureId !== null) {
      context.addIssue({
        code: "custom",
        path: ["failureId"],
        message: "非 failed source 的 failureId 必須為 null",
      });
    }
    if (
      successful &&
      ((value.freshness === "within_expected_window" &&
        value.sourceSnapshotAgeDays !== null &&
        value.sourceSnapshotAgeDays > 7) ||
        (value.freshness === "stale" &&
          value.sourceSnapshotAgeDays !== null &&
          value.sourceSnapshotAgeDays <= 7))
    ) {
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "freshness 必須與 7 日 sourceSnapshotAgeDays policy 一致",
      });
    }
    if (
      value.status === "failed" &&
      (value.sourceUrl === null ||
        value.retrievedAt !== null ||
        value.sourceSnapshotDate !== null ||
        value.sourceSnapshotAgeDays !== null ||
        value.snapshotIdentity !== null ||
        value.freshness !== "not_applicable" ||
        value.rawRowCount !== 0 ||
        value.eligibleRecordCount !== 0 ||
        value.duplicateRecordCount !== 0 ||
        value.selectedRecordCount !== 0 ||
        value.rowsetCompleteness !== "not_applicable")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "failed route 必須保留 planned URL／failureId，但不得偽造 retrieval、snapshot identity、rows 或 freshness",
      });
    }
    if (
      value.status === "verified_empty" &&
      (value.rawRowCount !== 1 ||
        value.eligibleRecordCount !== 0 ||
        value.duplicateRecordCount !== 0 ||
        value.selectedRecordCount !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "verified_empty 必須是單一 exact blank sentinel，且不得含 records",
      });
    }
    if (
      value.status === "nonempty" &&
      (value.rawRowCount < 1 ||
        value.eligibleRecordCount < 1 ||
        value.selectedRecordCount > value.eligibleRecordCount ||
        value.eligibleRecordCount + value.duplicateRecordCount !==
          value.rawRowCount)
    ) {
      context.addIssue({
        code: "custom",
        message: "nonempty route 的 raw／eligible／duplicate／selected counts 不一致",
      });
    }
    if (
      value.status === "unsupported" &&
      (value.sourceUrl !== null ||
        value.retrievedAt !== null ||
        value.sourceSnapshotDate !== null ||
        value.sourceSnapshotAgeDays !== null ||
        value.snapshotIdentity !== null ||
        value.freshness !== "not_applicable" ||
        value.failureId !== null ||
        value.rawRowCount !== 0 ||
        value.eligibleRecordCount !== 0 ||
        value.duplicateRecordCount !== 0 ||
        value.selectedRecordCount !== 0 ||
        value.rowsetCompleteness !== "not_applicable")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "unsupported route 不得偽造 URL、retrieval、snapshot date、identity 或 freshness",
      });
    }
  });

const catalystSnapshotCoverageItemSchema = z
  .object({
    companyCode: z.string().describe("requested 公司代號"),
    snapshotType: catalystSnapshotTypeSchema.describe("此 coverage row 的 snapshot family"),
    routedMarkets: z.array(z.enum(["listed", "otc"])).describe("依 current master hint 或雙市場安全探測的 routes"),
    status: z.enum(["complete", "partial", "failed", "unsupported"]).describe("此 company×snapshotType 的 current coverage 狀態"),
    disclosureStatus: z.enum([
      "disclosed",
      "not_disclosed_in_snapshot",
      "unknown_stale_snapshot",
      "unknown_source_failure",
      "unsupported",
      "identity_unverified",
    ]).describe("只在 fresh、schema-valid、identity 可核對的 snapshot 才能宣稱 not_disclosed_in_snapshot"),
    identityStatus: z.enum(["verified_current_master_hint", "verified_official_record", "unverified"]).describe("公司 current identity 的證據"),
    resolvedMarket: z.enum(["listed", "otc"]).nullable().describe("可由 current master 或官方 record 確認的市場"),
    freshness: catalystSnapshotFreshnessSchema.describe("此 company×family 的最弱 current freshness"),
    recordCount: z.number().int().nonnegative().describe("此 company×family 分頁前 record 數"),
    sourceKeys: z.array(catalystSnapshotSourceKeySchema).describe("此 coverage row 依賴的 source routes"),
    failureIds: z.array(z.string()).describe("影響此 coverage row 的 failures"),
  })
  .strict();

const catalystSnapshotCompanyResultSchema = z
  .object({
    companyCode: z.string().describe("requested 公司代號"),
    status: z.enum(["complete", "partial", "failed"]).describe("全部 requested snapshot families 的彙總狀態"),
    identityStatus: z.enum(["verified_current_master_hint", "verified_official_record", "unverified"]).describe("公司 current identity 證據"),
    resolvedMarket: z.enum(["listed", "otc"]).nullable().describe("可確認的 current 市場；未驗證為 null"),
    recordCount: z.number().int().nonnegative().describe("此公司分頁前 record 數"),
    disclosedSnapshotTypes: z.array(catalystSnapshotTypeSchema).describe("snapshot 中有官方 record 的 families"),
    notDisclosedSnapshotTypes: z.array(catalystSnapshotTypeSchema).describe("fresh、schema-valid snapshot 中沒有 record 的 families"),
    staleSnapshotTypes: z.array(catalystSnapshotTypeSchema).describe("只能取得 stale evidence、不得解讀 current absence 的 families"),
    unsupportedSnapshotTypes: z.array(catalystSnapshotTypeSchema).describe("沒有可用 current source route 的 families"),
    failedSnapshotTypes: z.array(catalystSnapshotTypeSchema).describe("至少一個必要 route 查詢失敗的 families"),
  })
  .strict();

export const companyCatalystSnapshotsOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCodes: z
          .array(z.string().regex(/^\d{4}$/))
          .min(1)
          .max(20)
          .describe("正規化後完整 requested 四碼公司代號"),
        snapshotTypes: z
          .array(catalystSnapshotTypeSchema)
          .min(1)
          .max(4)
          .describe("實際查詢的 snapshot families"),
        companyMarkets: z
          .array(
            z
              .object({
                companyCode: z.string().describe("current master 已匹配的 requested 代號"),
                market: z.enum(["listed", "otc"]).describe("current master 所載市場"),
              })
              .strict(),
          )
          .describe("只作 current route hint；不是歷史市場母體"),
        asOf: z.literal("latest").describe("固定 latest；不支援歷史 snapshot vintage"),
        offset: z.number().int().nonnegative().describe("本頁 record offset"),
        limit: z.number().int().positive().max(100).describe("本頁 record 上限"),
      })
      .strict()
      .describe("正規化後實際執行的 current catalyst snapshot 查詢"),
    generatedAt: z
      .string()
      .describe(
        "本次 source freshness 與 upcoming 判斷共用的 ISO 8601 evaluation anchor",
      ),
    timezone: z.literal("Asia/Taipei").describe("source freshness 與 upcoming 判斷時區"),
    scope: z.literal("current_official_company_snapshots").describe("只含目前官方 full-market snapshots 的 selected-company evidence"),
    isConsensus: z.literal(false).describe("固定 false；公司財測與官方揭露不是分析師 consensus"),
    records: z.array(catalystSnapshotRecordSchema).describe("穩定排序後的本頁 selected-company snapshot records"),
    sources: z.array(catalystSnapshotSourceSchema).describe("成功、失敗、stale 與 unsupported routes 的完整 provenance"),
    coverage: z
      .object({
        sourceComplete: z.boolean().describe("全部 planned current routes 是否 fresh、schema-valid 且 supported"),
        selection: z.enum(["complete", "partial"]).describe("全部 requested company×family 是否可作 current disclosure 判斷"),
        failureIsolation: z.literal("per_snapshot_type_market").describe("共享 full-market source failures 按 snapshotType×market 隔離"),
        snapshots: z.array(catalystSnapshotCoverageItemSchema).describe("每個 requested company×snapshotType 的 disclosure／identity／freshness 狀態"),
      })
      .strict()
      .describe("source 與逐 company×family current disclosure coverage"),
    companies: z.array(catalystSnapshotCompanyResultSchema).describe("逐 requested 公司彙總 current snapshot 狀態"),
    failures: z.array(catalystSnapshotFailureSchema).describe("逐 snapshotType×market 隔離的查詢／parser failures"),
    counts: z
      .object({
        requestedCompanies: z.number().int().nonnegative().describe("requested 公司數"),
        requestedSnapshotTypes: z.number().int().nonnegative().describe("requested snapshot family 數"),
        totalRecords: z.number().int().nonnegative().describe("分頁前 selected-company record 總數"),
        returnedRecords: z.number().int().nonnegative().describe("本頁 records 數"),
        completeCompanies: z.number().int().nonnegative().describe("所有 requested families 都可判讀的公司數"),
        partialCompanies: z.number().int().nonnegative().describe("至少一個 family 為 partial／unsupported 的公司數"),
        failedCompanies: z.number().int().nonnegative().describe("所有 requested families 都失敗的公司數"),
        nonemptySources: z.number().int().nonnegative().describe("status=nonempty 的 route 數"),
        verifiedEmptySources: z.number().int().nonnegative().describe("通過 exact blank sentinel 的 route 數"),
        staleSources: z.number().int().nonnegative().describe("freshness=stale 的成功 route 數"),
        failedSources: z.number().int().nonnegative().describe("status=failed 的 route 數"),
        unsupportedSources: z.number().int().nonnegative().describe("status=unsupported 的 route 數"),
      })
      .strict()
      .describe("公司、record 與 route 狀態計數"),
    workBudget: z
      .object({
        companyCount: z.number().int().nonnegative().describe("requested 公司數"),
        snapshotTypeCount: z.number().int().nonnegative().describe("requested snapshot family 數"),
        plannedSourceRoutes: z.number().int().nonnegative().max(8).describe("依 current market routing 規劃的 family×market routes"),
        supportedSourceQueries: z.number().int().nonnegative().max(8).describe("實際可查詢的 official source logical units；retry 不重複計數"),
        unsupportedSourceRoutes: z.number().int().nonnegative().max(8).describe("沒有 current official endpoint、因此不發 HTTP 的 routes"),
        sourceQueryLimit: z.literal(8).describe("單次呼叫固定最多八個 full-market snapshot routes"),
      })
      .strict()
      .describe("full-market family×market route logical work budget"),
    pagination: z
      .object({
        offset: z.number().int().nonnegative().describe("本頁零起算 record offset"),
        limit: z.number().int().positive().max(100).describe("本頁 record 上限"),
        totalRows: z.number().int().nonnegative().describe("分頁前 record 總數"),
        returnedRows: z.number().int().nonnegative().describe("本頁實際 records 數"),
        hasMore: z.boolean().describe("目前 full-snapshot fingerprint 下是否仍有下一頁"),
        nextOffset: z.number().int().nonnegative().nullable().describe("下一頁 offset；沒有下一頁為 null"),
      })
      .strict()
      .describe("每頁重新讀取 current sources 的 stateless offset pagination"),
    fingerprint: z.string().describe("分頁前 records、source contracts、coverage 與 failures 的 deterministic fingerprint"),
    ...warningShape,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: Array<string | number>, message: string) => {
      context.addIssue({ code: "custom", path, message });
    };
    const countWhere = <T>(values: T[], predicate: (value: T) => boolean) =>
      values.filter(predicate).length;
    const hasUniqueStrings = (values: string[]) =>
      new Set(values).size === values.length;
    const sameStrings = (left: string[], right: string[]) =>
      left.length === right.length &&
      left.every((item, index) => item === right[index]);
    const canonicalSnapshotTypes = [
      "forecast_achievement",
      "forecast_material_variance",
      "shareholder_meeting",
      "dividend_decision",
    ] as const;
    const routeContracts = {
      twse_forecast_achievement_current: [
        "forecast_achievement",
        "listed",
        "TWSE",
      ],
      tpex_forecast_achievement_current: [
        "forecast_achievement",
        "otc",
        "TPEx",
      ],
      twse_forecast_material_variance_current: [
        "forecast_material_variance",
        "listed",
        "TWSE",
      ],
      tpex_forecast_material_variance_current: [
        "forecast_material_variance",
        "otc",
        "TPEx",
      ],
      twse_shareholder_meeting_current: [
        "shareholder_meeting",
        "listed",
        "TWSE",
      ],
      tpex_shareholder_meeting_current: [
        "shareholder_meeting",
        "otc",
        "TPEx",
      ],
      twse_dividend_decision_current: [
        "dividend_decision",
        "listed",
        "TWSE",
      ],
      tpex_dividend_decision_current_unsupported: [
        "dividend_decision",
        "otc",
        "TPEx",
      ],
    } as const;

    if (!hasUniqueStrings(value.query.companyCodes)) {
      issue(["query", "companyCodes"], "query.companyCodes 不得重複");
    }
    if (!hasUniqueStrings(value.query.snapshotTypes)) {
      issue(["query", "snapshotTypes"], "query.snapshotTypes 不得重複");
    }
    const requestedCodes = new Set(value.query.companyCodes);
    const requestedTypes = new Set(value.query.snapshotTypes);
    if (
      !sameStrings(
        value.query.snapshotTypes,
        canonicalSnapshotTypes.filter((snapshotType) =>
          requestedTypes.has(snapshotType),
        ),
      )
    ) {
      issue(
        ["query", "snapshotTypes"],
        "query.snapshotTypes 必須使用固定 canonical family 順序",
      );
    }
    const hintedCodes = value.query.companyMarkets.map(
      (hint) => hint.companyCode,
    );
    if (
      !hasUniqueStrings(hintedCodes) ||
      hintedCodes.some((companyCode) => !requestedCodes.has(companyCode))
    ) {
      issue(
        ["query", "companyMarkets"],
        "companyMarkets 必須是 requested companies 的唯一子集",
      );
    }

    if (
      value.counts.requestedCompanies !== value.query.companyCodes.length ||
      value.workBudget.companyCount !== value.query.companyCodes.length
    ) {
      issue(["counts", "requestedCompanies"], "requested company counts 不一致");
    }
    if (
      value.counts.requestedSnapshotTypes !==
        value.query.snapshotTypes.length ||
      value.workBudget.snapshotTypeCount !== value.query.snapshotTypes.length
    ) {
      issue(
        ["counts", "requestedSnapshotTypes"],
        "requested snapshot type counts 不一致",
      );
    }
    if (
      value.pagination.offset !== value.query.offset ||
      value.pagination.limit !== value.query.limit
    ) {
      issue(["pagination"], "pagination 必須與 normalized query 一致");
    }
    const expectedReturnedRows = Math.min(
      value.pagination.limit,
      Math.max(0, value.pagination.totalRows - value.pagination.offset),
    );
    const expectedHasMore =
      value.pagination.offset + expectedReturnedRows <
      value.pagination.totalRows;
    const expectedNextOffset = expectedHasMore
      ? value.pagination.offset + expectedReturnedRows
      : null;
    if (
      value.records.length !== expectedReturnedRows ||
      value.pagination.returnedRows !== expectedReturnedRows ||
      value.counts.returnedRecords !== expectedReturnedRows ||
      value.pagination.hasMore !== expectedHasMore ||
      value.pagination.nextOffset !== expectedNextOffset
    ) {
      issue(
        ["pagination"],
        "records、counts 與 stateless offset pagination 不一致",
      );
    }
    if (
      value.counts.totalRecords !== value.pagination.totalRows ||
      value.counts.totalRecords !==
        value.sources.reduce(
          (sum, source) => sum + source.selectedRecordCount,
          0,
        )
    ) {
      issue(
        ["counts", "totalRecords"],
        "totalRecords 必須等於 pagination total 與各 route selected records 總和",
      );
    }

    if (
      value.workBudget.plannedSourceRoutes !== value.sources.length ||
      value.workBudget.supportedSourceQueries +
        value.workBudget.unsupportedSourceRoutes !==
        value.workBudget.plannedSourceRoutes ||
      value.workBudget.unsupportedSourceRoutes !==
        countWhere(value.sources, (source) => source.status === "unsupported")
    ) {
      issue(["workBudget"], "planned、supported 與 unsupported route counts 不一致");
    }
    const routeIds = value.sources.map(
      (source) => `${source.snapshotType}:${source.market}`,
    );
    if (!hasUniqueStrings(routeIds)) {
      issue(["sources"], "每個 snapshotType×market 最多只能有一個 planned route");
    }
    value.sources.forEach((source, index) => {
      const [snapshotType, market, exchange] =
        routeContracts[source.sourceKey];
      if (
        source.snapshotType !== snapshotType ||
        source.market !== market ||
        source.exchange !== exchange
      ) {
        issue(
          ["sources", index, "sourceKey"],
          "sourceKey 必須與固定 snapshotType／market／exchange route 一致",
        );
      }
      const isUnsupportedKey =
        source.sourceKey ===
        "tpex_dividend_decision_current_unsupported";
      if (isUnsupportedKey !== (source.status === "unsupported")) {
        issue(
          ["sources", index, "status"],
          "只有固定 TPEx dividend route 可標 unsupported，且該 route 必須 unsupported",
        );
      }
      if (
        !hasUniqueStrings(source.requestedCompanyCodes) ||
        source.requestedCompanyCodes.some(
          (companyCode) => !requestedCodes.has(companyCode),
        )
      ) {
        issue(
          ["sources", index, "requestedCompanyCodes"],
          "source requestedCompanyCodes 必須是 query 的唯一子集",
        );
      }
    });

    const sourceComplete = value.sources.every(
      (source) =>
        (source.status === "nonempty" ||
          source.status === "verified_empty") &&
        source.freshness === "within_expected_window",
    );
    if (value.coverage.sourceComplete !== sourceComplete) {
      issue(
        ["coverage", "sourceComplete"],
        "sourceComplete 只能在所有 planned routes 都 fresh、supported 且成功時為 true",
      );
    }
    const selectionComplete = value.coverage.snapshots.every(
      (snapshot) => snapshot.status === "complete",
    );
    if (
      value.coverage.selection !==
      (selectionComplete ? "complete" : "partial")
    ) {
      issue(
        ["coverage", "selection"],
        "coverage.selection 必須由 company×family coverage statuses 決定",
      );
    }
    const expectedCoverageCount =
      value.query.companyCodes.length * value.query.snapshotTypes.length;
    const coverageIds = value.coverage.snapshots.map(
      (snapshot) => `${snapshot.companyCode}:${snapshot.snapshotType}`,
    );
    if (
      value.coverage.snapshots.length !== expectedCoverageCount ||
      !hasUniqueStrings(coverageIds) ||
      value.coverage.snapshots.some(
        (snapshot) =>
          !requestedCodes.has(snapshot.companyCode) ||
          !requestedTypes.has(snapshot.snapshotType),
      )
    ) {
      issue(
        ["coverage", "snapshots"],
        "coverage 必須恰好包含每個 requested company×snapshotType 一列",
      );
    }
    value.coverage.snapshots.forEach((snapshot, index) => {
      if (!hasUniqueStrings(snapshot.routedMarkets)) {
        issue(
          ["coverage", "snapshots", index, "routedMarkets"],
          "routedMarkets 不得重複",
        );
      }
      if (
        snapshot.disclosureStatus === "disclosed" &&
        snapshot.recordCount < 1
      ) {
        issue(
          ["coverage", "snapshots", index, "recordCount"],
          "disclosed coverage 必須至少有一筆 record",
        );
      }
      if (
        snapshot.disclosureStatus === "not_disclosed_in_snapshot" &&
        (snapshot.recordCount !== 0 ||
          snapshot.status !== "complete" ||
          snapshot.freshness !== "within_expected_window" ||
          snapshot.identityStatus === "unverified" ||
          snapshot.failureIds.length > 0)
      ) {
        issue(
          ["coverage", "snapshots", index, "disclosureStatus"],
          "not_disclosed 只允許 fresh、identity-verified、無 failure 的 complete absence",
        );
      }
      if (
        snapshot.disclosureStatus === "unknown_stale_snapshot" &&
        snapshot.freshness !== "stale"
      ) {
        issue(
          ["coverage", "snapshots", index, "freshness"],
          "unknown_stale_snapshot 必須有 stale freshness",
        );
      }
      if (
        snapshot.disclosureStatus === "unknown_source_failure" &&
        snapshot.failureIds.length === 0
      ) {
        issue(
          ["coverage", "snapshots", index, "failureIds"],
          "unknown_source_failure 必須引用至少一個 failure",
        );
      }
      if (
        snapshot.disclosureStatus === "identity_unverified" &&
        snapshot.identityStatus !== "unverified"
      ) {
        issue(
          ["coverage", "snapshots", index, "identityStatus"],
          "identity_unverified disclosure 必須搭配 unverified identity",
        );
      }
    });

    const companyCodes = value.companies.map((company) => company.companyCode);
    if (
      value.companies.length !== value.query.companyCodes.length ||
      !hasUniqueStrings(companyCodes) ||
      companyCodes.some((companyCode) => !requestedCodes.has(companyCode))
    ) {
      issue(["companies"], "companies 必須恰好涵蓋 requested company codes");
    }
    if (
      value.companies.reduce(
        (sum, company) => sum + company.recordCount,
        0,
      ) !== value.counts.totalRecords ||
      value.coverage.snapshots.reduce(
        (sum, snapshot) => sum + snapshot.recordCount,
        0,
      ) !== value.counts.totalRecords
    ) {
      issue(
        ["companies"],
        "company／coverage recordCount 總和必須等於分頁前 totalRecords",
      );
    }
    value.companies.forEach((company, index) => {
      const companyCoverage = value.coverage.snapshots.filter(
        (snapshot) => snapshot.companyCode === company.companyCode,
      );
      const expectedStatus = companyCoverage.every(
        (snapshot) => snapshot.status === "complete",
      )
        ? "complete"
        : companyCoverage.every((snapshot) => snapshot.status === "failed")
          ? "failed"
          : "partial";
      const orderedFor = (
        predicate: (snapshot: (typeof companyCoverage)[number]) => boolean,
      ) =>
        canonicalSnapshotTypes.filter((snapshotType) =>
          companyCoverage.some(
            (snapshot) =>
              snapshot.snapshotType === snapshotType && predicate(snapshot),
          ),
        );
      const expectedDisclosed = orderedFor(
        (snapshot) => snapshot.disclosureStatus === "disclosed",
      );
      const expectedNotDisclosed = orderedFor(
        (snapshot) =>
          snapshot.disclosureStatus === "not_disclosed_in_snapshot",
      );
      const expectedStale = orderedFor(
        (snapshot) => snapshot.freshness === "stale",
      );
      const expectedUnsupported = orderedFor(
        (snapshot) =>
          snapshot.status === "unsupported" ||
          snapshot.sourceKeys.includes(
            "tpex_dividend_decision_current_unsupported",
          ),
      );
      const expectedFailed = orderedFor(
        (snapshot) =>
          snapshot.status === "failed" || snapshot.failureIds.length > 0,
      );
      const expectedRecordCount = companyCoverage.reduce(
        (sum, snapshot) => sum + snapshot.recordCount,
        0,
      );
      const identity = companyCoverage[0];
      const identityConsistent =
        identity !== undefined &&
        companyCoverage.every(
          (snapshot) =>
            snapshot.identityStatus === identity.identityStatus &&
            snapshot.resolvedMarket === identity.resolvedMarket,
        );
      if (!identityConsistent) {
        issue(
          ["coverage", "snapshots"],
          `公司 ${company.companyCode} 的 identityStatus／resolvedMarket 必須跨 family 一致`,
        );
      }
      if (
        company.status !== expectedStatus ||
        company.recordCount !== expectedRecordCount ||
        !identity ||
        company.identityStatus !== identity.identityStatus ||
        company.resolvedMarket !== identity.resolvedMarket ||
        !sameStrings(company.disclosedSnapshotTypes, expectedDisclosed) ||
        !sameStrings(
          company.notDisclosedSnapshotTypes,
          expectedNotDisclosed,
        ) ||
        !sameStrings(company.staleSnapshotTypes, expectedStale) ||
        !sameStrings(company.unsupportedSnapshotTypes, expectedUnsupported) ||
        !sameStrings(company.failedSnapshotTypes, expectedFailed)
      ) {
        issue(
          ["companies", index],
          "company summary 必須由對應 coverage.snapshots 精確導出",
        );
      }
    });

    const failedSourceIds = new Set(
      value.sources.flatMap((source) =>
        source.status === "failed" && source.failureId !== null
          ? [source.failureId]
          : [],
      ),
    );
    const failureIds = value.failures.map((failure) => failure.failureId);
    if (
      !hasUniqueStrings(failureIds) ||
      failureIds.some((failureId) => !failedSourceIds.has(failureId)) ||
      [...failedSourceIds].some(
        (failureId) => !failureIds.includes(failureId),
      )
    ) {
      issue(
        ["failures"],
        "failures 與 status=failed sources 必須一對一引用相同 failureId",
      );
    }

    const expectedCounts = {
      completeCompanies: countWhere(
        value.companies,
        (company) => company.status === "complete",
      ),
      partialCompanies: countWhere(
        value.companies,
        (company) => company.status === "partial",
      ),
      failedCompanies: countWhere(
        value.companies,
        (company) => company.status === "failed",
      ),
      nonemptySources: countWhere(
        value.sources,
        (source) => source.status === "nonempty",
      ),
      verifiedEmptySources: countWhere(
        value.sources,
        (source) => source.status === "verified_empty",
      ),
      staleSources: countWhere(
        value.sources,
        (source) => source.freshness === "stale",
      ),
      failedSources: countWhere(
        value.sources,
        (source) => source.status === "failed",
      ),
      unsupportedSources: countWhere(
        value.sources,
        (source) => source.status === "unsupported",
      ),
    };
    for (const [name, expected] of Object.entries(expectedCounts)) {
      if (value.counts[name as keyof typeof expectedCounts] !== expected) {
        issue(["counts", name], `${name} 與實際結果不一致`);
      }
    }

    const generatedAt = Date.parse(value.generatedAt);
    if (!Number.isFinite(generatedAt)) {
      issue(["generatedAt"], "generatedAt 必須是有效 ISO 8601 時間");
    } else {
      const taipeiToday = new Date(generatedAt + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const todayEpoch = strictCalendarDateEpoch(taipeiToday);
      const checkDatedEvidence = (
        sourceSnapshotDate: string,
        sourceSnapshotAgeDays: number,
        path: Array<string | number>,
      ) => {
        const sourceEpoch = strictCalendarDateEpoch(sourceSnapshotDate);
        if (
          todayEpoch === null ||
          sourceEpoch === null ||
          sourceEpoch > todayEpoch ||
          (todayEpoch - sourceEpoch) / 86_400_000 !==
            sourceSnapshotAgeDays
        ) {
          issue(
            path,
            "sourceSnapshotDate 不得晚於 Taipei generated date，且 ageDays 必須精確一致",
          );
        }
      };
      value.sources.forEach((source, index) => {
        if (
          source.sourceSnapshotDate !== null &&
          source.sourceSnapshotAgeDays !== null
        ) {
          checkDatedEvidence(
            source.sourceSnapshotDate,
            source.sourceSnapshotAgeDays,
            ["sources", index, "sourceSnapshotDate"],
          );
        }
      });
      value.records.forEach((record, index) => {
        checkDatedEvidence(
          record.sourceSnapshotDate,
          record.sourceSnapshotAgeDays,
          ["records", index, "sourceSnapshotDate"],
        );
        if (
          record.upcomingEligible &&
          (record.details.kind !== "shareholder_meeting" ||
            record.details.meetingDate < taipeiToday)
        ) {
          issue(
            ["records", index, "upcomingEligible"],
            "upcomingEligible meeting date 不得早於 Taipei generated date",
          );
        }
        if (
          !requestedCodes.has(record.companyCode) ||
          !requestedTypes.has(record.snapshotType)
        ) {
          issue(
            ["records", index],
            "records 只能包含 requested companies 與 snapshot types",
          );
        }
        const matchingSource = value.sources.find(
          (source) => source.sourceKey === record.sourceKey,
        );
        if (
          !matchingSource ||
          matchingSource.status !== "nonempty" ||
          matchingSource.sourceSnapshotDate !== record.sourceSnapshotDate ||
          matchingSource.sourceSnapshotAgeDays !==
            record.sourceSnapshotAgeDays ||
          matchingSource.freshness !== record.freshness
        ) {
          issue(
            ["records", index, "sourceKey"],
            "record 必須引用相同 date／age／freshness 的 nonempty source",
          );
        }
      });
    }

    if (
      !hasUniqueStrings(value.records.map((record) => record.recordId)) ||
      !hasUniqueStrings(
        value.records.map((record) => record.sourceRecordKey),
      )
    ) {
      issue(["records"], "本頁 recordId 與 sourceRecordKey 必須唯一");
    }
  });

