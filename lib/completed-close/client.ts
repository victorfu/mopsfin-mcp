import type { CompanyMarket } from "@/lib/company-master/types";
import {
  COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
  completedSessionExpectedAsOfForMarket,
  completedSessionResolver,
} from "@/lib/freshness/completed-session-resolver";
import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { priceClient } from "@/lib/price/client";
import type {
  ExactCurrentCompanyOhlcQuery,
  ExactCurrentCompanyOhlcResult,
} from "@/lib/price/types";

import type {
  AuthoritativeCompletedCloseBar,
  AuthoritativeCompletedCloseQuery,
  AuthoritativeCompletedCloseResult,
  CompletedCloseCompanyIdentity,
} from "./types";

export interface CompletedSessionResolverLike {
  resolve(input: {
    market: CompanyMarket;
    evaluatedAt: string;
  }): Promise<CompletedSessionResolverEvidence>;
}

export interface ExactCurrentCompanyOhlcLike {
  getExactCurrentCompanyOhlc(
    query: ExactCurrentCompanyOhlcQuery,
  ): Promise<ExactCurrentCompanyOhlcResult>;
}

function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  options: {
    reason: string;
    category: "input" | "no_data" | "upstream";
    retryable?: boolean;
    action?: "fix_input" | "retry" | "none";
    details?: Record<string, unknown>;
  },
): never {
  throw new MopsfinError(code, message, {
    reason: options.reason,
    category: options.category,
    retryable: options.retryable ?? false,
    action: options.action ?? "none",
    details: options.details,
  });
}

function canonicalName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function officialSingleStockSourceUrlValid(
  sourceUrl: string,
  company: CompletedCloseCompanyIdentity,
  expectedAsOf: string,
): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
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
  const [year, month] = expectedAsOf.split("-");
  if (company.market === "listed") {
    return (
      url.hostname === "www.twse.com.tw" &&
      url.pathname === "/rwd/zh/afterTrading/STOCK_DAY" &&
      [...url.searchParams.keys()].sort().join(",") ===
        "date,response,stockNo" &&
      url.searchParams.get("date") === `${year}${month}01` &&
      url.searchParams.get("stockNo") === company.code &&
      url.searchParams.get("response") === "json"
    );
  }
  return (
    url.hostname === "www.tpex.org.tw" &&
    url.pathname === "/www/zh-tw/afterTrading/tradingStock" &&
    [...url.searchParams.keys()].sort().join(",") === "code,date,response" &&
    url.searchParams.get("code") === company.code &&
    url.searchParams.get("date") === `${year}/${month}/01` &&
    url.searchParams.get("response") === "json"
  );
}

function validatedCompany(
  company: CompletedCloseCompanyIdentity,
): CompletedCloseCompanyIdentity {
  const expectedExchange = company.market === "listed" ? "TWSE" : "TPEx";
  if (!/^[1-9]\d{3}$/.test(company.code)) {
    fail("INVALID_ARGUMENT", "company.code 必須是首碼非 0 的四碼公司股票代號。", {
      reason: "INVALID_COMPANY_CODE",
      category: "input",
      action: "fix_input",
      details: { companyCode: company.code },
    });
  }
  if (!canonicalName(company.shortName)) {
    fail("INVALID_ARGUMENT", "company.shortName 不得為空。", {
      reason: "INVALID_COMPANY_IDENTITY",
      category: "input",
      action: "fix_input",
      details: { companyCode: company.code },
    });
  }
  if (company.exchange !== expectedExchange) {
    fail("INVALID_ARGUMENT", "company.market 與 company.exchange 不一致。", {
      reason: "INVALID_COMPANY_IDENTITY",
      category: "input",
      action: "fix_input",
      details: {
        companyCode: company.code,
        market: company.market,
        exchange: company.exchange,
        expectedExchange,
      },
    });
  }
  return {
    code: company.code,
    shortName: company.shortName.trim(),
    market: company.market,
    exchange: company.exchange,
  };
}

function fixedEvaluatedAt(value: Date | string | undefined, now: () => Date): string {
  const evaluated =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string"
        ? new Date(value)
        : new Date(now().getTime());
  if (!Number.isFinite(evaluated.getTime())) {
    fail("INVALID_ARGUMENT", "evaluatedAt 必須是有效時間。", {
      reason: "INVALID_EVALUATED_AT",
      category: "input",
      action: "fix_input",
      details: { evaluatedAt: value instanceof Date ? String(value) : value ?? null },
    });
  }
  return evaluated.toISOString();
}

function expectedDate(
  evidence: CompletedSessionResolverEvidence,
  company: CompletedCloseCompanyIdentity,
  evaluatedAt: string,
): string {
  const marketResolution = evidence.marketResolutions.filter(
    (resolution) => resolution.market === company.market,
  );
  const expectedAsOf = completedSessionExpectedAsOfForMarket(
    evidence,
    company.market,
  );
  const identityValid =
    evidence.resolverId === "taiwan-equity.completed-session.v1" &&
    evidence.evaluatedAt === evaluatedAt &&
    evidence.timezone === "Asia/Taipei" &&
    evidence.status === "resolved" &&
    evidence.markets.length === 1 &&
    evidence.markets[0] === company.market &&
    evidence.marketResolutions.length === 1 &&
    marketResolution.length === 1 &&
    marketResolution[0]?.status === "resolved" &&
    evidence.expectedAsOf !== null &&
    evidence.expectedAsOf === expectedAsOf;
  if (!identityValid || !expectedAsOf) {
    if (evidence.status === "unresolved" && evidence.expectedAsOf === null) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "authoritative completed-session resolver 無法解析可用日期。",
        {
          reason: "COMPLETED_SESSION_UNRESOLVED",
          category: "upstream",
          retryable: true,
          action: "retry",
          details: {
            companyCode: company.code,
            market: company.market,
            evaluatedAt,
            resolverReasonCode: evidence.reasonCode,
          },
        },
      );
    }
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative completed-session resolver evidence identity 不一致。",
      {
        reason: "COMPLETED_SESSION_EVIDENCE_MISMATCH",
        category: "upstream",
        retryable: false,
        action: "none",
        details: {
          companyCode: company.code,
          market: company.market,
          evaluatedAt,
          resolverEvaluatedAt: evidence.evaluatedAt,
          resolverMarkets: evidence.markets,
          resolverStatus: evidence.status,
          resolverExpectedAsOf: evidence.expectedAsOf,
        },
      },
    );
  }
  return expectedAsOf;
}

export class AuthoritativeCompletedCloseClient {
  constructor(
    private readonly resolver: CompletedSessionResolverLike =
      completedSessionResolver,
    private readonly exactOhlc: ExactCurrentCompanyOhlcLike = priceClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getLatestCompletedClose(
    query: AuthoritativeCompletedCloseQuery,
  ): Promise<AuthoritativeCompletedCloseResult> {
    const company = validatedCompany(query.company);
    const evaluatedAt = fixedEvaluatedAt(query.evaluatedAt, this.now);
    const resolverEvidence = await this.resolver.resolve({
      market: company.market,
      evaluatedAt,
    });
    const expectedAsOf = expectedDate(
      resolverEvidence,
      company,
      evaluatedAt,
    );
    const exact = await this.exactOhlc.getExactCurrentCompanyOhlc({
      company,
      date: expectedAsOf,
    });

    const queryIdentityValid =
      exact.query.companyCode === company.code &&
      exact.query.market === company.market &&
      exact.query.date === expectedAsOf &&
      exact.companyCode === company.code &&
      exact.market === company.market &&
      exact.coverageComplete === true;
    const sourceIdentityValid =
      exact.source.market === company.market &&
      exact.source.snapshotIdentity === "verified" &&
      exact.source.dataMonth === expectedAsOf.slice(0, 7) &&
      exact.source.dataDate === undefined &&
      exact.dataMonth === expectedAsOf.slice(0, 7) &&
      exact.observedName !== null &&
      canonicalName(exact.observedName) === canonicalName(company.shortName) &&
      officialSingleStockSourceUrlValid(
        exact.source.sourceUrl,
        company,
        expectedAsOf,
      );
    if (!queryIdentityValid || !sourceIdentityValid) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "official exact single-stock OHLC identity 與 authoritative request 不一致。",
        {
          reason: "COMPLETED_CLOSE_IDENTITY_MISMATCH",
          category: "upstream",
          retryable: false,
          action: "none",
          details: {
            expected: {
              companyCode: company.code,
              market: company.market,
              shortName: company.shortName,
              expectedAsOf,
              dataMonth: expectedAsOf.slice(0, 7),
            },
            actual: {
              query: exact.query,
              companyCode: exact.companyCode,
              market: exact.market,
              observedName: exact.observedName,
              dataMonth: exact.dataMonth,
              selectedBarDate: exact.selectedBarDate,
              sourceMarket: exact.source.market,
              sourceDataMonth: exact.source.dataMonth,
              sourceUrl: exact.source.sourceUrl,
              snapshotIdentity: exact.source.snapshotIdentity,
              coverageComplete: exact.coverageComplete,
            },
          },
        },
      );
    }
    if (
      exact.cacheRefresh.attempted &&
      exact.cacheRefresh.initialCacheStatus !== "hit"
    ) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "authoritative exact OHLC cache refresh 只能由 current-month cache hit 觸發。",
        {
          reason: "COMPLETED_CLOSE_CACHE_REFRESH_MISMATCH",
          category: "upstream",
          retryable: false,
          action: "none",
          details: {
            companyCode: company.code,
            expectedAsOf,
            cacheRefresh: exact.cacheRefresh,
          },
        },
      );
    }
    const sourceRetrievedAtMs = Date.parse(exact.source.retrievedAt);
    const sessionCompletionMs = Date.parse(
      `${expectedAsOf}T${COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI}+08:00`,
    );
    if (
      !Number.isFinite(sourceRetrievedAtMs) ||
      sourceRetrievedAtMs < sessionCompletionMs
    ) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "authoritative exact OHLC source 不得早於 expected session completion 取得。",
        {
          reason: "COMPLETED_CLOSE_SOURCE_PRECEDES_SESSION_COMPLETION",
          category: "upstream",
          retryable: true,
          action: "retry",
          details: {
            companyCode: company.code,
            expectedAsOf,
            retrievedAt: exact.source.retrievedAt,
            completionGuardTaipei:
              COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
            cacheRefresh: exact.cacheRefresh,
          },
        },
      );
    }
    if (exact.bars.length === 0) {
      fail(
        "NO_DATA",
        "authoritative completed session 沒有日期完全相等的單股 OHLC bar。",
        {
          reason: "COMPLETED_CLOSE_EXACT_BAR_NOT_FOUND",
          category: "no_data",
          retryable: true,
          action: "retry",
          details: {
            companyCode: company.code,
            market: company.market,
            expectedAsOf,
            selectedBarDate: exact.selectedBarDate,
            barDates: exact.bars.map((bar) => bar.date),
            cacheRefreshAttempted: exact.cacheRefresh.attempted,
          },
        },
      );
    }
    if (
      exact.bars.length !== 1 ||
      exact.selectedBarDate !== expectedAsOf ||
      exact.bars[0]?.date !== expectedAsOf
    ) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "authoritative completed session 的 exact 單股 OHLC bar 不唯一或日期契約不一致。",
        {
          reason: "COMPLETED_CLOSE_EXACT_BAR_AMBIGUOUS",
          category: "upstream",
          retryable: false,
          action: "none",
          details: {
            companyCode: company.code,
            market: company.market,
            expectedAsOf,
            selectedBarDate: exact.selectedBarDate,
            barDates: exact.bars.map((bar) => bar.date),
          },
        },
      );
    }
    const bar = exact.bars[0];
    if (bar.market !== company.market) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "authoritative completed close bar 的 market identity 不一致。",
        {
          reason: "COMPLETED_CLOSE_BAR_MARKET_MISMATCH",
          category: "upstream",
          retryable: false,
          action: "none",
          details: {
            companyCode: company.code,
            expectedMarket: company.market,
            barMarket: bar.market,
            expectedAsOf,
          },
        },
      );
    }
    if (
      bar.status !== "traded" ||
      typeof bar.close !== "number" ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0
    ) {
      fail(
        "NO_DATA",
        "authoritative completed session 沒有有效的已成交正數收盤價。",
        {
          reason: "COMPLETED_CLOSE_VALUE_UNAVAILABLE",
          category: "no_data",
          retryable: false,
          action: "none",
          details: {
            companyCode: company.code,
            market: company.market,
            expectedAsOf,
            barMarket: bar.market,
            status: bar.status,
            close: bar.close,
          },
        },
      );
    }
    const completedBar = bar as AuthoritativeCompletedCloseBar;

    return {
      query: {
        companyCode: company.code,
        market: company.market,
        evaluatedAt,
      },
      company,
      expectedAsOf,
      selectedBarDate: expectedAsOf,
      close: completedBar.close,
      currency: "TWD",
      timezone: "Asia/Taipei",
      interval: "1d",
      priceBasis: "raw_unadjusted",
      bar: completedBar,
      source: {
        ...exact.source,
        companyCode: company.code,
        exchange: company.exchange,
        observedName: exact.observedName as string,
        selectedBarDate: expectedAsOf,
      },
      resolverEvidence,
      cacheRefresh: exact.cacheRefresh,
      workBudget: {
        scope: "authoritative_completed_close_routing",
        completedSessionResolver: resolverEvidence.workBudget,
        exactStockOhlcAttempts: {
          actual: exact.cacheRefresh.attempted ? 2 : 1,
          maximum: 2,
          cacheRefreshPerformed: exact.cacheRefresh.attempted,
        },
      },
    };
  }
}

export const authoritativeCompletedCloseClient =
  new AuthoritativeCompletedCloseClient();
