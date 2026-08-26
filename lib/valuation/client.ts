import { companyMasterClient } from "@/lib/company-master/client";
import type { CompanyMarket } from "@/lib/company-master/types";
import {
  assertUniqueCodes,
  classificationPolicyFor,
  fail,
  isEligibleCompanyIdentity,
  normalizeCompactDate,
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
  DailyMarketValuationQuery,
  DailyMarketValuationResult,
  ValuationRow,
  ValuationSource,
  ValuationValueStatus,
} from "./types";

interface ParsedValuationSource {
  market: CompanyMarket;
  dataDate: string;
  rows: ValuationRow[];
  source: ValuationSource;
}

const SOURCE_CONFIGS: Record<CompanyMarket, OfficialSourceConfig> = {
  listed: {
    market: "listed",
    exchange: "TWSE",
    sourceName: "臺灣證券交易所－上市股票本益比、殖利率及股價淨值比",
    sourceUrl: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  },
  otc: {
    market: "otc",
    exchange: "TPEx",
    sourceName: "證券櫃檯買賣中心－上櫃股票本益比分析",
    sourceUrl:
      "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
  },
};

function valuationNumber(raw: unknown): {
  value: number | null;
  status: ValuationValueStatus;
} {
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing) {
    return { value: null, status: "missing_or_not_meaningful" };
  }
  if (parsed.invalid || parsed.value === null || parsed.value < 0) {
    return { value: null, status: "invalid_upstream" };
  }
  return { value: parsed.value, status: "reported" };
}

function fieldsFor(market: CompanyMarket): {
  date: string;
  code: string;
  name: string;
  pe: string;
  pb: string;
  dividendYield: string;
} {
  return market === "listed"
    ? {
        date: "Date",
        code: "Code",
        name: "Name",
        pe: "PEratio",
        pb: "PBratio",
        dividendYield: "DividendYield",
      }
    : {
        date: "Date",
        code: "SecuritiesCompanyCode",
        name: "CompanyName",
        pe: "PriceEarningRatio",
        pb: "PriceBookRatio",
        dividendYield: "YieldRatio",
      };
}

export function normalizeValuationPayload(
  snapshot: JsonSnapshot,
  config: OfficialSourceConfig,
): ParsedValuationSource {
  if (!Array.isArray(snapshot.payload) || snapshot.payload.length === 0) {
    fail("NO_DATA", `${config.exchange} 最新估值資料為空。`, {
      market: config.market,
      sourceUrl: config.sourceUrl,
    });
  }

  const fields = fieldsFor(config.market);
  const dataDates = new Set<string>();
  const rows: ValuationRow[] = [];
  for (const raw of snapshot.payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 估值資料包含非物件資料列。`, {
        market: config.market,
      });
    }
    const record = raw as Record<string, unknown>;
    const dataDate = normalizeCompactDate(record[fields.date], fields.date);
    const code = normalizeRequiredText(record[fields.code], fields.code, config.market);
    const name = normalizeRequiredText(record[fields.name], fields.name, config.market);
    dataDates.add(dataDate);
    if (!isEligibleCompanyIdentity(code, name)) continue;

    const pe = valuationNumber(record[fields.pe]);
    const pb = valuationNumber(record[fields.pb]);
    const dividendYield = valuationNumber(record[fields.dividendYield]);
    rows.push({
      code,
      name,
      market: config.market,
      peRatio: pe.value,
      priceToBookRatio: pb.value,
      dividendYieldPercent: dividendYield.value,
      valueStatus: {
        peRatio: pe.status,
        priceToBookRatio: pb.status,
        dividendYieldPercent: dividendYield.status,
      },
    });
  }

  if (dataDates.size !== 1 || rows.length === 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 估值資料無法形成單一有效快照。`, {
      market: config.market,
      dataDates: [...dataDates],
      eligibleRowCount: rows.length,
    });
  }
  assertUniqueCodes(rows, `${config.exchange} 最新估值資料`);
  rows.sort((left, right) => left.code.localeCompare(right.code));
  const dataDate = [...dataDates][0];
  return {
    market: config.market,
    dataDate,
    rows,
    source: {
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      dataDate,
      rawCount: snapshot.payload.length,
      eligibleRowCount: rows.length,
    },
  };
}

export class ValuationClient {
  private readonly loader: OfficialJsonLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CurrentCompanyMasterLike = companyMasterClient,
    options: OfficialMarketClientOptions = {},
  ) {
    this.loader = new OfficialJsonLoader(fetchImpl, now, options);
  }

  async getDailyMarketValuation(
    query: DailyMarketValuationQuery,
  ): Promise<DailyMarketValuationResult> {
    validateLatestQuery(query.date, "date", query.universePolicy);
    const companyCodes = normalizeRequestedCodes(query.companyCodes);
    const markets = selectedMarkets(query.market);

    const [sourceResults, master] = await Promise.all([
      Promise.all(
        markets.map(async (market) => {
          const config = SOURCE_CONFIGS[market];
          return normalizeValuationPayload(await this.loader.get(config), config);
        }),
      ),
      this.companyMaster.listCompanies({
        market: query.market,
        includeFinancial: true,
        includeKy: true,
      }),
    ]);

    const dates = [...new Set(sourceResults.map((result) => result.dataDate))];
    if (dates.length !== 1) {
      fail(
        "NO_DATA",
        "上市與上櫃最新估值資料日期不一致，請稍後重試或分市場查詢。",
        {
          sourceDates: sourceResults.map((result) => ({
            market: result.market,
            dataDate: result.dataDate,
          })),
        },
      );
    }

    const sourceRows = sourceResults.flatMap((result) => result.rows);
    assertUniqueCodes(sourceRows, "上市與上櫃最新估值資料");
    const reconciled = sourceResults.map((source) =>
      reconcileMarket(
        source.market,
        source.rows,
        master.companies,
        query.universePolicy,
      ),
    );
    const reconciliation = reconciled.map((value) => value.reconciliation);
    const universeCoverageVerified = reconciliation.every(
      (value) => value.coverageComplete,
    );
    const coverageSufficient = reconciliation.every(
      (value) => value.matchRatio >= 0.95,
    );
    if (
      (query.universePolicy === "strict_current_master" &&
        !universeCoverageVerified) ||
      (query.universePolicy === "compatible" && !coverageSufficient)
    ) {
      fail(
        "INCOMPLETE_COVERAGE",
        query.universePolicy === "strict_current_master"
          ? "最新估值資料未與目前完整公司母體完全吻合。"
          : "最新估值資料與目前公司母體吻合率低於 95%，疑似來源截斷。",
        { universePolicy: query.universePolicy, reconciliation },
      );
    }

    let rows = reconciled.flatMap((value) => value.acceptedRows);
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
      fail("NO_DATA", "指定市場與公司條件查無最新官方估值資料。", {
        market: query.market,
        missingCompanyCodes,
      });
    }

    const warnings = [
      "latest 代表官方最近公布的收盤估值快照，不是盤中即時估值。",
      "本益比或股價淨值比在不具計算意義時可能為空白或 N/A；此類值回傳 null，不轉成 0。",
      "殖利率沿用官方百分比口徑；本工具不自行重算財報分母或股利。",
    ];
    if (!universeCoverageVerified) {
      warnings.push(
        "官方估值列與目前公司母體未完全吻合；請檢查 reconciliation，不得將 compatible 結果宣稱為完整母體。",
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
        `本次有 ${invalidFieldCount} 個估值欄位為無法解析的官方值，已回傳 null 與 invalid_upstream。`,
      );
    }

    return {
      query: {
        ...query,
        ...(companyCodes ? { companyCodes } : {}),
      },
      dataDate: dates[0],
      currency: "TWD",
      classificationPolicy: classificationPolicyFor(query.universePolicy),
      coverageComplete: true,
      universeCoverageVerified,
      selectionComplete: missingCompanyCodes.length === 0,
      missingCompanyCodes,
      reconciliation,
      counts: {
        raw: sourceResults.reduce((sum, result) => sum + result.source.rawCount, 0),
        returned: rows.length,
        withPe: rows.filter((row) => row.peRatio !== null).length,
        withPb: rows.filter((row) => row.priceToBookRatio !== null).length,
        withDividendYield: rows.filter((row) => row.dividendYieldPercent !== null)
          .length,
      },
      rows,
      sources: sourceResults.map((result) => result.source),
      warnings,
    };
  }
}

export const valuationClient = new ValuationClient();
