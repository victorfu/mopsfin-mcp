import type { ResearchCell, ResearchRow } from "./types";

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  // Welford's recurrence avoids subtracting two large, nearly equal sums.
  let mean = 0;
  let m2 = 0;
  values.forEach((value, index) => {
    const delta = value - mean;
    mean += delta / (index + 1);
    m2 += delta * (value - mean);
  });
  return Math.sqrt(Math.max(0, m2 / (values.length - 1)));
}

export function cellUsable(cell: ResearchCell | undefined): boolean {
  return !!cell && cell.status === "available" && cell.value !== null &&
    (typeof cell.value !== "number" || Number.isFinite(cell.value)) &&
    (cell.freshness === "fresh" || cell.freshness === "not_applicable");
}

/** Never pool different periods, definitions, units or price/financial bases. */
export function summarizeResearchRows(rows: ResearchRow[], columns: string[]) {
  return columns.map((field) => {
    const groups = new Map<string, { definitionId: string; unit: string; basis: string; period: string | null; values: number[] }>();
    const statusCounts: Record<string, number> = {};
    let usableCount = 0;
    for (const row of rows) {
      const cell = row.cells[field];
      const status = !cell ? "missing" : !cellUsable(cell) && cell.status === "available" ? `freshness_${cell.freshness}` : cell.status;
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (!cellUsable(cell)) continue;
      usableCount++;
      if (typeof cell.value !== "number") continue;
      const { definitionId, unit, basis, period } = cell;
      const key = JSON.stringify([definitionId, unit, basis, period]);
      const group = groups.get(key) ?? { definitionId, unit, basis, period, values: [] };
      group.values.push(cell.value);
      groups.set(key, group);
    }
    return {
      field, total: rows.length, usableCount, statusCounts,
      missingCount: statusCounts.missing ?? 0,
      missingRate: rows.length ? (statusCounts.missing ?? 0) / rows.length : null,
      unusableCount: rows.length - usableCount,
      unusableRate: rows.length ? (rows.length - usableCount) / rows.length : null,
      groups: [...groups.values()].map(({ values, ...identity }) => ({
        ...identity, count: values.length, min: Math.min(...values), max: Math.max(...values), median: median(values),
      })),
      definitionMismatch: new Set([...groups.values()].map((group) => group.definitionId)).size > 1,
    };
  });
}
