import { AsyncLocalStorage } from "node:async_hooks";

export type UpstreamReliabilityErrorCode =
  | "ABORTED"
  | "BACKPRESSURE"
  | "DEADLINE_EXCEEDED"
  | "RESPONSE_TOO_LARGE"
  | "ROW_LIMIT_EXCEEDED";

export class UpstreamReliabilityError extends Error {
  readonly code: UpstreamReliabilityErrorCode;
  readonly retryAfterMs?: number;

  constructor(
    code: UpstreamReliabilityErrorCode,
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "UpstreamReliabilityError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type UpstreamReliabilityEvent =
  | "backpressureRejected"
  | "cacheEviction"
  | "cacheHit"
  | "cacheMiss"
  | "deadlineExceeded"
  | "responseLimitExceeded"
  | "retryScheduled"
  | "rowLimitExceeded";

const reliabilityCounters: Record<UpstreamReliabilityEvent, number> = {
  backpressureRejected: 0,
  cacheEviction: 0,
  cacheHit: 0,
  cacheMiss: 0,
  deadlineExceeded: 0,
  responseLimitExceeded: 0,
  retryScheduled: 0,
  rowLimitExceeded: 0,
};

export function recordUpstreamReliabilityEvent(
  event: UpstreamReliabilityEvent,
): void {
  reliabilityCounters[event] += 1;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

const requestDeadlineStorage = new AsyncLocalStorage<AbsoluteDeadline>();

/** Returns the absolute deadline inherited by the current async request context. */
export function getCurrentDeadline(): AbsoluteDeadline | undefined {
  return requestDeadlineStorage.getStore();
}

/**
 * Establishes one deadline for an entire request. Nested AbsoluteDeadline instances
 * automatically clamp themselves to this context and inherit its cancellation.
 */
export async function runWithRequestDeadline<T>(
  durationMs: number,
  callback: (deadline: AbsoluteDeadline) => T | Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const deadline = new AbsoluteDeadline(durationMs, parentSignal);
  try {
    return await requestDeadlineStorage.run(deadline, callback, deadline);
  } finally {
    deadline.dispose();
  }
}

export interface SharedUpstreamFlight<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  readonly waiterCount: number;
  wait(waiterDeadline?: AbsoluteDeadline): Promise<T>;
}

/**
 * Starts one bounded upstream operation outside any caller request context.
 * The shared operation is cancelled once its final waiter leaves, while one
 * caller cancelling cannot poison other active waiters.
 */
export function createSharedUpstreamFlight<T>(
  durationMs: number,
  task: (deadline: AbsoluteDeadline) => T | Promise<T>,
): SharedUpstreamFlight<T> {
  const sharedDeadline = new AbsoluteDeadline(durationMs, undefined, {
    inheritAmbient: false,
  });
  let settled = false;
  let waiterCount = 0;
  let operation: Promise<T>;
  try {
    operation = Promise.resolve(
      requestDeadlineStorage.run(sharedDeadline, task, sharedDeadline),
    );
  } catch (error) {
    sharedDeadline.dispose();
    throw error;
  }
  const promise = operation.finally(() => {
    settled = true;
    sharedDeadline.dispose();
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    get waiterCount() {
      return waiterCount;
    },
    async wait(waiterDeadline?: AbsoluteDeadline): Promise<T> {
      waiterCount += 1;
      try {
        return waiterDeadline
          ? await waitForPromiseWithinDeadline(promise, waiterDeadline)
          : await promise;
      } finally {
        waiterCount -= 1;
        if (waiterCount === 0 && !settled) {
          sharedDeadline.abort(
            new UpstreamReliabilityError(
              "ABORTED",
              "Shared upstream work has no active waiters.",
            ),
          );
        }
      }
    },
  };
}

export interface AbsoluteDeadlineOptions {
  inheritAmbient?: boolean;
}

export class AbsoluteDeadline {
  readonly expiresAtMs: number;
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly parentListeners: Array<{
    signal: AbortSignal;
    listener: () => void;
  }> = [];

  constructor(
    durationMs: number,
    parentSignal?: AbortSignal,
    options: AbsoluteDeadlineOptions = {},
  ) {
    positiveInteger(durationMs, "durationMs");
    const ambientDeadline =
      options.inheritAmbient === false
        ? undefined
        : requestDeadlineStorage.getStore();
    this.expiresAtMs = Math.min(
      Date.now() + durationMs,
      ambientDeadline?.expiresAtMs ?? Number.POSITIVE_INFINITY,
    );
    this.signal = this.controller.signal;
    const parentSignals = new Set(
      [parentSignal, ambientDeadline?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );
    for (const signal of parentSignals) {
      const listener = () => this.abort(signal.reason);
      this.parentListeners.push({ signal, listener });
      if (signal.aborted) this.abort(signal.reason);
      else signal.addEventListener("abort", listener, { once: true });
    }
    this.timer = setTimeout(() => {
      this.abort(
        new UpstreamReliabilityError(
          "DEADLINE_EXCEEDED",
          "Upstream operation deadline exceeded.",
        ),
      );
    }, Math.max(0, this.expiresAtMs - Date.now()));
  }

  get remainingMs(): number {
    return Math.max(0, this.expiresAtMs - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      const resolvedReason =
        reason ??
        new UpstreamReliabilityError("ABORTED", "Upstream operation aborted.");
      if (
        resolvedReason instanceof UpstreamReliabilityError &&
        resolvedReason.code === "DEADLINE_EXCEEDED"
      ) {
        recordUpstreamReliabilityEvent("deadlineExceeded");
      }
      this.controller.abort(resolvedReason);
    }
  }

  throwIfExpired(): void {
    if (this.expired) {
      const error = new UpstreamReliabilityError(
        "DEADLINE_EXCEEDED",
        "Upstream operation deadline exceeded.",
      );
      this.abort(error);
      throw error;
    }
    if (this.signal.aborted) {
      const reason = this.signal.reason;
      if (reason instanceof UpstreamReliabilityError) throw reason;
      throw new UpstreamReliabilityError("ABORTED", "Upstream operation aborted.", {
        cause: reason,
      });
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const { signal, listener } of this.parentListeners) {
      signal.removeEventListener("abort", listener);
    }
    this.parentListeners.length = 0;
  }
}

export interface AttemptAbortScope {
  readonly signal: AbortSignal;
  readonly abortKind: () => "deadline" | "operation" | "timeout" | null;
  cleanup(): void;
}

export function createAttemptAbortScope(
  deadline: AbsoluteDeadline,
  timeoutMs: number,
): AttemptAbortScope {
  positiveInteger(timeoutMs, "timeoutMs");
  deadline.throwIfExpired();
  const controller = new AbortController();
  let kind: "deadline" | "operation" | "timeout" | null = null;
  const remainingMs = deadline.remainingMs;
  const deadlineWins = remainingMs <= timeoutMs;
  const timer = setTimeout(() => {
    kind = deadlineWins ? "deadline" : "timeout";
    controller.abort(
      new UpstreamReliabilityError(
        deadlineWins ? "DEADLINE_EXCEEDED" : "ABORTED",
        deadlineWins
          ? "Upstream operation deadline exceeded."
          : "Upstream attempt timed out.",
      ),
    );
  }, Math.max(1, Math.min(timeoutMs, remainingMs)));
  const onDeadlineAbort = () => {
    const reason = deadline.signal.reason;
    kind =
      reason instanceof UpstreamReliabilityError &&
      reason.code === "DEADLINE_EXCEEDED"
        ? "deadline"
        : "operation";
    controller.abort(reason);
  };
  if (deadline.signal.aborted) onDeadlineAbort();
  else deadline.signal.addEventListener("abort", onDeadlineAbort, { once: true });

  return {
    signal: controller.signal,
    abortKind: () => kind,
    cleanup: () => {
      clearTimeout(timer);
      deadline.signal.removeEventListener("abort", onDeadlineAbort);
    },
  };
}

export async function waitForPromiseWithinDeadline<T>(
  promise: Promise<T>,
  deadline: AbsoluteDeadline,
): Promise<T> {
  deadline.throwIfExpired();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = deadline.signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new UpstreamReliabilityError("ABORTED", "Upstream operation aborted.", {
              cause: reason,
            }),
      );
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        deadline.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        deadline.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function delayWithinDeadline(
  delayMs: number,
  deadline: AbsoluteDeadline,
): Promise<void> {
  if (delayMs <= 0) {
    deadline.throwIfExpired();
    return;
  }
  deadline.throwIfExpired();
  if (delayMs >= deadline.remainingMs) {
    throw new UpstreamReliabilityError(
      "DEADLINE_EXCEEDED",
      "Retry delay would exceed the upstream operation deadline.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      deadline.signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : new UpstreamReliabilityError("ABORTED", "Upstream operation aborted."),
      );
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseRetryAfterMs(
  raw: string | null,
  nowMs = Date.now(),
  maximumMs = 30_000,
): number | null {
  if (!raw) return null;
  const normalized = raw.trim();
  if (!normalized) return null;
  let delayMs: number;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    delayMs = Math.ceil(Number(normalized) * 1_000);
  } else {
    const timestamp = Date.parse(normalized);
    if (!Number.isFinite(timestamp)) return null;
    delayMs = Math.max(0, timestamp - nowMs);
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) return null;
  return Math.min(delayMs, Math.max(0, maximumMs));
}

export function retryDelayMs(options: {
  attempt: number;
  baseDelayMs: number;
  retryAfterMs?: number | null;
  maximumMs?: number;
  random?: () => number;
}): number {
  const maximumMs = options.maximumMs ?? 30_000;
  const base = Math.max(0, options.baseDelayMs) * 2 ** Math.max(0, options.attempt);
  const jitter = base * 0.25 * (options.random ?? Math.random)();
  return Math.min(
    maximumMs,
    Math.max(options.retryAfterMs ?? 0, Math.ceil(base + jitter)),
  );
}

export async function readResponseTextWithLimit(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; byteLength: number }> {
  positiveInteger(maximumBytes, "maximumBytes");
  const rawLength = response.headers.get("content-length");
  if (rawLength && /^\d+$/.test(rawLength)) {
    const declared = Number(rawLength);
    if (Number.isSafeInteger(declared) && declared > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      recordUpstreamReliabilityEvent("responseLimitExceeded");
      throw new UpstreamReliabilityError(
        "RESPONSE_TOO_LARGE",
        `Upstream response exceeds ${maximumBytes} bytes.`,
      );
    }
  }

  if (!response.body) return { text: "", byteLength: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        recordUpstreamReliabilityEvent("responseLimitExceeded");
        throw new UpstreamReliabilityError(
          "RESPONSE_TOO_LARGE",
          `Upstream response exceeds ${maximumBytes} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), byteLength };
}

export function assertRowCount(
  actual: number,
  maximum: number,
  context: string,
): void {
  positiveInteger(maximum, "maximum");
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
    recordUpstreamReliabilityEvent("rowLimitExceeded");
    throw new UpstreamReliabilityError(
      "ROW_LIMIT_EXCEEDED",
      `${context} exceeds the ${maximum}-row safety limit.`,
    );
  }
}

export function assertJsonWithinLimits(
  value: unknown,
  options: {
    maximumArrayLength: number;
    maximumDepth?: number;
    maximumNodes?: number;
    maximumObjectKeys?: number;
  },
): void {
  const maximumArrayLength = positiveInteger(
    options.maximumArrayLength,
    "maximumArrayLength",
  );
  const maximumDepth = positiveInteger(options.maximumDepth ?? 32, "maximumDepth");
  const maximumNodes = positiveInteger(options.maximumNodes ?? 500_000, "maximumNodes");
  const maximumObjectKeys = positiveInteger(
    options.maximumObjectKeys ?? 1_000,
    "maximumObjectKeys",
  );
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > maximumNodes || current.depth > maximumDepth) {
      recordUpstreamReliabilityEvent("rowLimitExceeded");
      throw new UpstreamReliabilityError(
        "ROW_LIMIT_EXCEEDED",
        "Upstream JSON exceeds structural safety limits.",
      );
    }
    if (Array.isArray(current.value)) {
      assertRowCount(current.value.length, maximumArrayLength, "Upstream JSON array");
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === "object") {
      const entries = Object.values(current.value as Record<string, unknown>);
      if (entries.length > maximumObjectKeys) {
        recordUpstreamReliabilityEvent("rowLimitExceeded");
        throw new UpstreamReliabilityError(
          "ROW_LIMIT_EXCEEDED",
          "Upstream JSON object exceeds the key-count safety limit.",
        );
      }
      for (const item of entries) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  weight: number;
}

export class BoundedTtlLru<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private totalWeight = 0;

  constructor(
    private readonly maximumEntries: number,
    private readonly maximumWeight: number,
  ) {
    positiveInteger(maximumEntries, "maximumEntries");
    positiveInteger(maximumWeight, "maximumWeight");
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }

  get(key: K, nowMs = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      recordUpstreamReliabilityEvent("cacheMiss");
      return undefined;
    }
    if (entry.expiresAt <= nowMs) {
      this.delete(key);
      recordUpstreamReliabilityEvent("cacheMiss");
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    recordUpstreamReliabilityEvent("cacheHit");
    return entry.value;
  }

  set(
    key: K,
    value: V,
    options: { ttlMs: number; weight: number; nowMs?: number },
  ): void {
    const nowMs = options.nowMs ?? Date.now();
    if (
      !Number.isFinite(options.ttlMs) ||
      options.ttlMs <= 0 ||
      !Number.isSafeInteger(options.weight) ||
      options.weight < 0 ||
      options.weight > this.maximumWeight
    ) {
      return;
    }
    this.purgeExpired(nowMs);
    this.delete(key);
    while (
      this.entries.size >= this.maximumEntries ||
      this.totalWeight + options.weight > this.maximumWeight
    ) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
      recordUpstreamReliabilityEvent("cacheEviction");
    }
    this.entries.set(key, {
      value,
      expiresAt: nowMs + options.ttlMs,
      weight: options.weight,
    });
    this.totalWeight += options.weight;
  }

  purgeExpired(nowMs = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class BoundedSemaphore {
  private active = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(
    readonly maximumConcurrency: number,
    readonly maximumQueue: number,
    readonly retryAfterMs = 1_000,
  ) {
    positiveInteger(maximumConcurrency, "maximumConcurrency");
    positiveInteger(maximumQueue, "maximumQueue");
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  snapshot(): {
    active: number;
    queued: number;
    maximumConcurrency: number;
    maximumQueue: number;
  } {
    return {
      active: this.active,
      queued: this.queue.length,
      maximumConcurrency: this.maximumConcurrency,
      maximumQueue: this.maximumQueue,
    };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(
        new UpstreamReliabilityError("ABORTED", "Upstream work was aborted.", {
          cause: signal.reason,
        }),
      );
    }
    if (this.active < this.maximumConcurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    if (this.queue.length >= this.maximumQueue) {
      recordUpstreamReliabilityEvent("backpressureRejected");
      return Promise.reject(
        new UpstreamReliabilityError(
          "BACKPRESSURE",
          "Upstream work queue is full.",
          { retryAfterMs: this.retryAfterMs },
        ),
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(
          new UpstreamReliabilityError("ABORTED", "Queued upstream work was aborted.", {
            cause: signal?.reason,
          }),
        );
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.maximumConcurrency && this.queue.length > 0) {
      const waiter = this.queue.shift() as SemaphoreWaiter;
      waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
      if (waiter.signal?.aborted) {
        waiter.reject(
          new UpstreamReliabilityError("ABORTED", "Queued upstream work was aborted.", {
            cause: waiter.signal.reason,
          }),
        );
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}

export const globalUpstreamSemaphore = new BoundedSemaphore(8, 32);

export function getUpstreamReliabilitySnapshot(): {
  counters: Readonly<Record<UpstreamReliabilityEvent, number>>;
  semaphore: ReturnType<BoundedSemaphore["snapshot"]>;
} {
  return {
    counters: { ...reliabilityCounters },
    semaphore: globalUpstreamSemaphore.snapshot(),
  };
}
