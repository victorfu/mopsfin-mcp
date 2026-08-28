import type {
  EvaluateFreshnessInput,
  FreshnessEvaluation,
  FreshnessLagUnit,
  FreshnessStatus,
} from "./types";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const QUARTER = /^(\d{4})Q([1-4])$/;

function uniqueSourceUrls(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function dateOrdinal(value: string): number | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return epoch / (24 * 60 * 60 * 1_000);
}

function monthOrdinal(value: string): number | null {
  const match = YEAR_MONTH.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return Number(match[1]) * 12 + month - 1;
}

function quarterOrdinal(value: string): number | null {
  const match = QUARTER.exec(value);
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

function ordinal(value: string, unit: FreshnessLagUnit): number | null {
  if (unit === "calendar_month") return monthOrdinal(value);
  if (unit === "quarter") return quarterOrdinal(value);
  return dateOrdinal(value);
}

function result(
  input: EvaluateFreshnessInput,
  options: Pick<FreshnessEvaluation, "status" | "lag" | "reasonCode" | "reason">,
): FreshnessEvaluation {
  return {
    ...options,
    policyId: input.policy.id,
    observedAsOf: input.observedAsOf,
    expectedAsOf: input.expectedAsOf,
    sourceUrls: uniqueSourceUrls(input.sourceUrls),
  };
}

function unknown(
  input: EvaluateFreshnessInput,
  reasonCode: string,
  reason: string,
): FreshnessEvaluation {
  return result(input, {
    status: "unknown",
    lag: null,
    reasonCode,
    reason,
  });
}

function resolvedLag(input: EvaluateFreshnessInput): number | null {
  if (input.resolvedLag !== undefined && input.resolvedLag !== null) {
    return Number.isFinite(input.resolvedLag) && input.resolvedLag >= 0
      ? input.resolvedLag
      : null;
  }
  if (!input.observedAsOf || !input.expectedAsOf) return null;
  const observed = ordinal(input.observedAsOf, input.policy.lagUnit);
  const expected = ordinal(input.expectedAsOf, input.policy.lagUnit);
  if (observed === null || expected === null) return null;
  if (input.policy.lagUnit === "trading_session" && observed !== expected) {
    return null;
  }
  return expected - observed;
}

export function evaluateFreshness(
  input: EvaluateFreshnessInput,
): FreshnessEvaluation {
  if (input.policy.mode === "not_applicable") {
    return result(input, {
      status: "not_applicable",
      lag: null,
      reasonCode: "HISTORICAL_SELECTOR_NOT_APPLICABLE",
      reason: "使用者指定明確歷史期別；latest freshness 不適用。",
    });
  }
  if (input.policy.mode === "unverifiable") {
    return unknown(
      input,
      "EXPECTED_AS_OF_UNAVAILABLE",
      "目前沒有可靠的 expected as-of 可驗證此資料是否為最新。",
    );
  }
  if (!input.observedAsOf) {
    return unknown(input, "OBSERVED_AS_OF_UNAVAILABLE", "來源沒有可驗證的 observed as-of。");
  }
  if (!input.expectedAsOf) {
    return unknown(
      input,
      "EXPECTED_AS_OF_UNAVAILABLE",
      "目前沒有可靠的 expected as-of 可供比較。",
    );
  }

  const observed = ordinal(input.observedAsOf, input.policy.lagUnit);
  const expected = ordinal(input.expectedAsOf, input.policy.lagUnit);
  if (observed === null || expected === null) {
    return unknown(
      input,
      "AS_OF_FORMAT_UNVERIFIED",
      "observed 或 expected as-of 格式無法依 policy 驗證。",
    );
  }
  if (observed > expected) {
    return unknown(
      input,
      "OBSERVED_AFTER_EXPECTED_AS_OF",
      "observed as-of 晚於 expected as-of，不能據此宣稱資料新鮮。",
    );
  }

  const lagValue = resolvedLag(input);
  if (observed !== expected && lagValue === null) {
    if (input.policy.mode === "match_expected") {
      return result(input, {
        status: "stale",
        lag: null,
        reasonCode: "BEHIND_EXPECTED_AS_OF",
        reason: "observed as-of 落後 expected as-of；缺少權威交易日曆，未猜測 session lag。",
      });
    }
    return unknown(
      input,
      "LAG_UNAVAILABLE",
      "缺少權威 lag resolver，無法判斷資料是否仍在容許窗口。",
    );
  }

  const lag = {
    value: lagValue ?? 0,
    unit: input.policy.lagUnit,
  };
  if (input.policy.mode === "maximum_lag") {
    return result(input, {
      status:
        lag.value <= input.policy.maximumLag
          ? "within_expected_window"
          : "stale",
      lag,
      reasonCode:
        lag.value <= input.policy.maximumLag
          ? "WITHIN_MAXIMUM_LAG"
          : "MAXIMUM_LAG_EXCEEDED",
      reason:
        lag.value <= input.policy.maximumLag
          ? "observed as-of 位於 policy 容許窗口內。"
          : "observed as-of 已超過 policy 容許窗口。",
    });
  }
  return result(input, {
    status: lag.value === 0 ? "within_expected_window" : "stale",
    lag,
    reasonCode: lag.value === 0 ? "MATCHES_EXPECTED_AS_OF" : "BEHIND_EXPECTED_AS_OF",
    reason:
      lag.value === 0
        ? "observed as-of 與 expected as-of 相符。"
        : "observed as-of 落後 expected as-of。",
  });
}

export function aggregateFreshness(
  evaluations: readonly Pick<FreshnessEvaluation, "status">[],
): FreshnessStatus {
  if (evaluations.length === 0) return "unknown";
  if (evaluations.some((evaluation) => evaluation.status === "stale")) {
    return "stale";
  }
  if (evaluations.some((evaluation) => evaluation.status === "unknown")) {
    return "unknown";
  }
  if (
    evaluations.some(
      (evaluation) => evaluation.status === "within_expected_window",
    )
  ) {
    return "within_expected_window";
  }
  return "not_applicable";
}
