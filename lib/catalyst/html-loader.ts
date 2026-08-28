import { MopsfinError } from "@/lib/mopsfin/errors";
import { UPSTREAM_HTTP_USER_AGENT } from "@/lib/server/identity";
import {
  observeCache,
  type CacheProvenance,
  type CacheStatus,
} from "@/lib/upstream/cache-provenance";
import {
  AbsoluteDeadline,
  BoundedSemaphore,
  BoundedTtlLru,
  createAttemptAbortScope,
  delayWithinDeadline,
  globalUpstreamSemaphore,
  parseRetryAfterMs,
  readResponseTextWithLimit,
  recordUpstreamReliabilityEvent,
  retryDelayMs,
  UpstreamReliabilityError,
  type AttemptAbortScope,
} from "@/lib/upstream/reliability";

export interface CatalystHtmlSnapshot {
  body: string;
  contentType: string;
  retrievedAt: string;
  /** Acquisition-layer metadata; public tool schemas wire this separately. */
  cache?: CacheProvenance;
}

interface StoredCatalystHtmlSnapshot {
  snapshot: Omit<CatalystHtmlSnapshot, "cache">;
  storedAtMs: number | null;
}

export interface CatalystHtmlPostLoader {
  post(
    sourceName: string,
    sourceUrl: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<CatalystHtmlSnapshot>;
}

export interface OfficialHtmlPostLoaderOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
  maxResponseBytes?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  semaphore?: BoundedSemaphore;
}

const MOPS_ORIGIN = "https://mopsov.twse.com.tw";

/** Bounded, cookie-free loader for the two allowlisted official MOPS adapters. */
export class OfficialHtmlPostLoader implements CatalystHtmlPostLoader {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly cacheTtlMs: number;
  private readonly semaphore: BoundedSemaphore;
  private readonly cache: BoundedTtlLru<string, StoredCatalystHtmlSnapshot>;
  private readonly pending = new Map<
    string,
    Promise<StoredCatalystHtmlSnapshot>
  >();

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => Date,
    options: OfficialHtmlPostLoaderOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.deadlineMs = options.deadlineMs ?? 50_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.semaphore = options.semaphore ?? globalUpstreamSemaphore;
    this.cache = new BoundedTtlLru(
      options.cacheMaxEntries ?? 128,
      options.cacheMaxBytes ?? 32 * 1024 * 1024,
    );
  }

  async post(
    sourceName: string,
    sourceUrl: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<CatalystHtmlSnapshot> {
    const url = new URL(sourceUrl);
    if (
      url.origin !== MOPS_ORIGIN ||
      ![
        "/mops/web/ajax_t05st01",
        "/mops/web/ajax_t100sb02_1",
      ].includes(url.pathname)
    ) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "Catalyst HTML loader 僅允許官方 MOPS 歷史事件端點。",
        { details: { sourceUrl } },
      );
    }

    const normalizedFields = Object.entries(fields).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const cacheKey = `${sourceUrl}?${new URLSearchParams(normalizedFields).toString()}`;
    const observedAtMs = this.now().getTime();
    const cached = this.cache.get(cacheKey, observedAtMs);
    if (cached) return this.observe(cached, "hit", observedAtMs);
    const existing = this.pending.get(cacheKey);
    if (existing) {
      const stored = await existing;
      return this.observe(stored, "shared", this.now().getTime());
    }
    const pending = this.request(sourceName, sourceUrl, fields).then((snapshot) => {
      const storedAtMs = this.cacheTtlMs > 0 ? this.now().getTime() : null;
      const stored = { snapshot, storedAtMs };
      if (storedAtMs !== null) {
        this.cache.set(cacheKey, stored, {
          ttlMs: this.cacheTtlMs,
          weight: Buffer.byteLength(snapshot.body, "utf8"),
          nowMs: storedAtMs,
        });
      }
      return stored;
    });
    this.pending.set(cacheKey, pending);
    const clear = () => {
      if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey);
    };
    void pending.then(clear, clear);
    const stored = await pending;
    return this.observe(
      stored,
      this.cacheTtlMs > 0 ? "miss" : "bypass",
      this.now().getTime(),
    );
  }

  private observe(
    stored: StoredCatalystHtmlSnapshot,
    status: CacheStatus,
    observedAtMs: number,
  ): CatalystHtmlSnapshot {
    return {
      ...stored.snapshot,
      cache: observeCache({
        status,
        observedAtMs,
        storedAtMs: stored.storedAtMs,
        ttlMs: this.cacheTtlMs,
      }),
    };
  }

  private async request(
    sourceName: string,
    sourceUrl: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<Omit<CatalystHtmlSnapshot, "cache">> {
    const url = new URL(sourceUrl);

    const deadline = new AbsoluteDeadline(this.deadlineMs);
    let lastError: MopsfinError | undefined;
    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        let scope: AttemptAbortScope | undefined;
        let release: (() => void) | undefined;
        let upstreamRetryAfterMs: number | null = null;
        try {
          scope = createAttemptAbortScope(deadline, this.timeoutMs);
          release = await this.semaphore.acquire(scope.signal);
          const response = await this.fetchImpl(url, {
            method: "POST",
            body: new URLSearchParams(fields),
            cache: "no-store",
            redirect: "error",
            signal: scope.signal,
            headers: {
              Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
              "Content-Type":
                "application/x-www-form-urlencoded;charset=UTF-8",
              Origin: MOPS_ORIGIN,
              Referer: `${MOPS_ORIGIN}/mops/web/index`,
              "User-Agent": UPSTREAM_HTTP_USER_AGENT,
              "X-Requested-With": "XMLHttpRequest",
            },
          });
          const body = await readResponseTextWithLimit(
            response,
            this.maxResponseBytes,
          );
          upstreamRetryAfterMs = parseRetryAfterMs(
            response.headers.get("retry-after"),
          );
          if (response.ok) {
            return {
              body: body.text,
              contentType: response.headers.get("content-type") ?? "",
              retrievedAt: this.now().toISOString(),
            };
          }

          const transient = response.status === 429 || response.status >= 500;
          lastError = new MopsfinError(
            response.status === 429
              ? "UPSTREAM_RATE_LIMITED"
              : "UPSTREAM_BAD_RESPONSE",
            `MOPS ${sourceName}回傳 HTTP ${response.status}。`,
            {
              status: response.status,
              details: { sourceUrl },
              reason:
                response.status === 429
                  ? "UPSTREAM_HTTP_429"
                  : response.status >= 500
                    ? "UPSTREAM_HTTP_5XX"
                    : "UPSTREAM_HTTP_4XX",
              retryable: transient,
              retryAfterMs: upstreamRetryAfterMs ?? undefined,
              action: transient ? "retry" : "none",
            },
          );
          if (!transient) throw lastError;
        } catch (error) {
          if (error instanceof MopsfinError) {
            lastError = error;
            if (error.retryable === false) throw error;
            if (
              error.status !== undefined &&
              error.status < 500 &&
              error.status !== 429
            ) {
              throw error;
            }
          } else if (error instanceof UpstreamReliabilityError) {
            if (error.code === "BACKPRESSURE") {
              throw new MopsfinError(
                "UPSTREAM_RATE_LIMITED",
                "服務目前有過多上游 catalyst 工作，請稍後再試。",
                {
                  cause: error,
                  reason: "UPSTREAM_BACKPRESSURE",
                  retryable: true,
                  retryAfterMs: error.retryAfterMs,
                  action: "retry",
                },
              );
            }
            if (error.code === "RESPONSE_TOO_LARGE") {
              throw new MopsfinError(
                "UPSTREAM_BAD_RESPONSE",
                `MOPS ${sourceName}回應超過安全上限。`,
                {
                  cause: error,
                  reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
                  retryable: false,
                  action: "none",
                  details: { sourceUrl },
                },
              );
            }
            lastError = this.timeoutError(sourceName, sourceUrl, error, scope);
          } else if (scope?.signal.aborted) {
            lastError = this.timeoutError(sourceName, sourceUrl, error, scope);
          } else {
            lastError = new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `MOPS ${sourceName}網路查詢失敗。`,
              {
                cause: error,
                details: { sourceUrl },
                reason: "UPSTREAM_NETWORK_ERROR",
                retryable: true,
                action: "retry",
              },
            );
          }
        } finally {
          release?.();
          scope?.cleanup();
        }

        if (attempt + 1 < this.maxAttempts) {
          recordUpstreamReliabilityEvent("retryScheduled");
          await delayWithinDeadline(
            retryDelayMs({
              attempt,
              baseDelayMs: this.retryDelayMs,
              retryAfterMs:
                lastError?.retryAfterMs ?? upstreamRetryAfterMs,
            }),
            deadline,
          );
        }
      }
    } finally {
      deadline.dispose();
    }

    throw (
      lastError ??
      new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `MOPS ${sourceName}查詢失敗。`,
        { details: { sourceUrl } },
      )
    );
  }

  private timeoutError(
    sourceName: string,
    sourceUrl: string,
    cause: unknown,
    scope?: AttemptAbortScope,
  ): MopsfinError {
    const deadlineExceeded =
      scope?.abortKind() === "deadline" ||
      (cause instanceof UpstreamReliabilityError &&
        cause.code === "DEADLINE_EXCEEDED");
    return new MopsfinError(
      "UPSTREAM_TIMEOUT",
      deadlineExceeded
        ? `MOPS ${sourceName}超過本次工作的總時間上限。`
        : `MOPS ${sourceName}查詢逾時。`,
      {
        cause,
        details: { sourceUrl },
        reason: deadlineExceeded
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : "UPSTREAM_ATTEMPT_TIMEOUT",
        retryable: true,
        action: "retry",
      },
    );
  }
}
