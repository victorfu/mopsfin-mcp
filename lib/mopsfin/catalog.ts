import { load } from "cheerio";

import { CATALOG_TTL_MS } from "./constants";
import { MopsfinError } from "./errors";
import { MopsfinHttpClient } from "./http";
import {
  observeCache,
  type CacheStatus,
} from "@/lib/upstream/cache-provenance";
import {
  createSharedUpstreamFlight,
  getCurrentDeadline,
  UpstreamReliabilityError,
  type AbsoluteDeadline,
  type SharedUpstreamFlight,
} from "@/lib/upstream/reliability";
import type {
  Catalog,
  EndpointFamily,
  FinancialInstitutionDefinition,
  IndustryDefinition,
  MetricDefinition,
} from "./types";

const CATALOG_FLIGHT_DEADLINE_MS = 50_000;

interface StoredCatalog {
  value: Omit<Catalog, "cache">;
  storedAtMs: number;
}

function inferFamily(classes: string[]): EndpointFamily {
  if (classes.includes("qaClass")) return "bcode";
  if (classes.includes("capitalAdequacyClass")) return "adequacy";
  if (classes.includes("compareFinClass")) return "fin";
  if (
    classes.includes("companyClass") &&
    classes.includes("ysoClass")
  ) {
    return "report";
  }
  if (
    classes.includes("companyClass") &&
    !classes.includes("ystClass") &&
    !classes.includes("ysoClass")
  ) {
    return "xb";
  }
  return "data";
}

export function parseCatalogHtml(html: string, now = new Date()): Catalog {
  const $ = load(html);
  const metrics: MetricDefinition[] = [];
  const industries: IndustryDefinition[] = [];
  const financialInstitutions: FinancialInstitutionDefinition[] = [];

  $("a.compareClass[name]").each((_, element) => {
    const anchor = $(element);
    const code = anchor.attr("name")?.trim();
    if (!code) return;

    const classes = (anchor.attr("class") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const category = anchor
      .closest(".accordion-item")
      .children(".accordion-title")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    metrics.push({
      code,
      name: anchor.text().replace(/^●\s*/, "").replace(/\s+/g, " ").trim(),
      unit: anchor.attr("label")?.trim() ?? "",
      category,
      family: inferFamily(classes),
    });
  });

  $("input.bcodeClass[type='checkbox']").each((_, element) => {
    const input = $(element);
    const code = input.attr("value")?.trim();
    if (!code) return;
    const id = input.attr("id");
    const name = (
      input.closest("label").text() ||
      (id ? $(`label[for='${id}']`).text() : "") ||
      input.parent().text()
    )
      .replace(/\s+/g, " ")
      .trim();
    if (name) industries.push({ code, name });
  });

  $("#setting-fin input[name='finCompanyId']").each((_, element) => {
    const input = $(element);
    const code = input.attr("value")?.trim();
    if (!code) return;
    const panel = input.closest(".tabs-panel").attr("id");
    const sector: FinancialInstitutionDefinition["sector"] =
      panel === "panel1"
        ? "holding"
        : panel === "panel2"
          ? "bank"
          : panel === "panel3"
            ? "bills"
            : "unknown";
    const name = (input.closest("label").text() || input.parent().text())
      .replace(/\s+/g, " ")
      .trim();
    if (name) financialInstitutions.push({ code, name, sector });
  });

  const years = $("#selectYear option")
    .map((_, option) => Number($(option).attr("value")))
    .get()
    .filter(Number.isInteger);
  const quarters = $("#selectSeason option")
    .map((_, option) => Number($(option).attr("value")))
    .get()
    .filter((quarter) => Number.isInteger(quarter) && quarter >= 1 && quarter <= 4);

  if (metrics.length === 0 || industries.length === 0) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "無法從 Mopsfin 首頁解析資料目錄，網站結構可能已變更。",
      { details: { metricCount: metrics.length, industryCount: industries.length } },
    );
  }

  return {
    metrics,
    industries,
    financialInstitutions,
    years: [...new Set(years)].sort((a, b) => a - b),
    quarters: [...new Set(quarters)].sort((a, b) => a - b),
    discoveredAt: now.toISOString(),
  };
}

export class CatalogService {
  private cached?: { expiresAt: number; stored: StoredCatalog };
  private pending?: SharedUpstreamFlight<StoredCatalog>;

  constructor(
    private readonly http: MopsfinHttpClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCatalog(force = false): Promise<Catalog> {
    const now = this.now().getTime();
    const callerDeadline = getCurrentDeadline();
    if (!force && this.cached && this.cached.expiresAt > now) {
      return this.observe(this.cached.stored, "hit", now);
    }
    if (this.pending?.state === "active") {
      const stored = await this.waitForCatalog(this.pending, callerDeadline);
      return this.observe(stored, "shared", this.now().getTime());
    }
    if (this.pending) this.pending = undefined;

    const request = createSharedUpstreamFlight(
      CATALOG_FLIGHT_DEADLINE_MS,
      async () => {
        const response = await this.http.get("/");
        const value = {
          ...parseCatalogHtml(response.body, new Date(response.retrievedAt)),
          retrievedAt: response.retrievedAt,
        };
        const storedAtMs = this.now().getTime();
        const stored = { value, storedAtMs };
        this.cached = {
          stored,
          expiresAt: storedAtMs + CATALOG_TTL_MS,
        };
        return stored;
      },
    );
    this.pending = request;
    const clearRequest = () => {
      if (this.pending === request) this.pending = undefined;
    };
    void request.promise.then(clearRequest, clearRequest);

    const stored = await this.waitForCatalog(request, callerDeadline);
    return this.observe(
      stored,
      force ? "bypass" : "miss",
      this.now().getTime(),
    );
  }

  private async waitForCatalog(
    request: SharedUpstreamFlight<StoredCatalog>,
    deadline: AbsoluteDeadline | undefined,
  ): Promise<StoredCatalog> {
    try {
      return await request.wait(deadline);
    } catch (error) {
      if (error instanceof UpstreamReliabilityError) {
        const deadlineExceeded =
          error.code === "DEADLINE_EXCEEDED" ||
          (error.cause instanceof UpstreamReliabilityError &&
            error.cause.code === "DEADLINE_EXCEEDED");
        throw new MopsfinError(
          "UPSTREAM_TIMEOUT",
          deadlineExceeded
            ? "Mopsfin 目錄查詢超過本次工作的總時間上限。"
            : "Mopsfin 目錄查詢已取消。",
          {
            cause: error,
            reason: deadlineExceeded
              ? "UPSTREAM_DEADLINE_EXCEEDED"
              : "UPSTREAM_OPERATION_ABORTED",
            retryable: true,
            action: "retry",
          },
        );
      }
      throw error;
    }
  }

  private observe(
    stored: StoredCatalog,
    status: CacheStatus,
    observedAtMs: number,
  ): Catalog {
    return {
      ...stored.value,
      cache: observeCache({
        status,
        observedAtMs,
        storedAtMs: stored.storedAtMs,
        ttlMs: CATALOG_TTL_MS,
      }),
    };
  }
}
