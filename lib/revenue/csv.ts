import { parse } from "csv-parse/sync";

const EXPECTED_HEADER_ALIASES = [
  ["出表日期"],
  ["資料年月"],
  ["公司代號"],
  ["公司名稱"],
  ["產業別"],
  ["營業收入-當月營收", "當月營收"],
  ["營業收入-上月營收", "上月營收"],
  ["營業收入-去年當月營收", "去年當月營收"],
  ["營業收入-上月比較增減(%)", "上月比較增減(%)"],
  ["營業收入-去年同月增減(%)", "去年同月增減(%)"],
  ["累計營業收入-當月累計營收", "當月累計營收"],
  ["累計營業收入-去年累計營收", "去年累計營收"],
  ["累計營業收入-前期比較增減(%)", "前期比較增減(%)"],
  ["備註"],
] as const;

export class RevenueCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevenueCsvParseError";
  }
}

/**
 * Parse the official MOPS monthly-revenue archive as RFC 4180 CSV.
 * Numeric/date semantics intentionally stay in the revenue normalizer so
 * missing markers and official sentinels retain explicit value statuses.
 */
export function parseRevenueCsv(input: string): Array<Record<string, string>> {
  try {
    const records = parse(input, {
      bom: true,
      columns: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    if (records.length === 0) {
      throw new RevenueCsvParseError("CSV 沒有標題列與資料列。");
    }
    const actualHeaders = Object.keys(records[0]);
    if (
      actualHeaders.length !== EXPECTED_HEADER_ALIASES.length ||
      EXPECTED_HEADER_ALIASES.some(
        (aliases) => !aliases.some((header) => actualHeaders.includes(header)),
      )
    ) {
      throw new RevenueCsvParseError("CSV 標題列不是官方月營收 14 欄格式。");
    }
    return records;
  } catch (error) {
    if (error instanceof RevenueCsvParseError) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (code === "CSV_QUOTE_NOT_CLOSED") {
      throw new RevenueCsvParseError("CSV 引號欄位未結束。");
    }
    throw new RevenueCsvParseError(
      error instanceof Error ? `CSV 解析失敗：${error.message}` : "CSV 解析失敗。",
    );
  }
}
