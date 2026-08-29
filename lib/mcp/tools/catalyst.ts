import { defineTool } from "./definition";
import type { FreshnessEvaluation, ResultMetaHints } from "./shared";
import {
  asMopsfinError,
  FRESHNESS_POLICIES,
  annotations,
  catalystClient,
  companyCatalystEventsInputSchema,
  companyCatalystEventsOutputSchema,
  companyCatalystSnapshotClient,
  companyCatalystSnapshotsInputSchema,
  companyCatalystSnapshotsOutputSchema,
  companyMasterClient,
  evaluateFreshness,
  selectorFreshness,
  success,
  taipeiDate,
} from "./shared";

export const getCompanyCatalystEventsTool = defineTool(
    "get_company_catalyst_events",
    {
      title: "查詢公司官方催化事件",
      description:
        "查詢 1–20 家台股公司在明確 YYYY-MM-DD 起訖範圍內的官方重大訊息與法人說明會事件；含首尾最多 366 日，且公司×月份×event family 加上 recent snapshot 的 catalyst 查詢工作單位合計上限為 40，retry attempt 不重複計數。工具只以目前上市櫃 master 驗證 current identity、縮小近期重大訊息 snapshot 市場；歷史法說固定查上市與上櫃兩個 TYPEK，以免 current market hint 漏掉轉板前事件，不能把目前 master 冒充歷史母體。若代號不在目前 master 且範圍內也沒有官方事件列，meta.quality.selection=partial，不能宣稱該公司 identity 已驗證。重大訊息使用 MOPS 歷史查詢並在近期範圍以 TWSE／TPEx current OpenAPI 補強，法說會使用 MOPS 歷史日曆；只回官方已發布或已排定證據。publishedAt、factDate、scheduledAt、effectiveAt 分開，confirmed 不等於正面催化；沒有公司財測、分析師 EPS／營收 consensus、預估修正、目標價、情緒或 impact score，也不做買賣建議。合法無事件只在官方空結果可驗證時成立；上游、security block 或 parser failure 會按 company×eventType×month 隔離至 failures，不能當成空值。offset 分頁每頁重新查詢並組裝來源，不是 point-in-time snapshot；續頁必須沿用相同 query，並檢查 fingerprint 與 meta.asOf.snapshotId 是否改變。",
      inputSchema: companyCatalystEventsInputSchema,
      outputSchema: companyCatalystEventsOutputSchema,
      annotations,
    },
    async ({
      company_codes,
      start_date,
      end_date,
      event_types,
      offset,
      limit,
    }) => {
        let marketHintWarning: string | null = null;
        let marketHintIssueCode:
          | "CATALYST_MARKET_HINT_PARTIAL"
          | "CATALYST_MARKET_HINT_UNAVAILABLE"
          | null = null;
        let marketHintMissingCodes: string[] = [];
        let companyMarkets:
          | Array<{ companyCode: string; market: "listed" | "otc" }>
          | undefined;
        try {
          const master = await companyMasterClient.listCompanies({
            market: "all",
            includeFinancial: true,
            includeKy: true,
          });
          const requestedCodes = new Set(company_codes);
          companyMarkets = master.companies
            .filter((company) => requestedCodes.has(company.code))
            .map((company) => ({
              companyCode: company.code,
              market: company.market,
            }));
          const matchedCodes = new Set(
            companyMarkets.map((company) => company.companyCode),
          );
          marketHintMissingCodes = company_codes.filter(
            (code) => !matchedCodes.has(code),
          );
          if (marketHintMissingCodes.length > 0) {
            marketHintIssueCode = "CATALYST_MARKET_HINT_PARTIAL";
            marketHintWarning = `目前公司 master 找不到 ${marketHintMissingCodes.join(", ")}；近期重大訊息補強會對未匹配代號安全探測兩市場，且目前 master 不會被冒充為歷史 identity。歷史法說無論 hint 都固定查兩市場。`;
          }
        } catch (marketHintError) {
          const normalized = asMopsfinError(marketHintError);
          marketHintIssueCode = "CATALYST_MARKET_HINT_UNAVAILABLE";
          marketHintMissingCodes = [...company_codes];
          marketHintWarning = `目前公司 master identity／近期重大訊息市場提示不可用（${normalized.code}）；current snapshot 會安全探測兩市場。歷史法說無論 hint 都固定查兩市場。`;
        }
        const data = await catalystClient.getCompanyCatalystEvents({
          companyCodes: company_codes,
          startDate: start_date,
          endDate: end_date,
          eventTypes: event_types,
          offset,
          limit,
          ...(companyMarkets && companyMarkets.length > 0
            ? { companyMarkets }
            : {}),
        });
        const outputData = marketHintWarning
          ? { ...data, warnings: [...data.warnings, marketHintWarning] }
          : data;
        const affectedCompanyCodes = [
          ...new Set(data.failures.map((item) => item.companyCode)),
        ];
        const officiallyIdentifiedCodes = new Set(
          data.companies
            .filter((company) => company.eventCount > 0)
            .map((company) => company.companyCode),
        );
        const unverifiedIdentityCodes = marketHintMissingCodes.filter(
          (code) => !officiallyIdentifiedCodes.has(code),
        );
        const sourceUrls = [
          ...new Set(data.sources.map((item) => item.sourceUrl)),
        ];
        const issues: NonNullable<ResultMetaHints["issues"]> = [
          ...(data.failures.length > 0
            ? [
                {
                  code: "CATALYST_COMPANY_FAMILY_FAILED",
                  severity: "warning" as const,
                  scope: "source" as const,
                  message:
                    "部分 company×eventType×month 官方查詢失敗；其他成功事件仍保留，失敗不可解讀為無事件。",
                  refs: {
                    companyCodes: affectedCompanyCodes,
                    fields: ["failures", "familyCoverage", "companies"],
                    periods: [...new Set(data.failures.map((item) => item.queryMonth))],
                    sourceUrls,
                  },
                },
              ]
            : []),
          ...(data.pagination.hasMore || data.pagination.offset > 0
            ? [
                {
                  code: "CATALYST_OFFSET_PAGE_NOT_PINNED",
                  severity: "info" as const,
                  scope: "page" as const,
                  message:
                    "offset 續頁會重新查詢官方來源；不是跨頁 point-in-time snapshot，fingerprint 改變時應由 offset=0 重查。",
                  refs: {
                    companyCodes: data.query.companyCodes,
                    fields: ["pagination", "fingerprint"],
                    periods: [data.query.startDate, data.query.endDate],
                    sourceUrls,
                  },
                },
              ]
            : []),
          {
            code: "OFFICIAL_DISCLOSURE_NOT_CONSENSUS",
            severity: "info" as const,
            scope: "value" as const,
            message:
              "官方公告與公司排定事件不是分析師 consensus，也不代表正面、負面或市場尚未反應。",
            refs: {
              companyCodes: data.query.companyCodes,
              fields: ["isConsensus", "events", "warnings"],
              periods: [data.query.startDate, data.query.endDate],
              sourceUrls,
            },
          },
          ...(marketHintWarning && marketHintIssueCode
            ? [
                {
                  code: marketHintIssueCode,
                  severity: "info" as const,
                  scope: "universe" as const,
                  message: marketHintWarning,
                  refs: {
                    companyCodes: data.query.companyCodes,
                    fields: ["workBudget", "sources[].market"],
                    periods: [data.query.startDate, data.query.endDate],
                    sourceUrls: [],
                  },
                },
              ]
            : []),
          ...(unverifiedIdentityCodes.length > 0
            ? [
                {
                  code: "CATALYST_COMPANY_IDENTITY_UNVERIFIED",
                  severity: "warning" as const,
                  scope: "selection" as const,
                  message:
                    "部分代號不在目前公司 master，且 requested 範圍沒有可確認公司名稱／市場的官方事件列；合法空事件回應不能另外證明公司 identity。",
                  refs: {
                    companyCodes: unverifiedIdentityCodes,
                    fields: ["companies", "events", "meta.quality.selection"],
                    periods: [data.query.startDate, data.query.endDate],
                    sourceUrls,
                  },
                },
              ]
            : []),
        ];
        return success(
          `官方事件查詢完成：${data.counts.requestedCompanies} 家公司、${data.counts.totalEvents} 筆事件，本頁回傳 ${data.counts.returnedEvents} 筆；${data.failures.length} 個月份查詢 failure 已隔離。`,
          outputData,
          {
            selector: "range",
            resolved: {
              granularity: "date",
              from: data.query.startDate,
              through: data.query.endDate,
            },
            page: {
              mode: "offset",
              unit: "row",
              limit: data.pagination.limit,
              returned: data.pagination.returnedRows,
              total: data.pagination.totalRows,
              next:
                data.pagination.nextOffset === null
                  ? null
                  : {
                      kind: "offset",
                      offset: data.pagination.nextOffset,
                    },
            },
            snapshotId: data.fingerprint,
            source: data.coverage.sourceComplete ? "complete" : "partial",
            universe: "not_applicable",
            selection:
              data.companies.length === data.query.companyCodes.length &&
              data.failures.length === 0 &&
              unverifiedIdentityCodes.length === 0
                ? "complete"
                : "partial",
            values: data.failures.length === 0 ? "complete" : "partial",
            freshnessDetails: selectorFreshness({
              selector: "range",
              observedAsOf: data.query.endDate,
              sources: data.sources,
            }),
            issues,
          },
        );
    },
);

export const getCompanyCatalystSnapshotsTool = defineTool(
    "get_company_catalyst_snapshots",
    {
      title: "查詢公司官方催化快照",
      description:
        "查詢 1–20 家台股公司的 current official snapshot evidence：公司財測達成、財測重大差異名單、股東會排程與股利決議；as_of 固定 latest，不接受歷史日期。工具依目前上市櫃 master 縮小 current source routes，未匹配代號會安全探測雙市場；共享 full-market source failure 按 snapshotType×market 隔離，不能當成合法空值。sourceSnapshotDate 是官方出表日，不是 factDate、首次公告日或 firstKnownAt；pointInTimeHistoryAvailable 固定 false。距 Asia/Taipei latest 超過 7 日為 stale，stale／failed／unsupported 不得解讀為 current no-data；只有 fresh、schema-valid snapshot 可標 not_disclosed_in_snapshot。upcomingEligible 只可能用於 fresh 且會議日未過的股東會；公司財測與官方揭露不是分析師 consensus。TPEx 沒有可用 current dividend endpoint，固定明示 unsupported，且不使用停在 2021 年的 t187ap39_O 冒充。董事會（擬議）股利分派日是 board action date、不是股利支付日。最多規劃 8 個 family×market routes；offset 續頁會重新查來源，必須核對 fingerprint／meta.asOf.snapshotId。工具不產生情緒、impact score、買賣建議，也不改變 screening 分數。",
      inputSchema: companyCatalystSnapshotsInputSchema,
      outputSchema: companyCatalystSnapshotsOutputSchema,
      annotations,
    },
    async ({ company_codes, snapshot_types, as_of, offset, limit }) => {
        let marketHintWarning: string | null = null;
        let marketHintIssueCode:
          | "CATALYST_SNAPSHOT_MARKET_HINT_PARTIAL"
          | "CATALYST_SNAPSHOT_MARKET_HINT_UNAVAILABLE"
          | null = null;
        let marketHintMissingCodes: string[] = [];
        let companyMarkets:
          | Array<{ companyCode: string; market: "listed" | "otc" }>
          | undefined;
        try {
          const master = await companyMasterClient.listCompanies({
            market: "all",
            includeFinancial: true,
            includeKy: true,
          });
          const requestedCodes = new Set(company_codes);
          companyMarkets = master.companies
            .filter((company) => requestedCodes.has(company.code))
            .map((company) => ({
              companyCode: company.code,
              market: company.market,
            }));
          const matchedCodes = new Set(
            companyMarkets.map((company) => company.companyCode),
          );
          marketHintMissingCodes = company_codes.filter(
            (code) => !matchedCodes.has(code),
          );
          if (marketHintMissingCodes.length > 0) {
            marketHintIssueCode = "CATALYST_SNAPSHOT_MARKET_HINT_PARTIAL";
            marketHintWarning = `目前公司 master 找不到 ${marketHintMissingCodes.join(", ")}；current snapshot 將對未匹配代號安全探測上市與上櫃 routes，合法空快照不會另行證明公司 identity。`;
          }
        } catch (marketHintError) {
          const normalized = asMopsfinError(marketHintError);
          marketHintIssueCode = "CATALYST_SNAPSHOT_MARKET_HINT_UNAVAILABLE";
          marketHintMissingCodes = [...company_codes];
          marketHintWarning = `目前公司 master identity／市場 routing 不可用（${normalized.code}）；current snapshot 將安全探測上市與上櫃 routes。`;
        }

        const data =
          await companyCatalystSnapshotClient.getCompanyCatalystSnapshots({
            companyCodes: company_codes,
            snapshotTypes: snapshot_types,
            companyMarkets,
            asOf: as_of,
            offset,
            limit,
          });
        const outputData = marketHintWarning
          ? { ...data, warnings: [...data.warnings, marketHintWarning] }
          : data;
        const sourceUrls = [
          ...new Set(
            data.sources.flatMap((item) =>
              item.sourceUrl === null ? [] : [item.sourceUrl],
            ),
          ),
        ];
        const staleSources = data.sources.filter(
          (item) => item.freshness === "stale",
        );
        const unsupportedSources = data.sources.filter(
          (item) => item.status === "unsupported",
        );
        const unverifiedIdentityCodes = data.companies
          .filter((company) => company.identityStatus === "unverified")
          .map((company) => company.companyCode);
        const successfulSnapshotDates = data.sources.flatMap((item) =>
          item.sourceSnapshotDate === null ? [] : [item.sourceSnapshotDate],
        );
        const orderedSnapshotDates = [...new Set(successfulSnapshotDates)].sort();
        const expectedSnapshotDate = taipeiDate(data.generatedAt);
        const snapshotFreshnessDetails = data.sources.flatMap(
          (item): FreshnessEvaluation[] => {
            if (item.status === "unsupported") return [];
            const itemSourceUrls = item.sourceUrl ? [item.sourceUrl] : [];
            if (item.status === "failed") {
              return [
                evaluateFreshness({
                  policy: FRESHNESS_POLICIES.unspecified,
                  observedAsOf: null,
                  expectedAsOf: null,
                  sourceUrls: itemSourceUrls,
                }),
              ];
            }
            return [
              evaluateFreshness({
                policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
                observedAsOf: item.sourceSnapshotDate,
                expectedAsOf: expectedSnapshotDate,
                sourceUrls: itemSourceUrls,
              }),
            ];
          },
        );
        if (snapshotFreshnessDetails.length === 0) {
          snapshotFreshnessDetails.push(
            evaluateFreshness({
              policy: FRESHNESS_POLICIES.unspecified,
              observedAsOf: null,
              expectedAsOf: null,
              sourceUrls,
            }),
          );
        }
        const issues: NonNullable<ResultMetaHints["issues"]> = [
          ...(data.failures.length > 0
            ? [
                {
                  code: "CATALYST_SNAPSHOT_SOURCE_FAILED",
                  severity: "warning" as const,
                  scope: "source" as const,
                  message:
                    "部分 snapshotType×market 官方 route 失敗；其他成功 records 仍保留，失敗不得解讀為 current no-data。",
                  refs: {
                    companyCodes: [
                      ...new Set(
                        data.failures.flatMap(
                          (item) => item.affectedCompanyCodes,
                        ),
                      ),
                    ],
                    fields: ["failures", "sources", "coverage.snapshots"],
                    periods: [],
                    sourceUrls,
                  },
                },
              ]
            : []),
          ...(staleSources.length > 0
            ? [
                {
                  code: "CATALYST_SNAPSHOT_SOURCE_STALE",
                  severity: "warning" as const,
                  scope: "period" as const,
                  message:
                    "部分官方 snapshot 超過 7 日 freshness window；其缺列不能解讀為目前未揭露，且不得形成 upcoming evidence。",
                  refs: {
                    companyCodes: [
                      ...new Set(
                        staleSources.flatMap(
                          (item) => item.requestedCompanyCodes,
                        ),
                      ),
                    ],
                    fields: [
                      "sources.sourceSnapshotDate",
                      "sources.freshness",
                      "coverage.snapshots.disclosureStatus",
                    ],
                    periods: staleSources.flatMap((item) =>
                      item.sourceSnapshotDate === null
                        ? []
                        : [item.sourceSnapshotDate],
                    ),
                    sourceUrls: staleSources.flatMap((item) =>
                      item.sourceUrl === null ? [] : [item.sourceUrl],
                    ),
                  },
                },
              ]
            : []),
          ...(unsupportedSources.length > 0
            ? [
                {
                  code: "CATALYST_SNAPSHOT_ROUTE_UNSUPPORTED",
                  severity: "warning" as const,
                  scope: "source" as const,
                  message:
                    "部分 market×family 沒有可用 current official route；目前 TPEx 股利決議固定 unsupported，不以 legacy stale dataset 代替。",
                  refs: {
                    companyCodes: [
                      ...new Set(
                        unsupportedSources.flatMap(
                          (item) => item.requestedCompanyCodes,
                        ),
                      ),
                    ],
                    fields: ["sources.status", "coverage.snapshots"],
                    periods: [],
                    sourceUrls: [],
                  },
                },
              ]
            : []),
          {
            code: "CATALYST_SNAPSHOT_NO_POINT_IN_TIME_HISTORY",
            severity: "info" as const,
            scope: "period" as const,
            message:
              "這些 endpoints 是當次 full-market snapshot，不能回放歷史 vintage；sourceSnapshotDate 不會代填 firstKnownAt。",
            refs: {
              companyCodes: data.query.companyCodes,
              fields: [
                "pointInTimeHistoryAvailable",
                "sourceSnapshotDate",
                "firstKnownAt",
              ],
              periods: orderedSnapshotDates,
              sourceUrls,
            },
          },
          {
            code: "OFFICIAL_DISCLOSURE_NOT_CONSENSUS",
            severity: "info" as const,
            scope: "value" as const,
            message:
              "公司財測達成／重大差異與其他官方 snapshot evidence 不是分析師 consensus、預估修正或投資建議。",
            refs: {
              companyCodes: data.query.companyCodes,
              fields: ["isConsensus", "records"],
              periods: orderedSnapshotDates,
              sourceUrls,
            },
          },
          ...(data.pagination.hasMore || data.pagination.offset > 0
            ? [
                {
                  code: "CATALYST_SNAPSHOT_OFFSET_PAGE_NOT_PINNED",
                  severity: "info" as const,
                  scope: "page" as const,
                  message:
                    "offset 續頁會重新讀取 current official snapshots；fingerprint 改變時應由 offset=0 重查。",
                  refs: {
                    companyCodes: data.query.companyCodes,
                    fields: ["pagination", "fingerprint"],
                    periods: orderedSnapshotDates,
                    sourceUrls,
                  },
                },
              ]
            : []),
          ...(marketHintWarning && marketHintIssueCode
            ? [
                {
                  code: marketHintIssueCode,
                  severity: "info" as const,
                  scope: "universe" as const,
                  message: marketHintWarning,
                  refs: {
                    companyCodes: marketHintMissingCodes,
                    fields: ["query.companyMarkets", "companies.identityStatus"],
                    periods: [],
                    sourceUrls: [],
                  },
                },
              ]
            : []),
          ...(unverifiedIdentityCodes.length > 0
            ? [
                {
                  code: "CATALYST_SNAPSHOT_COMPANY_IDENTITY_UNVERIFIED",
                  severity: "warning" as const,
                  scope: "selection" as const,
                  message:
                    "部分代號不在目前公司 master，也沒有 snapshot record 可確認 current identity；合法空 snapshot 不能證明公司存在。",
                  refs: {
                    companyCodes: unverifiedIdentityCodes,
                    fields: ["companies.identityStatus", "coverage.snapshots"],
                    periods: orderedSnapshotDates,
                    sourceUrls,
                  },
                },
              ]
            : []),
        ];
        return success(
          `官方 catalyst snapshots 查詢完成：${data.counts.requestedCompanies} 家公司、${data.counts.totalRecords} 筆 records，本頁回傳 ${data.counts.returnedRecords} 筆；stale=${data.counts.staleSources}、failed=${data.counts.failedSources}、unsupported=${data.counts.unsupportedSources}。`,
          outputData,
          {
            selector: "latest",
            resolved:
              orderedSnapshotDates.length === 0
                ? { granularity: "none", from: null, through: null }
                : {
                    granularity:
                      orderedSnapshotDates.length === 1 ? "date" : "mixed",
                    from: orderedSnapshotDates[0] ?? null,
                    through: orderedSnapshotDates.at(-1) ?? null,
                  },
            page: {
              mode: "offset",
              unit: "row",
              limit: data.pagination.limit,
              returned: data.pagination.returnedRows,
              total: data.pagination.totalRows,
              next:
                data.pagination.nextOffset === null
                  ? null
                  : {
                      kind: "offset",
                      offset: data.pagination.nextOffset,
                    },
            },
            snapshotId: data.fingerprint,
            source: data.coverage.sourceComplete ? "complete" : "partial",
            universe:
              marketHintMissingCodes.length === 0 ? "verified" : "unverified",
            selection: data.coverage.selection,
            values: data.failures.length === 0 ? "complete" : "partial",
            freshnessDetails: snapshotFreshnessDetails,
            issues,
          },
        );
    },
);

export const catalystTools = [
  getCompanyCatalystEventsTool,
  getCompanyCatalystSnapshotsTool,
] as const;
