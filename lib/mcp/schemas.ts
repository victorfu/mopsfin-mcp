import { z } from "zod";

export const periodSchema = z
  .string()
  .regex(/^\d{4}Q[1-4]$/, "期別必須是 YYYYQ1 至 YYYYQ4");

export const requestedPeriodSchema = z.union([
  z.literal("latest"),
  periodSchema,
]);

export const companyCodesSchema = z
  .array(z.string().regex(/^[0-9A-Za-z]{1,10}$/))
  .min(1)
  .max(10);

export const rangeShape = {
  history: z.enum(["recent_12", "all"]).default("recent_12"),
  start_period: periodSchema.optional(),
  end_period: periodSchema.optional(),
};

export const pageShape = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};

export const findCompaniesInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .describe("公司代號或中英文名稱，例如 2330 或台積電"),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const listCatalogInputSchema = z
  .object({
    kind: z
      .enum([
        "all",
        "metrics",
        "industries",
        "financial_institutions",
        "periods",
      ])
      .default("all"),
    query: z.string().trim().max(50).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

export const companyMetricInputSchema = z
  .object({
    metric_code: z.string().trim().min(1).max(100),
    company_codes: companyCodesSchema,
    basis: z.enum(["quarterly", "cumulative_yoy"]).default("quarterly"),
    yoy_quarter: z.number().int().min(1).max(4).optional(),
    include_industry_average: z.boolean().default(false),
    include_company_average: z.boolean().default(false),
    ...rangeShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.basis === "cumulative_yoy" && value.yoy_quarter === undefined) {
      context.addIssue({
        code: "custom",
        path: ["yoy_quarter"],
        message: "cumulative_yoy 必須提供 yoy_quarter",
      });
    }
  });

export const financialStatementInputSchema = z
  .object({
    statement: z.enum(["balance_sheet", "income_statement", "cash_flow"]),
    company_codes: companyCodesSchema,
    period: requestedPeriodSchema.default("latest"),
    ...pageShape,
  })
  .strict();

export const financialNoteInputSchema = z
  .object({
    note: z.enum([
      "consolidated_subsidiaries",
      "loans_to_others",
      "endorsements_guarantees",
      "investees",
      "mainland_china_investments",
    ]),
    company_codes: companyCodesSchema,
    period: requestedPeriodSchema.default("latest"),
    ...pageShape,
  })
  .strict();

export const industryDataInputSchema = z
  .object({
    mode: z.enum(["statistics", "trend"]),
    measure: z.enum(["revenue", "net_profit"]).default("revenue"),
    industry_codes: z.array(z.string().trim().min(1).max(20)).max(50).default([]),
    period: requestedPeriodSchema.default("latest"),
    ...rangeShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "trend" && value.industry_codes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["industry_codes"],
        message: "trend 至少需要一個 industry_codes",
      });
    }
  });

export const financialInstitutionInputSchema = z
  .object({
    metric_code: z.string().trim().min(1).max(100),
    institution_codes: z.array(z.string().trim().min(1).max(30)).min(1).max(10),
    ...rangeShape,
  })
  .strict();

const sourceShape = {
  sourceName: z.string(),
  sourceUrl: z.string().url(),
  retrievedAt: z.string(),
  upstreamRoute: z.string(),
  freshnessNote: z.string(),
};

const warningShape = {
  warnings: z.array(z.string()),
};

const pointSchema = z
  .object({
    period: z.string(),
    value: z.number().nullable(),
    status: z.string().optional(),
  })
  .strict();

const seriesSchema = z
  .object({
    label: z.string(),
    points: z.array(pointSchema),
  })
  .strict();

const trendShape = {
  unit: z.string(),
  periods: z.array(z.string()),
  series: z.array(seriesSchema),
};

const rangeOutputShape = {
  history: z.enum(["recent_12", "all"]),
  startPeriod: z.string().optional(),
  endPeriod: z.string().optional(),
};

export const findCompaniesOutputSchema = z
  .object({
    ...sourceShape,
    query: z.object({ query: z.string(), limit: z.number().int() }).strict(),
    companies: z.array(
      z
        .object({
          code: z.string(),
          name: z.string(),
          displayName: z.string(),
        })
        .strict(),
    ),
    ...warningShape,
  })
  .strict();

const metricDefinitionSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    unit: z.string(),
    category: z.string(),
    family: z.enum(["data", "report", "bcode", "xb", "fin", "adequacy"]),
  })
  .strict();

export const listCatalogOutputSchema = z
  .object({
    ...sourceShape,
    query: z
      .object({
        kind: z.enum([
          "all",
          "metrics",
          "industries",
          "financial_institutions",
          "periods",
        ]),
        query: z.string().optional(),
        limit: z.number().int(),
      })
      .strict(),
    discoveredAt: z.string(),
    counts: z
      .object({
        metrics: z.number().int(),
        industries: z.number().int(),
        financialInstitutions: z.number().int(),
        periods: z.number().int(),
      })
      .strict(),
    metrics: z.array(metricDefinitionSchema),
    industries: z.array(
      z.object({ code: z.string(), name: z.string() }).strict(),
    ),
    financialInstitutions: z.array(
      z
        .object({
          code: z.string(),
          name: z.string(),
          sector: z.enum(["holding", "bank", "bills", "unknown"]),
        })
        .strict(),
    ),
    periods: z.array(periodSchema),
    ...warningShape,
  })
  .strict();

export const companyMetricOutputSchema = z
  .object({
    ...sourceShape,
    query: z
      .object({
        metricCode: z.string(),
        metricName: z.string(),
        companyCodes: z.array(z.string()),
        companies: z.array(z.string()),
        basis: z.enum(["quarterly", "cumulative_yoy"]),
        yoyQuarter: z.number().int().optional(),
        ...rangeOutputShape,
      })
      .strict(),
    ...trendShape,
    ...warningShape,
  })
  .strict();

const tableSchema = z
  .object({
    title: z.string(),
    headers: z.array(z.array(z.string())),
    rows: z.array(z.array(z.string())),
  })
  .strict();

const paginationSchema = z
  .object({
    offset: z.number().int(),
    limit: z.number().int(),
    returnedRows: z.number().int(),
    totalRows: z.number().int(),
    nextOffset: z.number().int().nullable(),
  })
  .strict();

export const financialStatementOutputSchema = z
  .object({
    ...sourceShape,
    query: z
      .object({
        statement: z.enum(["balance_sheet", "income_statement", "cash_flow"]),
        companyCodes: z.array(z.string()),
        companies: z.array(z.string()),
        period: periodSchema,
      })
      .strict(),
    unit: z.string(),
    period: periodSchema,
    reportNames: z.array(z.string()),
    tables: z.array(tableSchema),
    pagination: paginationSchema,
    ...warningShape,
  })
  .strict();

export const financialNoteOutputSchema = financialStatementOutputSchema.extend({
  query: z
    .object({
      note: z.enum([
        "consolidated_subsidiaries",
        "loans_to_others",
        "endorsements_guarantees",
        "investees",
        "mainland_china_investments",
      ]),
      companyCodes: z.array(z.string()),
      companies: z.array(z.string()),
      period: periodSchema,
    })
    .strict(),
}).strict();

export const industryDataOutputSchema = z
  .object({
    ...sourceShape,
    query: z
      .object({
        mode: z.enum(["statistics", "trend"]),
        measure: z.enum(["revenue", "net_profit"]),
        industryCodes: z.array(z.string()),
        industries: z.array(z.string()).optional(),
        period: periodSchema.optional(),
        history: z.enum(["recent_12", "all"]).optional(),
        startPeriod: z.string().optional(),
        endPeriod: z.string().optional(),
      })
      .strict(),
    ...trendShape,
    ...warningShape,
  })
  .strict();

export const financialInstitutionOutputSchema = z
  .object({
    ...sourceShape,
    query: z
      .object({
        metricCode: z.string(),
        metricName: z.string(),
        institutionCodes: z.array(z.string()),
        institutions: z.array(z.string()),
        ...rangeOutputShape,
      })
      .strict(),
    ...trendShape,
    ...warningShape,
  })
  .strict();
