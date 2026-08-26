import { load } from "cheerio";

import { MopsfinError } from "./errors";
import type {
  NormalizedTable,
  PaginatedTables,
  ParsedHtmlResponse,
} from "./types";

interface ActiveSpan {
  remaining: number;
  value: string;
}

interface HtmlResourceBudget {
  expandedCells: number;
}

const MAX_HTML_CHARACTERS = 8_000_000;
const MAX_TOP_LEVEL_TABLES = 100;
const MAX_ROWS_PER_TABLE = 20_000;
const MAX_COLUMNS_PER_TABLE = 500;
const MAX_CELL_SPAN = 1_000;
const MAX_EXPANDED_CELLS = 1_000_000;

function resourceLimit(message: string, details: Record<string, unknown>): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason: "UPSTREAM_RESOURCE_LIMIT",
    category: "upstream",
    retryable: false,
    action: "none",
    details,
  });
}

function normalizedSpan(raw: string | undefined, attribute: "rowspan" | "colspan"): number {
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CELL_SPAN) {
    resourceLimit(`Mopsfin HTML ${attribute} 超出安全範圍。`, {
      attribute,
      value: raw,
      maximum: MAX_CELL_SPAN,
    });
  }
  return value;
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function expandRows(
  $: ReturnType<typeof load>,
  rowElements: ReturnType<ReturnType<typeof load>>,
  budget: HtmlResourceBudget,
): string[][] {
  if (rowElements.length > MAX_ROWS_PER_TABLE) {
    resourceLimit("Mopsfin HTML 單一表格列數超出安全上限。", {
      rows: rowElements.length,
      maximum: MAX_ROWS_PER_TABLE,
    });
  }
  const grid: string[][] = [];
  const active = new Map<number, ActiveSpan>();

  rowElements.each((_, rowElement) => {
    const row: string[] = [];
    let column = 0;

    const consumeActive = () => {
      while (active.has(column)) {
        const span = active.get(column) as ActiveSpan;
        row[column] = span.value;
        span.remaining -= 1;
        if (span.remaining <= 0) active.delete(column);
        column += 1;
      }
    };

    consumeActive();
    $(rowElement)
      .children("th, td")
      .each((__, cellElement) => {
        consumeActive();
        const cell = $(cellElement);
        const value = cleanText(cell.text());
        const colspan = normalizedSpan(cell.attr("colspan"), "colspan");
        const rowspan = normalizedSpan(cell.attr("rowspan"), "rowspan");

        if (column + colspan > MAX_COLUMNS_PER_TABLE) {
          resourceLimit("Mopsfin HTML 單一表格欄數超出安全上限。", {
            columns: column + colspan,
            maximum: MAX_COLUMNS_PER_TABLE,
          });
        }
        budget.expandedCells += colspan * rowspan;
        if (budget.expandedCells > MAX_EXPANDED_CELLS) {
          resourceLimit("Mopsfin HTML 展開後儲存格數超出安全上限。", {
            expandedCells: budget.expandedCells,
            maximum: MAX_EXPANDED_CELLS,
          });
        }

        for (let offset = 0; offset < colspan; offset += 1) {
          row[column + offset] = value;
          if (rowspan > 1) {
            active.set(column + offset, { value, remaining: rowspan - 1 });
          }
        }
        column += colspan;
      });

    consumeActive();
    const highestActiveColumn = Math.max(-1, ...active.keys());
    while (column <= highestActiveColumn) {
      if (active.has(column)) {
        const span = active.get(column) as ActiveSpan;
        row[column] = span.value;
        span.remaining -= 1;
        if (span.remaining <= 0) active.delete(column);
      } else {
        row[column] = "";
      }
      column += 1;
    }

    if (row.some((cell) => cell !== "")) grid.push(row);
  });

  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

export function parseHtmlTables(html: string): ParsedHtmlResponse {
  if (html.length > MAX_HTML_CHARACTERS) {
    resourceLimit("Mopsfin HTML 回應大小超出安全上限。", {
      characters: html.length,
      maximum: MAX_HTML_CHARACTERS,
    });
  }
  const $ = load(html);
  $("script, style, noscript").remove();

  const period = $("input[name='yearseason']").first().attr("value")?.trim();
  const reportNames = $("input[name='reportName']")
    .map((_, input) => $(input).attr("value")?.trim() ?? "")
    .get()
    .filter(Boolean);
  const tables: NormalizedTable[] = [];
  const budget: HtmlResourceBudget = { expandedCells: 0 };
  const topLevelTables = $("table").filter(
    (_, table) => $(table).parents("table").length === 0,
  );
  if (topLevelTables.length > MAX_TOP_LEVEL_TABLES) {
    resourceLimit("Mopsfin HTML 表格數超出安全上限。", {
      tables: topLevelTables.length,
      maximum: MAX_TOP_LEVEL_TABLES,
    });
  }

  topLevelTables
    .each((index, tableElement) => {
      const table = $(tableElement);
      const caption = cleanText(table.children("caption").first().text());
      const precedingTitle = cleanText(
        table.prevAll("h1, h2, h3, h4").first().text(),
      );
      const title = caption || precedingTitle || `表格 ${index + 1}`;
      const headerRows = table
        .find("thead tr")
        .filter((_, row) => $(row).closest("table").get(0) === tableElement);
      const bodyRows = table
        .find("tr")
        .filter(
          (_, row) =>
            $(row).closest("table").get(0) === tableElement &&
            $(row).closest("thead").length === 0,
        );
      const headers = expandRows($, headerRows, budget);
      const rows = expandRows($, bodyRows, budget);

      if (headers.length > 0 || rows.length > 0) {
        tables.push({ title, headers, rows });
      }
    });

  return {
    period,
    reportNames,
    tables,
    totalRows: tables.reduce((sum, table) => sum + table.rows.length, 0),
  };
}

export function paginateTables(
  parsed: ParsedHtmlResponse,
  offset: number,
  limit: number,
): PaginatedTables {
  let remainingOffset = offset;
  let remainingLimit = limit;
  const selected: NormalizedTable[] = [];

  for (const table of parsed.tables) {
    if (remainingLimit === 0) break;
    if (remainingOffset >= table.rows.length) {
      remainingOffset -= table.rows.length;
      continue;
    }

    const start = remainingOffset;
    const rows = table.rows.slice(start, start + remainingLimit);
    if (rows.length > 0) {
      selected.push({ ...table, rows });
      remainingLimit -= rows.length;
    }
    remainingOffset = 0;
  }

  const returnedRows = selected.reduce((sum, table) => sum + table.rows.length, 0);
  const consumed = offset + returnedRows;

  return {
    tables: selected,
    pagination: {
      offset,
      limit,
      returnedRows,
      totalRows: parsed.totalRows,
      nextOffset: consumed < parsed.totalRows ? consumed : null,
    },
  };
}
