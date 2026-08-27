import { describe, expect, it } from "vitest";

import {
  companyCatalystEventsInputSchema,
  companyCatalystEventsOutputSchema,
} from "@/lib/mcp/schemas";
import { buildResultMeta } from "@/lib/mcp/result-contract";

describe("company catalyst MCP contract", () => {
  it("defaults to both supported official event families and event pagination", () => {
    expect(
      companyCatalystEventsInputSchema.parse({
        company_codes: ["2330"],
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      }),
    ).toEqual({
      company_codes: ["2330"],
      start_date: "2025-01-01",
      end_date: "2025-12-31",
      event_types: ["material_information", "investor_conference"],
      offset: 0,
      limit: 50,
    });
  });

  it("enforces unique companies/families, real dates, a 366-day inclusive range, and page bounds", () => {
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330", "2330"],
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      }).success,
    ).toBe(false);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330"],
        start_date: "2025-01-01",
        end_date: "2026-01-02",
      }).success,
    ).toBe(false);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330"],
        start_date: "2026-01-01",
        end_date: "2025-12-31",
      }).success,
    ).toBe(false);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330"],
        start_date: "2025-02-31",
        end_date: "2025-03-01",
      }).success,
    ).toBe(false);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330"],
        start_date: "2999-01-01",
        end_date: "2999-01-01",
      }).success,
    ).toBe(true);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330"],
        start_date: "2025-01-01",
        end_date: "2025-12-31",
        event_types: ["material_information", "material_information"],
      }).success,
    ).toBe(false);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["2330"],
        start_date: "2025-01-01",
        end_date: "2025-12-31",
        limit: 101,
      }).success,
    ).toBe(false);
    expect(
      companyCatalystEventsInputSchema.safeParse({
        company_codes: ["1101", "1216", "1301", "2002", "2330"],
        start_date: "2025-01-01",
        end_date: "2025-04-30",
        event_types: ["material_information", "investor_conference"],
      }).success,
    ).toBe(false);
  });

  it("keeps official event dates separate and forbids consensus claims", () => {
    const data = {
      query: {
        companyCodes: ["2330"],
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        eventTypes: ["material_information" as const],
        offset: 0,
        limit: 100,
      },
      generatedAt: "2026-08-27T04:00:00.000Z",
      timezone: "Asia/Taipei" as const,
      scope: "official_disclosure_events" as const,
      isConsensus: false as const,
      events: [
        {
          eventId: "material_information:2330:2025-01-16:1",
          eventType: "material_information" as const,
          companyCode: "2330",
          companyName: "台積電",
          market: "listed" as const,
          title: "公告本公司董事會決議",
          description: "官方重大訊息說明",
          clause: "第31款",
          publishedAt: "2025-01-16T13:30:00+08:00",
          factDate: "2025-01-16",
          scheduledAt: null,
          effectiveAt: null,
          timezone: "Asia/Taipei" as const,
          status: "announced" as const,
          statusBasis: "announcement_publication",
          dateConfidence: "confirmed" as const,
          dateBasis: "publication" as const,
          datePrecision: "minute" as const,
          isConsensus: false as const,
          sourceKey: "mops_material_information_history",
          sourceUrl: "https://mopsov.twse.com.tw/mops/web/t05st01",
          sourceReportDate: null,
          sourceRecordKey: "2330:20250116:1330:1",
          eventDetails: null,
        },
      ],
      failures: [],
      coverage: {
        sourceComplete: true,
        failureIsolation: "per_company_event_type_calendar_month" as const,
        currentSnapshots: [],
        families: [
          {
            eventType: "material_information" as const,
            scope: "current_and_selected_company_history" as const,
            status: "complete" as const,
            requestedStart: "2025-01-01",
            requestedEnd: "2025-12-31",
            failedCompanyCodes: [],
          },
        ],
      },
      familyCoverage: [
        {
          companyCode: "2330",
          eventType: "material_information" as const,
          status: "complete" as const,
          queryStart: "2025-01-01",
          queryEnd: "2025-12-31",
          requestCount: 12,
          completedRequestCount: 12,
          verifiedEmptyRequestCount: 11,
          nonemptyRequestCount: 1,
          eventCount: 1,
          snapshotIdentity: "fixture-family-snapshot",
          failures: [],
        },
      ],
      companies: [
        {
          companyCode: "2330",
          status: "complete" as const,
          eventCount: 1,
          failures: [],
        },
      ],
      counts: {
        requestedCompanies: 1,
        requestedEventTypes: 1,
        totalEvents: 1,
        returnedEvents: 1,
        completeCompanies: 1,
        partialCompanies: 0,
        failedCompanies: 0,
      },
      workBudget: {
        companyCount: 1,
        distinctCalendarMonths: 12,
        eventTypeCount: 1,
        historicalLogicalUnits: 12,
        historicalUpstreamRequests: 12,
        currentSnapshotRequests: 1,
        plannedUpstreamRequests: 13,
        upstreamRequestLimit: 40 as const,
      },
      pagination: {
        offset: 0,
        limit: 100,
        returnedRows: 1,
        totalRows: 1,
        hasMore: false,
        nextOffset: null,
      },
      sources: [
        {
          eventType: "material_information" as const,
          market: null,
          exchange: "MOPS" as const,
          sourceKey: "mops_material_information_history",
          sourceName: "公開資訊觀測站重大訊息歷史查詢",
          sourceUrl: "https://mopsov.twse.com.tw/mops/web/t05st01",
          retrievedAt: "2026-08-27T04:00:00.000Z",
          scope: "selected_company_historical_months" as const,
          queryStart: "2025-01-01",
          queryEnd: "2025-12-31",
          sourceReportDate: null,
          rawRowCount: 1,
          acceptedEventCount: 1,
          snapshotIdentity: "fixture-source-snapshot",
        },
      ],
      fingerprint: "fixture-catalyst-fingerprint",
      warnings: ["官方揭露不是分析師 consensus，也不代表正面或負面催化。"],
    };
    const envelope = {
      ok: true as const,
      meta: buildResultMeta(
        data,
        {
          selector: "range",
          resolved: {
            granularity: "date",
            from: "2025-01-01",
            through: "2025-12-31",
          },
          page: {
            mode: "offset",
            unit: "row",
            limit: 100,
            returned: 1,
            total: 1,
            next: null,
          },
          snapshotId: "fixture-catalyst-snapshot",
          source: "complete",
          universe: "not_applicable",
          selection: "complete",
          values: "complete",
          freshness: "unknown",
        },
        "2026-08-27T04:00:00.000Z",
      ),
      ...data,
    };

    expect(companyCatalystEventsOutputSchema.safeParse(envelope).success).toBe(
      true,
    );
    expect(
      companyCatalystEventsOutputSchema.safeParse({
        ...envelope,
        isConsensus: true,
      }).success,
    ).toBe(false);
    expect(envelope.events[0]).toMatchObject({
      publishedAt: "2025-01-16T13:30:00+08:00",
      factDate: "2025-01-16",
      scheduledAt: null,
      effectiveAt: null,
    });
  });
});
