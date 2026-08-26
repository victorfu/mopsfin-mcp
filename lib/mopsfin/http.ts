import {
  MOPSFIN_BASE_URL,
  MOPSFIN_SOURCE_URL,
  UPSTREAM_RETRY_DELAY_MS,
  UPSTREAM_TIMEOUT_MS,
  type AllowedGetPath,
  type AllowedPostPath,
} from "./constants";
import { MopsfinError } from "./errors";

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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MopsfinHttpClient {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    options: MopsfinHttpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? UPSTREAM_RETRY_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? 2;
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
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json, text/html;q=0.9, */*;q=0.8",
            "User-Agent": "mopsfin-mcp/0.3.0 (+https://mopsfin.twse.com.tw/)",
            ...init.headers,
          },
        });
        const body = await response.text();

        if (response.ok) {
          return {
            body,
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
          };
        }

        if (response.status === 429) {
          lastError = new MopsfinError(
            "UPSTREAM_RATE_LIMITED",
            "Mopsfin 暫時限制查詢頻率，請稍後再試。",
            { status: response.status },
          );
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `Mopsfin 回傳 HTTP ${response.status}。`,
            { status: response.status },
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
        } else if (controller.signal.aborted) {
          lastError = new MopsfinError(
            "UPSTREAM_TIMEOUT",
            `Mopsfin 在 ${this.timeoutMs / 1000} 秒內沒有回應。`,
            { cause: error },
          );
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            "無法連線至 Mopsfin。",
            { cause: error },
          );
        }
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.maxAttempts - 1) {
        await delay(this.retryDelayMs);
      }
    }

    throw lastError;
  }
}
