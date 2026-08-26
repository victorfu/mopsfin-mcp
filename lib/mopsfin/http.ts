import {
  MOPSFIN_BASE_URL,
  MOPSFIN_SOURCE_URL,
  UPSTREAM_RETRY_DELAY_MS,
  UPSTREAM_TIMEOUT_MS,
  type AllowedGetPath,
  type AllowedPostPath,
} from "./constants";
import { MopsfinError } from "./errors";
import {
  AbsoluteDeadline,
  BoundedSemaphore,
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

type FetchLike = typeof fetch;

export interface UpstreamResponse {
  body: string;
  contentType: string;
  status: number;
}

export interface MopsfinHttpClientOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
  maxResponseBytes?: number;
  semaphore?: BoundedSemaphore;
}

const DEFAULT_DEADLINE_MS = 50_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class MopsfinHttpClient {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly semaphore: BoundedSemaphore;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    options: MopsfinHttpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? UPSTREAM_RETRY_DELAY_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.semaphore = options.semaphore ?? globalUpstreamSemaphore;
  }

  async get(path: AllowedGetPath, query?: URLSearchParams): Promise<UpstreamResponse> {
    const url = new URL(path, MOPSFIN_BASE_URL);
    if (query) {
      url.search = query.toString();
    }
    return this.request(url, { method: "GET" });
  }

  async post(
    path: AllowedPostPath,
    fields: Record<string, string | number | boolean | Array<string | number>>,
  ): Promise<UpstreamResponse> {
    const body = new URLSearchParams();
    for (const [key, raw] of Object.entries(fields)) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        body.append(key, String(value));
      }
    }

    return this.request(new URL(path, MOPSFIN_BASE_URL), {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Origin: MOPSFIN_BASE_URL,
        Referer: MOPSFIN_SOURCE_URL,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
  }

  private async request(url: URL, init: RequestInit): Promise<UpstreamResponse> {
    const deadline = new AbsoluteDeadline(this.deadlineMs);
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        let scope: AttemptAbortScope | undefined;
        let release: (() => void) | undefined;
        let upstreamRetryAfterMs: number | null = null;
        try {
          scope = createAttemptAbortScope(deadline, this.timeoutMs);
          release = await this.semaphore.acquire(scope.signal);
          const response = await this.fetchImpl(url, {
            ...init,
            cache: "no-store",
            redirect: "error",
            signal: scope.signal,
            headers: {
              Accept: "application/json, text/html;q=0.9, */*;q=0.8",
              "User-Agent": "mopsfin-mcp/0.3.1 (+https://mopsfin.twse.com.tw/)",
              ...init.headers,
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
              status: response.status,
              contentType: response.headers.get("content-type") ?? "",
            };
          }

          if (response.status === 429) {
            lastError = new MopsfinError(
              "UPSTREAM_RATE_LIMITED",
              "Mopsfin 暫時限制查詢頻率，請稍後再試。",
              {
                status: response.status,
                reason: "UPSTREAM_HTTP_429",
                retryable: true,
                retryAfterMs: upstreamRetryAfterMs ?? undefined,
                action: "retry",
              },
            );
          } else {
            const transient = response.status >= 500;
            lastError = new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `Mopsfin 回傳 HTTP ${response.status}。`,
              {
                status: response.status,
                reason: transient ? "UPSTREAM_HTTP_5XX" : "UPSTREAM_HTTP_4XX",
                retryable: transient,
                retryAfterMs: upstreamRetryAfterMs ?? undefined,
                action: transient ? "retry" : "none",
              },
            );
          }

          if (response.status !== 429 && response.status < 500) {
            throw lastError;
          }
        } catch (error) {
          if (error instanceof MopsfinError) {
            lastError = error;
            if (
              error.code === "UPSTREAM_BAD_RESPONSE" &&
              error.status !== undefined &&
              error.status < 500
            ) {
              throw error;
            }
          } else if (error instanceof UpstreamReliabilityError) {
            if (error.code === "BACKPRESSURE") {
              throw new MopsfinError(
                "UPSTREAM_RATE_LIMITED",
                "服務目前有過多上游工作，請稍後再試。",
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
                "Mopsfin 回應超過服務安全處理上限。",
                {
                  cause: error,
                  reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
                  retryable: false,
                  action: "none",
                },
              );
            }
            lastError = this.timeoutError(error, scope);
          } else if (scope?.signal.aborted) {
            lastError = this.timeoutError(error, scope);
          } else {
            lastError = new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              "無法連線至 Mopsfin。",
              {
                cause: error,
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

        if (attempt < this.maxAttempts - 1) {
          recordUpstreamReliabilityEvent("retryScheduled");
          const waitMs = retryDelayMs({
            attempt,
            baseDelayMs: this.retryDelayMs,
            retryAfterMs:
              lastError instanceof MopsfinError
                ? lastError.retryAfterMs
                : upstreamRetryAfterMs,
          });
          try {
            await delayWithinDeadline(waitMs, deadline);
          } catch (error) {
            throw this.timeoutError(error);
          }
        }
      }
    } finally {
      deadline.dispose();
    }

    throw lastError;
  }

  private timeoutError(
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
        ? "Mopsfin 查詢超過本次工作的總時間上限。"
        : `Mopsfin 在 ${this.timeoutMs / 1000} 秒內沒有回應。`,
      {
        cause,
        reason: deadlineExceeded
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : "UPSTREAM_ATTEMPT_TIMEOUT",
        retryable: true,
        action: "retry",
      },
    );
  }
}
