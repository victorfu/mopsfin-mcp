import type { ResearchCell, ResearchRow } from "./types";
import { summarizeResearchRows } from "./statistics";

export type OutputMode = "full" | "compact" | "summary";

/** Dictionary compression is lossless, including per-cell failure and provenance. */
export function projectResearchRows(rows: ResearchRow[], columns: string[], mode: OutputMode, scope: "entire_selection" | "current_page") {
  const uniqueColumns = [...new Set(columns)];
  if (mode === "summary") return {
    outputMode: mode, scope, rowCount: rows.length, rowsOmitted: true,
    statistics: summarizeResearchRows(rows, uniqueColumns),
  };
  if (mode === "full") return {
    outputMode: mode, scope, rowCount: rows.length, rowsOmitted: false,
    rows: rows.map(({ code, name, market, cells }) => ({ code, name, market, cells: Object.fromEntries(uniqueColumns.filter((id) => cells[id]).map((id) => [id, cells[id]])) })),
  };
  const metadata: Array<Omit<ResearchCell, "value" | "normalization"> & { normalization?: Omit<NonNullable<ResearchCell["normalization"]>, "sourceValue"> }> = [];
  const dictionary = new Map<string, number>();
  const compactRows = rows.map(({ code, name, market, cells }) => ({
    code, name, market,
    values: uniqueColumns.map((id): [ResearchCell["value"], number, ResearchCell["value"]?] | null => {
      const cell = cells[id];
      if (!cell) return null;
      const { value, normalization, ...rest } = cell;
      const meta = { ...rest, ...(normalization ? { normalization: { sourceUnit: normalization.sourceUnit, factor: normalization.factor } } : {}) };
      const key = JSON.stringify(meta);
      let index = dictionary.get(key);
      if (index === undefined) { index = metadata.length; dictionary.set(key, index); metadata.push(meta); }
      return normalization ? [value, index, normalization.sourceValue] : [value, index];
    }),
  }));
  return {
    outputMode: mode, scope, rowCount: rows.length, rowsOmitted: false,
    columns: uniqueColumns, cellEncoding: "[value,metadataIndex,optionalSourceValue]" as const,
    cellMetadata: metadata, rows: compactRows,
  };
}
