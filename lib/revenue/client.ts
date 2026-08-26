import { companyMasterClient } from "@/lib/company-master/client";
import type { CompanyMarket } from "@/lib/company-master/types";
import {
  assertUniqueCodes,
  fail,
  isEligibleCompanyIdentity,
  normalizeCompactDate,
  normalizeCompactMonth,
  normalizeOptionalText,
  normalizeRequestedCodes,
  normalizeRequiredText,
  OfficialJsonLoader,
  parseOfficialNumber,
  reconcileMarket,
  selectedMarkets,
  validateLatestQuery,
  type JsonSnapshot,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import type {
  CurrentCompanyMasterLike,
  OfficialMarketClientOptions,
} from "@/lib/market-data/types";

import type {
  MonthlyRevenueQuery,
  MonthlyRevenueResult,
  MonthlyRevenueRow,
  MonthlyRevenueSource,
  RevenueValueStatus,
} from "./types";

interface ParsedRevenueSource {
  market: CompanyMarket;
  dataMonth: string;
  sourceReportDate: string;
  rows: MonthlyRevenueRow[];
  source: MonthlyRevenueSource;
}

const SOURCE_CONFIGS: Record<CompanyMarket, OfficialSourceConfig> = {
  listed: {
    market: "listed",
    exchange: "TWSE",
    sourceName: "臺灣證券交易所－上市公司每月營業收入彙總表",
    sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
  },
  otc: {
    market: "otc",
    exchange: "TPEx",
    sourceName: "證券櫃檯買賣中心－上櫃公司每月營業收入彙總表",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
  },
};

const FIELDS = {
  reportDate: "出表日期",
  dataMonth: "資料年月",
  code: "公司代號",
  name: "公司名稱",
  currentMonthRevenue: "營業收入-當月營收",
  previousMonthRevenue: "營業收入-上月營收",
  sameMonthLastYearRevenue: "營業收入-去年當月營收",
  momPercent: "營業收入-上月比較增減(%)",
  yoyPercent: "營業收入-去年同月增減(%)",
  currentYearCumulativeRevenue: "累計營業收入-當月累計營收",
  previousYearCumulativeRevenue: "累計營業收入-去年累計營收",
  cumulativeYoyPercent: "累計營業收入-前期比較增減(%)",
  note: "備註",
} as const;

function revenueNumber(
  raw: unknown,
  multiplier = 1,
): { value: number | null; status: RevenueValueStatus } {
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing) return { value: null, status: "missing" };
  if (parsed.invalid || parsed.value === null) {
    return { value: null, status: "invalid_upstream" };
  }
  const value = parsed.value * multiplier;
  if (!Number.isFinite(value)) {
    return { value: null, status: "invalid_upstream" };
  }
  return { value, status: "reported" };
}

export function normalizeMonthlyRevenuePayload(
  snapshot: JsonSnapshot,
  config: OfficialSourceConfig,
): ParsedRevenueSource {
  if (!Array.isArray(snapshot.payload) || snapshot.payload.length === 0) {
    fail("NO_DATA", `${config.exchange} 最新月營收資料為空。`, {
      market: config.market,
      sourceUrl: config.sourceUrl,
    });
  }

  const dataMonths = new Set<string>();
  const reportDates = new Set<string>();
  const rows: MonthlyRevenueRow[] = [];
  for (const raw of snapshot.payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 月營收資料包含非物件資料列。`, {
        market: config.market,
      });
    }
    const record = raw as Record<string, unknown>;
    const sourceReportDate = normalizeCompactDate(
      record[FIELDS.reportDate],
      FIELDS.reportDate,
    );
    const dataMonth = normalizeCompactMonth(record[FIELDS.dataMonth], FIELDS.dataMonth);
    const code = normalizeRequiredText(record[FIELDS.code], FIELDS.code, config.market);
    const name = normalizeRequiredText(record[FIELDS.name], FIELDS.name, config.market);
    reportDates.add(sourceReportDate);
    dataMonths.add(dataMonth);
    if (!isEligibleCompanyIdentity(code, name)) continue;

    const currentMonth = revenueNumber(record[FIELDS.currentMonthRevenue], 1000);
    const previousMonth = revenueNumber(record[FIELDS.previousMonthRevenue], 1000);
    const sameMonthLastYear = revenueNumber(
      record[FIELDS.sameMonthLastYearRevenue],
      1000,
    );
    const mom = revenueNumber(record[FIELDS.momPercent]);
    const yoy = revenueNumber(record[FIELDS.yoyPercent]);
    const currentCumulative = revenueNumber(
      record[FIELDS.currentYearCumulativeRevenue],
      1000,
    );
    const previousCumulative = revenueNumber(
      record[FIELDS.previousYearCumulativeRevenue],
      1000,
    );
    const cumulativeYoy = revenueNumber(record[FIELDS.cumulativeYoyPercent]);
    rows.push({
      code,
      name,
      market: config.market,
      industryCode: null,
      sourceReportDate,
      currentMonthRevenueTwd: currentMonth.value,
      previousMonthRevenueTwd: previousMonth.value,
      sameMonthLastYearRevenueTwd: sameMonthLastYear.value,
      momPercent: mom.value,
      yoyPercent: yoy.value,
      currentYearCumulativeRevenueTwd: currentCumulative.value,
      previousYearCumulativeRevenueTwd: previousCumulative.value,
      cumulativeYoyPercent: cumulativeYoy.value,
      note: normalizeOptionalText(record[FIELDS.note]),
      valueStatus: {
        currentMonthRevenueTwd: currentMonth.status,
        previousMonthRevenueTwd: previousMonth.status,
        sameMonthLastYearRevenueTwd: sameMonthLastYear.status,
        momPercent: mom.status,
        yoyPercent: yoy.status,
        currentYearCumulativeRevenueTwd: currentCumulative.status,
        previousYearCumulativeRevenueTwd: previousCumulative.status,
        cumulativeYoyPercent: cumulativeYoy.status,
      },
    });
  }

  if (dataMonths.size !== 1 || reportDates.size !== 1 || rows.length === 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 月營收資料無法形成單一有效快照。`, {
      market: config.market,
      dataMonths: [...dataMonths],
      sourceReportDates: [...reportDates],
      eligibleRowCount: rows.length,
    });
  }
  assertUniqueCodes(rows, `${config.exchange} 最新月營收資料`);
  rows.sort((left, right) => left.code.localeCompare(right.code));
  const dataMonth = [...dataMonths][0];
  const sourceReportDate = [...reportDates][0];
  return {
    market: config.market,
    dataMonth,
    sourceReportDate,
    rows,
    source: {
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      rawCount: snapshot.payload.length,
      eligibleRowCount: rows.length,
      dataMonth,
      sourceReportDate,
      sourceAmountUnit: "thousand_TWD",
      outputAmountUnit: "TWD",
      amountMultiplier: 1000,
    },
  };
}

export class MonthlyRevenueClient {
  private readonly loader: OfficialJsonLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CurrentCompanyMasterLike = companyMasterClient,
    options: OfficialMarketClientOptions = {},
  ) {
    this.loader = new OfficialJsonLoader(fetchImpl, now, options);
  }

  async getMonthlyRevenue(query: MonthlyRevenueQuery): Promise<MonthlyRevenueResult> {
    validateLatestQuery(query.dataMonth, "data_month", query.universePolicy);
    const companyCodes = normalizeRequestedCodes(query.companyCodes);
    const markets = selectedMarkets(query.market);

    const [sourceResults, master] = await Promise.all([
      Promise.all(
        markets.map(async (market) => {
          const config = SOURCE_CONFIGS[market];
          return normalizeMonthlyRevenuePayload(await this.loader.get(config), config);
        }),
      ),
      this.companyMaster.listCompanies({
        market: query.market,
        includeFinancial: true,
        includeKy: true,
      }),
    ]);

    const dataMonths = [...new Set(sourceResults.map((result) => result.dataMonth))];
    if (dataMonths.length !== 1) {
      fail(
        "NO_DATA",
        "上市與上櫃最新月營收資料年月不一致，請稍後重試或分市場查詢。",
        {
          sourceMonths: sourceResults.map((result) => ({
            market: result.market,
            dataMonth: result.dataMonth,
          })),
        },
      );
    }

    const sourceRows = sourceResults.flatMap((result) => result.rows);
    assertUniqueCodes(sourceRows, "上市與上櫃最新月營收資料");
    const reconciled = sourceResults.map((source) =>
      reconcileMarket(
        source.market,
        source.rows,
        master.companies,
        query.universePolicy,
      ),
    );
    const reconciliation = reconciled.map((value) => value.reconciliation);
    let rows = reconciled.flatMap((value) =>
      value.acceptedRows.map((row) => ({
        ...row,
        industryCode: value.masterByCode.get(row.code)?.industryCode ?? null,
      })),
    );
    if (companyCodes) {
      const selected = new Set(companyCodes);
      rows = rows.filter((row) => selected.has(row.code));
    }
    rows.sort((left, right) => left.code.localeCompare(right.code));
    const returnedCodes = new Set(rows.map((row) => row.code));
    const missingCompanyCodes = companyCodes
      ? companyCodes.filter((code) => !returnedCodes.has(code))
      : [];
    if (rows.length === 0) {
      fail("NO_DATA", "指定市場與公司條件查無最新官方月營收資料。", {
        market: query.market,
        missingCompanyCodes,
      });
    }

    const expectedCompanyCount = reconciliation.reduce(
      (sum, value) => sum + value.masterCount,
      0,
    );
    const reportedCompanyCount = reconciliation.reduce(
      (sum, value) => sum + value.matchedCount,
      0,
    );
    const filingMissingCompanyCodes = reconciliation
      .flatMap((value) => value.masterMissingCodes)
      .sort();
    const filingCoverage = {
      expectedCompanyCount,
      reportedCompanyCount,
      missingCompanyCodes: filingMissingCompanyCodes,
      coverageRatio:
        expectedCompanyCount === 0 ? 0 : reportedCompanyCount / expectedCompanyCount,
      complete: filingMissingCompanyCodes.length === 0,
    };

    const warnings = [
      "latest 代表官方目前彙總的最近資料年月；資料可能在法定申報期限內持續增加。",
      "營收金額已由官方仟元乘以 1,000 正規化為 TWD；百分比沿用官方值，不由本工具重算。",
      "sourceReportDate 是官方資料集出表日期，不是個別公司的申報時間 filedAt。",
    ];
    if (!filingCoverage.complete) {
      warnings.push(
        `目前公司母體尚有 ${filingMissingCompanyCodes.length} 家未出現在最新月營收彙總；可能源於申報進度、資料適用性或公司狀態差異，請使用 filingCoverage 判讀並回查官方申報。`,
      );
    }
    const marketOnlyCodes = reconciliation.flatMap((value) => value.marketOnlyCodes);
    if (marketOnlyCodes.length > 0) {
      warnings.push(
        query.universePolicy === "strict_current_master"
          ? `以下官方申報代號不在目前公司母體，已依 strict_current_master 排除：${marketOnlyCodes.join("、")}。`
          : `以下官方申報代號不在目前公司母體，已依 compatible 保留且 industryCode 為 null：${marketOnlyCodes.join("、")}。`,
      );
    }
    if (missingCompanyCodes.length > 0) {
      warnings.push(
        `以下指定代號未出現在本次結果：${missingCompanyCodes.join("、")}。`,
      );
    }
    const invalidFieldCount = rows.reduce(
      (sum, row) =>
        sum +
        Object.values(row.valueStatus).filter((status) => status === "invalid_upstream")
          .length,
      0,
    );
    if (invalidFieldCount > 0) {
      warnings.push(
        `本次有 ${invalidFieldCount} 個月營收欄位為無法解析的官方值，已回傳 null 與 invalid_upstream。`,
      );
    }

    return {
      query: {
        ...query,
        ...(companyCodes ? { companyCodes } : {}),
      },
      dataMonth: dataMonths[0],
      currency: "TWD",
      amountUnit: "TWD",
      coverageComplete: true,
      selectionComplete: missingCompanyCodes.length === 0,
      missingCompanyCodes,
      filingCoverage,
      reconciliation,
      counts: {
        listed: rows.filter((row) => row.market === "listed").length,
        otc: rows.filter((row) => row.market === "otc").length,
        returned: rows.length,
      },
      rows,
      sources: sourceResults.map((result) => result.source),
      warnings,
    };
  }
}

export const monthlyRevenueClient = new MonthlyRevenueClient();
