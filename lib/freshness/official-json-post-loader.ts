import { MopsfinError } from "@/lib/mopsfin/errors";
import { UPSTREAM_HTTP_USER_AGENT } from "@/lib/server/identity";
import {
  observeCache,
  type CacheProvenance,
  type CacheStatus,
} from "@/lib/upstream/cache-provenance";
import {
  AbsoluteDeadline,
  assertJsonWithinLimits,
  BoundedSemaphore,
  BoundedTtlLru,
  createAttemptAbortScope,
  createSharedUpstreamFlight,
  delayWithinDeadline,
  globalUpstreamSemaphore,
  parseRetryAfterMs,
  readResponseTextWithLimit,
  recordUpstreamReliabilityEvent,
  retryDelayMs,
  UpstreamReliabilityError,
  type AttemptAbortScope,
  type SharedUpstreamFlight,
} from "@/lib/upstream/reliability";

export interface OfficialJsonPostSnapshot {
  payload: unknown;
  retrievedAt: string;
  cache?: CacheProvenance;
}

interface StoredSnapshot {
  snapshot: Omit<OfficialJsonPostSnapshot, "cache">;
  storedAtMs: number | null;
}

export interface OfficialJsonPostLoaderOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
  maxResponseBytes?: number;
  maxJsonArrayLength?: number;
  maxJsonNodes?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  semaphore?: BoundedSemaphore;
}

export interface OfficialJsonPostRequest {
  sourceName: string;
  sourceUrl: string;
  fields: Readonly<Record<string, string>>;
  allowedOrigin: string;
  allowedPath: string;
}

/** Bounded, cookie-free form POST loader with an exact caller-supplied allowlist. */
export class OfficialJsonPostLoader {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxJsonArrayLength: number;
  private readonly maxJsonNodes: number;
  private readonly cacheTtlMs: number;
  private readonly semaphore: BoundedSemaphore;
  private readonly cache: BoundedTtlLru<string, StoredSnapshot>;
  private readonly pending = new Map<
    string,
    SharedUpstreamFlight<StoredSnapshot>
  >();

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => Date,
    options: OfficialJsonPostLoaderOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.deadlineMs = options.deadlineMs ?? 50_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxJsonArrayLength = options.maxJsonArrayLength ?? 5_000;
    this.maxJsonNodes = options.maxJsonNodes ?? 100_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1_000;
    this.semaphore = options.semaphore ?? globalUpstreamSemaphore;
    this.cache = new BoundedTtlLru(
      options.cacheMaxEntries ?? 16,
      options.cacheMaxBytes ?? 8 * 1024 * 1024,
    );
  }

  async post(
    request: OfficialJsonPostRequest,
    operationDeadline?: AbsoluteDeadline,
  ): Promise<OfficialJsonPostSnapshot> {
    const url = new URL(request.sourceUrl);
    if (
      url.origin !== request.allowedOrigin ||
      url.pathname !== request.allowedPath ||
      url.search ||
      url.hash
    ) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "Official JSON POST loader 的來源不在固定 allowlist。",
        { details: { sourceUrl: request.sourceUrl } },
      );
    }
    const normalizedFields = Object.entries(request.fields).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const body = new URLSearchParams(normalizedFields).toString();
    const cacheKey = `POST ${request.sourceUrl}?${body}`;
    const deadline = operationDeadline ?? new AbsoluteDeadline(this.deadlineMs);
    const ownsDeadline = operationDeadline === undefined;
    const observedAtMs = this.now().getTime();
    try {
      deadline.throwIfExpired();
      const cached = this.cache.get(cacheKey, observedAtMs);
      if (cached) return this.observe(cached, "hit", observedAtMs);
      let flight = this.pending.get(cacheKey);
      let status: CacheStatus = "shared";
      if (flight && flight.state !== "active") {
        if (this.pending.get(cacheKey) === flight) {
          this.pending.delete(cacheKey);
        }
        flight = undefined;
      }
      if (!flight) {
        status = this.cacheTtlMs > 0 ? "miss" : "bypass";
        flight = createSharedUpstreamFlight(
          this.deadlineMs,
          async (sharedDeadline) => {
            const loaded = await this.requestJson(
              request,
              body,
              sharedDeadline,
            );
            const storedAtMs =
              this.cacheTtlMs > 0 ? this.now().getTime() : null;
            const stored = { snapshot: loaded.snapshot, storedAtMs };
            if (storedAtMs !== null) {
              this.cache.set(cacheKey, stored, {
                ttlMs: this.cacheTtlMs,
                weight: loaded.byteLength,
                nowMs: storedAtMs,
              });
            }
            return stored;
          },
        );
        this.pending.set(cacheKey, flight);
        const currentFlight = flight;
        const clear = () => {
          if (this.pending.get(cacheKey) === currentFlight) {
            this.pending.delete(cacheKey);
          }
        };
        void flight.promise.then(clear, clear);
      }
      const stored = await flight.wait(deadline);
      return this.observe(stored, status, this.now().getTime());
    } catch (error) {
      if (error instanceof UpstreamReliabilityError) {
        throw this.timeoutError(request, error);
      }
      throw error;
    } finally {
      if (ownsDeadline) deadline.dispose();
    }
  }

  private observe(
    stored: StoredSnapshot,
    status: CacheStatus,
    observedAtMs: number,
  ): OfficialJsonPostSnapshot {
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

  private async requestJson(
    request: OfficialJsonPostRequest,
    body: string,
    deadline: AbsoluteDeadline,
  ): Promise<{
    snapshot: Omit<OfficialJsonPostSnapshot, "cache">;
    byteLength: number;
  }> {
    let lastError: MopsfinError | undefined;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let scope: AttemptAbortScope | undefined;
      let release: (() => void) | undefined;
      let upstreamRetryAfterMs: number | null = null;
      try {
        scope = createAttemptAbortScope(deadline, this.timeoutMs);
        release = await this.semaphore.acquire(scope.signal);
        const response = await this.fetchImpl(request.sourceUrl, {
          method: "POST",
          body,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: scope.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Origin: request.allowedOrigin,
            Referer: `${request.allowedOrigin}/zh-tw/announce/market/holiday.html`,
            "User-Agent": UPSTREAM_HTTP_USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        const responseBody = await readResponseTextWithLimit(
          response,
          this.maxResponseBytes,
        );
        upstreamRetryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );
        if (response.ok) {
          try {
            const payload = JSON.parse(responseBody.text) as unknown;
            assertJsonWithinLimits(payload, {
              maximumArrayLength: this.maxJsonArrayLength,
              maximumNodes: this.maxJsonNodes,
            });
            return {
              snapshot: {
                payload,
                retrievedAt: this.now().toISOString(),
              },
              byteLength: responseBody.byteLength,
            };
          } catch (error) {
            if (error instanceof UpstreamReliabilityError) throw error;
            lastError = new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `${request.sourceName}不是有效 JSON。`,
              {
                cause: error,
                details: { sourceUrl: request.sourceUrl },
                reason: "UPSTREAM_INVALID_JSON",
                retryable: true,
                action: "retry",
              },
            );
          }
        } else {
          const transient = response.status === 429 || response.status >= 500;
          lastError = new MopsfinError(
            response.status === 429
              ? "UPSTREAM_RATE_LIMITED"
              : "UPSTREAM_BAD_RESPONSE",
            `${request.sourceName}回傳 HTTP ${response.status}。`,
            {
              status: response.status,
              details: { sourceUrl: request.sourceUrl },
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
        }
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
              "服務目前有過多上游 completed-session 工作，請稍後再試。",
              {
                cause: error,
                reason: "UPSTREAM_BACKPRESSURE",
                retryable: true,
                retryAfterMs: error.retryAfterMs,
                action: "retry",
              },
            );
          }
          if (
            error.code === "RESPONSE_TOO_LARGE" ||
            error.code === "ROW_LIMIT_EXCEEDED"
          ) {
            throw new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `${request.sourceName}回應超過安全上限。`,
              {
                cause: error,
                reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
                retryable: false,
                action: "none",
                details: { sourceUrl: request.sourceUrl },
              },
            );
          }
          lastError = this.timeoutError(request, error, scope);
        } else if (scope?.signal.aborted) {
          lastError = this.timeoutError(request, error, scope);
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `${request.sourceName}網路查詢失敗。`,
            {
              cause: error,
              details: { sourceUrl: request.sourceUrl },
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
            retryAfterMs: lastError?.retryAfterMs ?? upstreamRetryAfterMs,
          }),
          deadline,
        );
      }
    }
    throw (
      lastError ??
      new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `${request.sourceName}查詢失敗。`,
      )
    );
  }

  private timeoutError(
    request: OfficialJsonPostRequest,
    cause: unknown,
    scope?: AttemptAbortScope,
  ): MopsfinError {
    const deadlineExceeded =
      scope?.abortKind() === "deadline" ||
      (cause instanceof UpstreamReliabilityError &&
        cause.code === "DEADLINE_EXCEEDED");
    const operationAborted =
      scope === undefined &&
      cause instanceof UpstreamReliabilityError &&
      cause.code === "ABORTED";
    return new MopsfinError(
      "UPSTREAM_TIMEOUT",
      deadlineExceeded
        ? `${request.sourceName}超過本次工作的總時間上限。`
        : operationAborted
          ? `${request.sourceName}查詢已取消。`
          : `${request.sourceName}查詢逾時。`,
      {
        cause,
        details: { sourceUrl: request.sourceUrl },
        reason: deadlineExceeded
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : operationAborted
            ? "UPSTREAM_OPERATION_ABORTED"
            : "UPSTREAM_ATTEMPT_TIMEOUT",
        retryable: true,
        action: "retry",
      },
    );
  }
}
