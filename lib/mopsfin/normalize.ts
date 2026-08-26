import { MopsfinError } from "./errors";
import type { NormalizedTrend, TrendPoint, TrendSeries } from "./types";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

const MISSING_VALUE_MARKERS = new Set(["", "-", "--", "—", "N/A", "NA"]);

function normalizeValue(value: unknown): Pick<TrendPoint, "value" | "valueStatus"> {
  if (value === null || value === undefined) {
    return { value: null, valueStatus: "missing" };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (MISSING_VALUE_MARKERS.has(trimmed.toUpperCase())) {
      return { value: null, valueStatus: "missing" };
    }
    const number = Number(trimmed.replaceAll(",", ""));
    return Number.isFinite(number)
      ? { value: number, valueStatus: "reported" }
      : { value: null, valueStatus: "invalid_upstream" };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value, valueStatus: "reported" };
  }
  return { value: null, valueStatus: "invalid_upstream" };
}

function normalizeLineSeries(
  graphData: unknown[],
  periods: string[],
): { series: TrendSeries[]; warnings: string[] } {
  const warnings: string[] = [];
  const series = graphData.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.data)) return [];
    const label = String(record.label ?? "資料");
    let droppedPointCount = 0;
    let invalidValueCount = 0;
    const points: TrendPoint[] = record.data.flatMap((rawPoint) => {
      if (!Array.isArray(rawPoint) || rawPoint.length < 2) return [];
      const rawIndex = rawPoint[0];
      const index =
        rawIndex === null || rawIndex === undefined || rawIndex === ""
          ? Number.NaN
          : Number(rawIndex);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= periods.length ||
        !periods[index]
      ) {
        droppedPointCount += 1;
        return [];
      }
      const normalizedValue = normalizeValue(rawPoint[1]);
      if (normalizedValue.valueStatus === "invalid_upstream") {
        invalidValueCount += 1;
      }
      return [{
        period: periods[index],
        ...normalizedValue,
        ...(typeof rawPoint[2] === "string" ? { status: rawPoint[2] } : {}),
      }];
    });
    if (droppedPointCount > 0) {
      warnings.push(
        `Mopsfin「${label}」有 ${droppedPointCount} 個資料點缺少有效期別索引；已忽略以避免錯置期別。`,
      );
    }
    if (invalidValueCount > 0) {
      warnings.push(
        `Mopsfin「${label}」有 ${invalidValueCount} 個無法解析的非數字資料值；已標記 invalid_upstream 並保留為 null。`,
      );
    }
    return [{ label, points }];
  });
  return { series, warnings };
}

function normalizeBarSeries(
  graphData: unknown[],
  xaxis: unknown[],
): { periods: string[]; series: TrendSeries[]; warnings: string[] } {
  const labels = xaxis.map((item, index) => {
    if (Array.isArray(item) && item.length > 1) return String(item[1]);
    return String(index);
  });
  let droppedPointCount = 0;
  let invalidValueCount = 0;
  const points: TrendPoint[] = graphData.flatMap((rawPoint) => {
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) return [];
    const rawIndex = rawPoint[0];
    const index =
      rawIndex === null || rawIndex === undefined || rawIndex === ""
        ? Number.NaN
        : Number(rawIndex);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= labels.length ||
      !labels[index]
    ) {
      droppedPointCount += 1;
      return [];
    }
    const normalizedValue = normalizeValue(rawPoint[1]);
    if (normalizedValue.valueStatus === "invalid_upstream") {
      invalidValueCount += 1;
    }
    return [{ period: labels[index], ...normalizedValue }];
  });
  const warnings: string[] = [];
  if (droppedPointCount > 0) {
    warnings.push(
      `Mopsfin 產業統計有 ${droppedPointCount} 個資料點缺少有效期別索引；已忽略以避免錯置期別。`,
    );
  }
  if (invalidValueCount > 0) {
    warnings.push(
      `Mopsfin 產業統計有 ${invalidValueCount} 個無法解析的非數字資料值；已標記 invalid_upstream 並保留為 null。`,
    );
  }
  return {
    periods: labels,
    series: [{ label: "產業統計", points }],
    warnings,
  };
}

export function normalizeTrendJson(raw: unknown): NormalizedTrend {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Mopsfin JSON 回應不是有效物件。",
    );
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    throw new MopsfinError("NO_DATA", record.message.trim());
  }
  if (!Array.isArray(record.graphData) || !Array.isArray(record.xaxisList)) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Mopsfin JSON 缺少 graphData 或 xaxisList。",
    );
  }

  const isBar =
    record.graphData.length > 0 && Array.isArray(record.graphData[0]);
  const normalized = isBar
    ? normalizeBarSeries(record.graphData, record.xaxisList)
    : (() => {
        const periods = record.xaxisList.map(String);
        const line = normalizeLineSeries(record.graphData, periods);
        return { periods, series: line.series, warnings: line.warnings };
      })();

  return {
    periods: normalized.periods,
    series: normalized.series,
    normalizationWarnings: normalized.warnings,
    unit: typeof record.ylabel === "string" ? record.ylabel : "",
    showNames: asStringArray(record.showNameList),
    checkedNames: asStringArray(record.checkedNameList),
    extraNames: asStringArray(record.extraNameList),
    displayNames: asStringArray(record.displayCompanyId),
    ...(Number.isInteger(record.year) ? { year: Number(record.year) } : {}),
    ...(Number.isInteger(record.season)
      ? { quarter: Number(record.season) }
      : {}),
  };
}
