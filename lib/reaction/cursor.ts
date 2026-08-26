import { createHash } from "node:crypto";

import type { CompanyMarket } from "@/lib/company-master/types";
import { MopsfinError } from "@/lib/mopsfin/errors";

import type { ReactionHorizon } from "./types";

const CURSOR_PREFIX = "reaction1.";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface ReactionCursorPayload {
  version: 1;
  queryHash: string;
  nextIndex: number;
  masterSnapshotId: string;
  masterFingerprint: string;
  rangeStart: string;
  rangeEnd: string;
  resolvedByMarket: Array<{ market: CompanyMarket; date: string }>;
  benchmarkFingerprint: string;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "CURSOR_INVALID",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

export function reactionQueryHash(query: {
  companyCodes: string[];
  asOf: "latest" | string;
  horizons: ReactionHorizon[];
  pageSize: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyCodes: query.companyCodes,
        asOf: query.asOf,
        horizons: [...query.horizons].sort((left, right) => left - right),
        pageSize: query.pageSize,
      }),
    )
    .digest("hex");
}

export function benchmarkFingerprint(
  values: Array<{
    market: CompanyMarket;
    bars: Array<{ date: string; close: number }>;
  }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...values]
          .sort((left, right) => left.market.localeCompare(right.market))
          .map((value) => ({ market: value.market, bars: value.bars })),
      ),
    )
    .digest("hex");
}

export function encodeReactionCursor(payload: ReactionCursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const checksum = createHash("sha256")
    .update(`mopsfin-reaction-cursor-v1:${body}`)
    .digest("base64url")
    .slice(0, 16);
  return `${CURSOR_PREFIX}${body}.${checksum}`;
}

export function decodeReactionCursor(cursor: string): ReactionCursorPayload {
  if (!cursor.startsWith(CURSOR_PREFIX) || cursor.length > 1_000) {
    invalid("cursor 格式錯誤。");
  }
  try {
    const encoded = cursor.slice(CURSOR_PREFIX.length);
    const [body, checksum, ...extra] = encoded.split(".");
    const expected = createHash("sha256")
      .update(`mopsfin-reaction-cursor-v1:${body}`)
      .digest("base64url")
      .slice(0, 16);
    if (!body || !checksum || extra.length > 0 || checksum !== expected) {
      invalid("cursor checksum 驗證失敗。");
    }
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<ReactionCursorPayload>;
    const resolved = parsed.resolvedByMarket;
    if (
      parsed.version !== 1 ||
      typeof parsed.queryHash !== "string" ||
      !SHA256_HEX.test(parsed.queryHash) ||
      !Number.isSafeInteger(parsed.nextIndex) ||
      (parsed.nextIndex ?? 0) < 1 ||
      typeof parsed.masterSnapshotId !== "string" ||
      parsed.masterSnapshotId.length < 1 ||
      typeof parsed.masterFingerprint !== "string" ||
      !SHA256_HEX.test(parsed.masterFingerprint) ||
      typeof parsed.rangeStart !== "string" ||
      !ISO_DATE.test(parsed.rangeStart) ||
      typeof parsed.rangeEnd !== "string" ||
      !ISO_DATE.test(parsed.rangeEnd) ||
      parsed.rangeStart > parsed.rangeEnd ||
      !Array.isArray(resolved) ||
      resolved.length < 1 ||
      resolved.length > 2 ||
      resolved.some(
        (item) =>
          !item ||
          (item.market !== "listed" && item.market !== "otc") ||
          typeof item.date !== "string" ||
          !ISO_DATE.test(item.date),
      ) ||
      new Set(resolved.map((item) => item.market)).size !== resolved.length ||
      typeof parsed.benchmarkFingerprint !== "string" ||
      !SHA256_HEX.test(parsed.benchmarkFingerprint)
    ) {
      invalid("cursor 內容格式錯誤。");
    }
    return parsed as ReactionCursorPayload;
  } catch (error) {
    if (error instanceof MopsfinError) throw error;
    invalid("cursor 無法解析。");
  }
}
