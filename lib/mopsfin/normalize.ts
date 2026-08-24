import { MopsfinError } from "./errors";
import type { NormalizedTrend, TrendPoint, TrendSeries } from "./types";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLineSeries(
  graphData: unknown[],
  periods: string[],
): TrendSeries[] {
  return graphData.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.data)) return [];
    const points: TrendPoint[] = record.data.flatMap((rawPoint) => {
      if (!Array.isArray(rawPoint) || rawPoint.length < 2) return [];
      const index = Number(rawPoint[0]);
      if (!Number.isInteger(index) || !periods[index]) return [];
      return [
        {
          period: periods[index],
          value: asNumberOrNull(rawPoint[1]),
          ...(typeof rawPoint[2] === "string" ? { status: rawPoint[2] } : {}),
        },
      ];
    });
    return [{ label: String(record.label ?? "資料"), points }];
  });
}

function normalizeBarSeries(
  graphData: unknown[],
  xaxis: unknown[],
): { periods: string[]; series: TrendSeries[] } {
  const labels = xaxis.map((item, index) => {
    if (Array.isArray(item) && item.length > 1) return String(item[1]);
    return String(index);
  });
  const points: TrendPoint[] = graphData.flatMap((rawPoint) => {
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) return [];
    const index = Number(rawPoint[0]);
    if (!Number.isInteger(index) || !labels[index]) return [];
    return [{ period: labels[index], value: asNumberOrNull(rawPoint[1]) }];
  });
  return { periods: labels, series: [{ label: "產業統計", points }] };
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
    : {
        periods: record.xaxisList.map(String),
        series: normalizeLineSeries(
          record.graphData,
          record.xaxisList.map(String),
        ),
      };

  return {
    ...normalized,
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
