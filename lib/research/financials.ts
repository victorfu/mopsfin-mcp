import type { MasterCompany } from "@/lib/company-master/types";
import type { FinancialInstitutionDefinition, MetricDefinition } from "@/lib/mopsfin/types";

// Names come from the official data-family catalog; aliases normalize punctuation only.
const normalizedName = (name: string) => name.replace(/[\s、，,（）()]/g, "");
const nonFinancial = new Set([
  "營業毛利", "長期資金比率", "長期資金佔不動產廠房及設備比率", "流動比率", "速動比率",
  "應收款項週轉率", "平均收現日數", "應收款項收現日數", "存貨週轉率", "平均銷貨日數", "平均售貨日數",
  "總資產週轉率", "毛利率", "營業利益率", "營業毛利年增率", "營業利益年增率",
  "營業現金對流動負債比", "營業現金對負債比", "營業現金流對負債比", "營業現金對稅後純益比", "營業現金流對稅後淨利比",
]);
const allCompanies = new Set([
  "營業收入", "營業利益", "稅後純益", "每股盈餘", "股本", "歸屬於母公司業主之權益", "歸屬母公司權益", "每股淨值",
  "營業活動現金流量", "投資活動現金流量", "籌資活動現金流量", "負債佔資產比率", "利息保障倍數",
  "稅後純益率", "資產報酬率", "權益報酬率", "營業收入年增率", "稅後純益年增率", "每股盈餘年增率",
]);

export function financialFieldApplicability(metric: MetricDefinition): "all" | "non_financial" | "unknown" {
  const name = normalizedName(metric.name);
  return nonFinancial.has(name) ? "non_financial" : allCompanies.has(name) ? "all" : "unknown";
}

export function financialMeaning(metric: MetricDefinition, company: MasterCompany, institutions: FinancialInstitutionDefinition[]) {
  const applicability = financialFieldApplicability(metric);
  const status = applicability === "unknown" ? "unknown" as const : applicability === "non_financial" && company.isFinancial ? "not_applicable" as const : "applicable" as const;
  let definitionId = `mopsfin.financial.${metric.code}.quarterly.v1`;
  let meaning = metric.name;
  let definitionVerified = applicability !== "unknown";
  if (company.isFinancial && ["營業收入", "營業收入年增率", "稅後純益率", "營業利益"].includes(normalizedName(metric.name))) {
    // Only exact official institution codes establish a financial subtype. Never guess from company names.
    const institution = institutions.find((entry) => entry.code === company.code);
    if (institution && ["holding", "bank"].includes(institution.sector)) {
      const operating = normalizedName(metric.name) === "營業利益";
      definitionId += operating ? ".financial_pre_tax_income" : ".financial_net_revenue";
      meaning = operating ? "金融業官方對應稅前淨利；不是一般企業營業利益" : `${metric.name}：金融／金控官方對應淨收益`;
    } else {
      definitionId += `.financial_mapping_unverified.${company.code}`;
      meaning = "金融業跨業別映射，可能為淨收益、收益或其他收入；細分定義未驗證，不與其他公司合併統計。";
      definitionVerified = false;
    }
  }
  return { applicability: status, definitionId, meaning, definitionVerified };
}
