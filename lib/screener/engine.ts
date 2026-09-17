import { cellUsable } from "@/lib/research/statistics";
import type { ResearchFilter, ResearchRow, ResearchSort } from "@/lib/research/types";

export function evaluateFilter(row: ResearchRow, filter: ResearchFilter) {
  const cell = row.cells[filter.field];
  if (!cellUsable(cell)) return { filter, outcome: "unknown" as const, cell: cell ?? null };
  const actual = cell.value;
  const expected = filter.value;
  let matches = false;
  if (filter.op === "eq") matches = actual === expected;
  else if (filter.op === "in") matches = Array.isArray(expected) && expected.some((value) => value === actual);
  else if (typeof actual === "number") {
    if (filter.op === "between" && Array.isArray(expected)) matches = actual >= Number(expected[0]) && actual <= Number(expected[1]);
    else if (typeof expected === "number") {
      if (filter.op === "gt") matches = actual > expected;
      if (filter.op === "gte") matches = actual >= expected;
      if (filter.op === "lt") matches = actual < expected;
      if (filter.op === "lte") matches = actual <= expected;
    }
  }
  return { filter, outcome: matches ? "true" as const : "false" as const, cell };
}

/** A definite false dominates unknown in AND, but all evidence is retained. */
export function screenRows(rows: ResearchRow[], filters: ResearchFilter[], sort: ResearchSort[]) {
  const evaluated = rows.map((row) => {
    const evidence = filters.map((filter) => evaluateFilter(row, filter));
    const outcome = evidence.some((item) => item.outcome === "false") ? "not_matched" : evidence.some((item) => item.outcome === "unknown") ? "undetermined" : "matched";
    return { ...row, outcome, evidence };
  });
  const matches = evaluated.filter((row) => row.outcome === "matched");
  matches.sort((left, right) => {
    for (const { field, direction } of sort) {
      const a = cellUsable(left.cells[field]) ? left.cells[field].value : null;
      const b = cellUsable(right.cells[field]) ? right.cells[field].value : null;
      if (a === null && b === null) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const comparison = a < b ? -1 : a > b ? 1 : 0;
      if (comparison) return direction === "asc" ? comparison : -comparison;
    }
    return left.market.localeCompare(right.market) || left.code.localeCompare(right.code);
  });
  return {
    matches,
    unresolved: evaluated.filter((row) => row.outcome === "undetermined"),
    counts: {
      selected: rows.length, matched: matches.length,
      notMatched: evaluated.filter((row) => row.outcome === "not_matched").length,
      undetermined: evaluated.filter((row) => row.outcome === "undetermined").length,
      unknownFilterCells: evaluated.reduce((sum, row) => sum + row.evidence.filter((item) => item.outcome === "unknown").length, 0),
    },
    rankIncomplete: matches.some((row) => sort.some((item) => !cellUsable(row.cells[item.field]))),
  };
}
