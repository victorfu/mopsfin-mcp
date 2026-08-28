import { describe, expect, it } from "vitest";

import type { MasterCompany } from "@/lib/company-master/types";
import {
  resolveFinancialStatement,
  resolveStatementRole,
  type FinancialStatementResultLike,
} from "@/lib/valuation-model/statement-resolver";

const company: MasterCompany = {
  code: "2330",
  name: "台灣積體電路製造股份有限公司",
  shortName: "台積電",
  market: "listed",
  exchange: "TWSE",
  industryCode: "24",
  listingDate: "1994-09-05",
  incorporationDate: null,
  paidInCapitalTwd: null,
  issuedCommonShares: null,
  parValueText: null,
  financialReportTypeCode: null,
  profileValueStatus: {
    incorporationDate: "missing",
    paidInCapitalTwd: "missing",
    issuedCommonShares: "missing",
    parValueText: "missing",
    financialReportTypeCode: "missing",
  },
  domicileCode: "TW",
  isKy: false,
  isFinancial: false,
};

function result(): FinancialStatementResultLike {
  return {
    sourceName: "fixture",
    sourceUrl: "https://mopsfin.twse.com.tw/",
    retrievedAt: "2026-08-28T00:00:00.000Z",
    upstreamRoute: "/compare/report",
    query: {
      statement: "income_statement",
      companyCodes: ["2330"],
      companies: ["2330 台積電"],
      period: "2026Q2",
    },
    unit: "新台幣仟元",
    unitSource: "response_html",
    period: "2026Q2",
    reportNames: ["2330 台積電 (上市半導體業)"],
    tables: [
      {
        title: "labels",
        headers: [["會計科目"]],
        rows: [["營業收入合計"], ["營業收入"]],
      },
      {
        title: "values",
        headers: [["合併"], ["2330 台積電(上市半導體業)"]],
        rows: [["1,234"], ["-"]],
      },
    ],
    pagination: {
      offset: 0,
      limit: 500,
      returnedRows: 4,
      totalRows: 4,
      nextOffset: null,
    },
  };
}

describe("valuation-model statement resolver", () => {
  it("verifies identity, scope and unit before normalizing exact rows", () => {
    const resolved = resolveFinancialStatement(
      result(),
      company,
      "income_statement",
      "2026Q2",
    );

    expect(resolved.consolidationScope).toBe("consolidated");
    expect(resolved.amountMultiplier).toBe(1000);
    expect(resolved.rows).toEqual([
      { label: "營業收入合計", rawValue: "1,234", valueTwd: 1_234_000 },
      { label: "營業收入", rawValue: "-", valueTwd: null },
    ]);
    expect(
      resolveStatementRole(resolved, "revenue", ["營業收入合計", "營業收入"]),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("normalizes accounting-parentheses negative amounts without losing the raw value", () => {
    const parenthesized = result();
    parenthesized.tables[1].rows[0] = ["（1,234）"];
    const resolved = resolveFinancialStatement(
      parenthesized,
      company,
      "income_statement",
      "2026Q2",
    );

    expect(resolved.rows[0]).toEqual({
      label: "營業收入合計",
      rawValue: "（1,234）",
      valueTwd: -1_234_000,
    });
  });

  it("fails closed on a company-name mismatch even when the code matches", () => {
    const mismatched = result();
    mismatched.reportNames = ["2330 假公司 (上市半導體業)"];

    expect(() =>
      resolveFinancialStatement(
        mismatched,
        company,
        "income_statement",
        "2026Q2",
      ),
    ).toThrowError(/無法唯一核對公司 identity/);
  });

  it("fails closed on unsupported or unavailable units", () => {
    const unsupported = result();
    unsupported.unit = "美元";
    expect(() =>
      resolveFinancialStatement(
        unsupported,
        company,
        "income_statement",
        "2026Q2",
      ),
    ).toThrowError(/金額單位不支援/);

    const unavailable = result();
    unavailable.unit = "";
    expect(() =>
      resolveFinancialStatement(
        unavailable,
        company,
        "income_statement",
        "2026Q2",
      ),
    ).toThrowError(/沒有可核對的金額單位/);

    const unproven = result();
    unproven.unitSource = "unavailable";
    expect(() =>
      resolveFinancialStatement(
        unproven,
        company,
        "income_statement",
        "2026Q2",
      ),
    ).toThrowError(/沒有可驗證的 response 或 catalog 來源/);
  });

  it("fails closed on mismatched table cardinality and mixed scopes", () => {
    const mismatchedRows = result();
    mismatchedRows.tables[1].rows.pop();
    expect(() =>
      resolveFinancialStatement(
        mismatchedRows,
        company,
        "income_statement",
        "2026Q2",
      ),
    ).toThrowError(/列數不一致/);

    const mixedScope = result();
    mixedScope.tables[1].headers.unshift(["個別"]);
    expect(() =>
      resolveFinancialStatement(
        mixedScope,
        company,
        "income_statement",
        "2026Q2",
      ),
    ).toThrowError(/無法唯一判定合併或個別範圍/);
  });
});
