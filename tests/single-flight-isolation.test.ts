import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CompanyMasterClient } from "@/lib/company-master/client";
import { OfficialJsonLoader } from "@/lib/market-data/client-utils";
import type { CurrentCompanyMasterLike } from "@/lib/market-data/types";
import { CatalogService } from "@/lib/mopsfin/catalog";
import { MopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinHttpClient } from "@/lib/mopsfin/http";
import { MonthlyRevenueClient } from "@/lib/revenue/client";
import {
  runWithRequestDeadline,
  UpstreamReliabilityError,
} from "@/lib/upstream/reliability";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);
const twseCompanies = readFileSync(
  fileURLToPath(new URL("./fixtures/twse-companies.json", import.meta.url)),
  "utf8",
);
const listedRevenue = readFileSync(
  fileURLToPath(
    new URL("./fixtures/revenue-archive-listed-2026-07.csv", import.meta.url),
  ),
  "utf8",
);

interface ControlledFetch {
  fetchMock: ReturnType<typeof vi.fn>;
  release(): void;
  signal(): AbortSignal;
}

function controlledFetch(body: string, contentType: string): ControlledFetch {
  let releaseResponse: (() => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn(
    async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(requestSignal?.reason);
        };
        requestSignal?.addEventListener("abort", onAbort, { once: true });
        releaseResponse = () => {
          if (settled) return;
          settled = true;
          requestSignal?.removeEventListener("abort", onAbort);
          resolve(
            new Response(body, {
              status: 200,
              headers: { "Content-Type": contentType },
            }),
          );
        };
      }),
  );
  return {
    fetchMock,
    release: () => {
      if (!releaseResponse) throw new Error("upstream request has not started");
      releaseResponse();
    },
    signal: () => {
      if (!requestSignal) throw new Error("upstream request has not started");
      return requestSignal;
    },
  };
}

async function abortLeaderAndAwaitFollower<T>(
  call: () => Promise<T>,
  upstream: ControlledFetch,
): Promise<T> {
  const leaderController = new AbortController();
  const leader = runWithRequestDeadline(
    2_000,
    call,
    leaderController.signal,
  ).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await vi.waitFor(() => expect(upstream.fetchMock).toHaveBeenCalledTimes(1));

  const follower = runWithRequestDeadline(2_000, call);
  await Promise.resolve();
  await Promise.resolve();
  leaderController.abort(
    new UpstreamReliabilityError("ABORTED", "leader request disconnected"),
  );

  expect((await leader).status).toBe("rejected");
  expect(upstream.signal().aborted).toBe(false);
  upstream.release();
  const value = await follower;
  expect(upstream.fetchMock).toHaveBeenCalledTimes(1);
  return value;
}

const now = () => new Date("2026-08-26T00:00:00.000Z");

describe("single-flight request cancellation isolation", () => {
  it("keeps an OfficialJsonLoader flight alive for a healthy follower", async () => {
    const upstream = controlledFetch('[{"Code":"2330"}]', "application/json");
    const loader = new OfficialJsonLoader(upstream.fetchMock as typeof fetch, now, {
      deadlineMs: 1_000,
      maxAttempts: 1,
    });
    const result = await abortLeaderAndAwaitFollower(
      () =>
        loader.get({
          market: "listed",
          exchange: "TWSE",
          sourceName: "fixture",
          sourceUrl: "https://example.test/official.json",
        }),
      upstream,
    );

    expect(result.payload).toEqual([{ Code: "2330" }]);
    expect(result.cache?.status).toBe("shared");
  });

  it("keeps a company-master normalization flight alive for a healthy follower", async () => {
    const upstream = controlledFetch(twseCompanies, "application/json");
    const client = new CompanyMasterClient(
      upstream.fetchMock as typeof fetch,
      now,
      {
        deadlineMs: 1_000,
        maxAttempts: 1,
        minimumCompanyCounts: { listed: 1, otc: 1 },
      },
    );
    const result = await abortLeaderAndAwaitFollower(
      () =>
        client.listCompanies({
          market: "listed",
          includeFinancial: true,
          includeKy: true,
        }),
      upstream,
    );

    expect(result.companies.map((company) => company.code)).toContain("2330");
    expect(result.sources[0].cache?.status).toBe("shared");
  });

  it("keeps a MOPS revenue CSV flight alive for a healthy follower", async () => {
    const upstream = controlledFetch(listedRevenue, "text/csv");
    const companyMaster = {
      listCompanies: vi.fn(async () => ({ companies: [] })),
    } as unknown as CurrentCompanyMasterLike;
    const client = new MonthlyRevenueClient(
      upstream.fetchMock as typeof fetch,
      now,
      companyMaster,
      { deadlineMs: 1_000, maxAttempts: 1 },
    );
    const result = await abortLeaderAndAwaitFollower(
      () =>
        client.getMonthlyRevenue({
          market: "listed",
          dataMonth: "2026-07",
          universePolicy: "compatible",
        }),
      upstream,
    );

    expect(result.dataMonth).toBe("2026-07");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.sources[0].cache?.status).toBe("shared");
  });

  it("keeps a Mopsfin identity flight alive for a healthy follower", async () => {
    const upstream = controlledFetch(
      JSON.stringify({ suggestions: ["2330 台積電"] }),
      "application/json",
    );
    const client = new MopsfinClient(
      new MopsfinHttpClient(upstream.fetchMock as typeof fetch, {
        deadlineMs: 1_000,
        maxAttempts: 1,
      }),
      now,
      { identityCacheTtlMs: 0, identityFlightDeadlineMs: 1_000 },
    );
    const result = await abortLeaderAndAwaitFollower(
      () => client.resolveCompanies(["2330"]),
      upstream,
    );

    expect(result).toEqual([
      { code: "2330", name: "台積電", displayName: "2330 台積電" },
    ]);
  });

  it("keeps a catalog flight alive for a healthy follower", async () => {
    const upstream = controlledFetch(catalogHtml, "text/html");
    const catalog = new CatalogService(
      new MopsfinHttpClient(upstream.fetchMock as typeof fetch, {
        deadlineMs: 1_000,
        maxAttempts: 1,
      }),
    );
    const result = await abortLeaderAndAwaitFollower(
      () => catalog.getCatalog(),
      upstream,
    );

    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.cache?.status).toBe("shared");
  });
});
