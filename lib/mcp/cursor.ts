import { createHash } from "node:crypto";

import { MopsfinError } from "@/lib/mopsfin/errors";
import type { ResultPageMeta } from "./result-contract";

interface CompanyCursorPayload {
  version: 1;
  tool: string;
  queryHash: string;
  snapshotId: string;
  nextIndex: number;
  pageSize: number;
}

const PREFIX = "mcp1.";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("base64url")
    .slice(0, 32);
}

function failCursor(message: string, reason = "CURSOR_INVALID"): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    reason,
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

function encode(payload: CompanyCursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const checksum = fingerprint(`mopsfin-company-cursor-v1:${body}`);
  return `${PREFIX}${body}.${checksum}`;
}

function decode(cursor: string): CompanyCursorPayload {
  if (!cursor.startsWith(PREFIX) || cursor.length > 1_000) {
    failCursor("cursor 格式錯誤。");
  }
  try {
    const [body, checksum, ...extra] = cursor.slice(PREFIX.length).split(".");
    if (!body || !checksum || extra.length > 0) failCursor("cursor 格式錯誤。");
    if (fingerprint(`mopsfin-company-cursor-v1:${body}`) !== checksum) {
      failCursor("cursor checksum 驗證失敗。");
    }
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<CompanyCursorPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.tool !== "string" ||
      typeof parsed.queryHash !== "string" ||
      typeof parsed.snapshotId !== "string" ||
      !Number.isInteger(parsed.nextIndex) ||
      (parsed.nextIndex as number) < 0 ||
      !Number.isInteger(parsed.pageSize) ||
      (parsed.pageSize as number) < 1
    ) {
      failCursor("cursor 內容格式錯誤。");
    }
    return parsed as CompanyCursorPayload;
  } catch (error) {
    if (error instanceof MopsfinError) throw error;
    failCursor("cursor 無法解析。");
  }
}

export function paginateByCompany<T>(options: {
  tool: string;
  query: unknown;
  snapshotId: string;
  items: T[];
  pageSize?: number;
  cursor?: string;
  maximumPageSize: number;
  legacyUnpaged?: boolean;
}): { items: T[]; page: ResultPageMeta } {
  if (!options.cursor && options.pageSize === undefined && options.legacyUnpaged) {
    return {
      items: options.items,
      page: {
        mode: "none",
        unit: "none",
        limit: null,
        returned: null,
        total: null,
        next: null,
      },
    };
  }

  const queryHash = fingerprint(options.query);
  let start = 0;
  let pageSize = options.pageSize ?? options.maximumPageSize;
  if (options.cursor) {
    const decoded = decode(options.cursor);
    if (decoded.tool !== options.tool || decoded.queryHash !== queryHash) {
      failCursor("cursor 與本次查詢條件不符。");
    }
    if (decoded.snapshotId !== options.snapshotId) {
      failCursor("官方資料快照已變更，請從第一頁重新查詢。", "SNAPSHOT_CHANGED");
    }
    if (options.pageSize !== undefined && options.pageSize !== decoded.pageSize) {
      failCursor("page_size 必須與第一頁相同。");
    }
    start = decoded.nextIndex;
    pageSize = decoded.pageSize;
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > options.maximumPageSize) {
    throw new MopsfinError("INVALID_ARGUMENT", `page_size 必須介於 1 與 ${options.maximumPageSize}。`);
  }
  if (start > options.items.length) failCursor("cursor 位置超出目前資料範圍。");
  const items = options.items.slice(start, start + pageSize);
  const nextIndex = start + items.length;
  const next =
    nextIndex < options.items.length
      ? encode({
          version: 1,
          tool: options.tool,
          queryHash,
          snapshotId: options.snapshotId,
          nextIndex,
          pageSize,
        })
      : null;
  return {
    items,
    page: {
      mode: "cursor",
      unit: "company",
      limit: pageSize,
      returned: items.length,
      total: options.items.length,
      next: next ? { kind: "cursor", cursor: next } : null,
    },
  };
}
