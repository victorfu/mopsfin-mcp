import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeReactionCursor,
  encodeReactionCursor,
  type ReactionCursorPayload,
} from "@/lib/reaction/cursor";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function payload(
  overrides: Partial<ReactionCursorPayload> = {},
): ReactionCursorPayload {
  return {
    version: 3,
    queryHash: HASH_A,
    nextIndex: 10,
    masterSnapshotId: "master-snapshot",
    masterFingerprint: HASH_B,
    rangeStart: "2026-01-01",
    rangeEnd: "2026-06-30",
    resolvedByMarket: [
      { market: "listed", date: "2026-06-30" },
      { market: "otc", date: "2026-06-30" },
    ],
    completedSessionFingerprint: HASH_D,
    benchmarkFingerprint: HASH_C,
    corporateActionFingerprint: createHash("sha256")
      .update("corporate-actions")
      .digest("hex"),
    ...overrides,
  };
}

function legacyV2Cursor(): string {
  const { completedSessionFingerprint: _completedSessionFingerprint, ...value } =
    payload();
  const body = Buffer.from(
    JSON.stringify({ ...value, version: 2 }),
  ).toString("base64url");
  const checksum = createHash("sha256")
    .update(`mopsfin-reaction-cursor-v2:${body}`)
    .digest("base64url")
    .slice(0, 16);
  return `reaction2.${body}.${checksum}`;
}

function legacyV1Cursor(): string {
  const body = Buffer.from(
    JSON.stringify({
      ...payload(),
      version: 1,
      corporateActionFingerprint: undefined,
    }),
  ).toString("base64url");
  const checksum = createHash("sha256")
    .update(`mopsfin-reaction-cursor-v1:${body}`)
    .digest("base64url")
    .slice(0, 16);
  return `reaction1.${body}.${checksum}`;
}

describe("reaction cursor v3", () => {
  it("round-trips a v3 payload including completed-session and corporate-action fingerprints", () => {
    const value = payload();
    const cursor = encodeReactionCursor(value);

    expect(cursor).toMatch(/^reaction3\./);
    expect(decodeReactionCursor(cursor)).toEqual(value);
  });

  it("rejects missing or malformed corporate-action fingerprints", () => {
    for (const corporateActionFingerprint of ["", "A".repeat(64), "f".repeat(63)]) {
      const cursor = encodeReactionCursor(
        payload({ corporateActionFingerprint }),
      );
      expect(() => decodeReactionCursor(cursor)).toThrowError(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          reason: "CURSOR_INVALID",
          action: "restart_pagination",
        }),
      );
    }
  });

  it("rejects missing or malformed completed-session fingerprints", () => {
    for (const completedSessionFingerprint of [
      undefined,
      "",
      "A".repeat(64),
      "f".repeat(63),
    ]) {
      const cursor = encodeReactionCursor(
        payload({
          completedSessionFingerprint:
            completedSessionFingerprint as string,
        }),
      );
      expect(() => decodeReactionCursor(cursor)).toThrowError(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          reason: "CURSOR_INVALID",
          action: "restart_pagination",
        }),
      );
    }
    expect(
      decodeReactionCursor(
        encodeReactionCursor(payload({ completedSessionFingerprint: null })),
      ).completedSessionFingerprint,
    ).toBeNull();
  });

  it("rejects checksum tampering", () => {
    const cursor = encodeReactionCursor(payload());
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;

    expect(() => decodeReactionCursor(tampered)).toThrowError(
      expect.objectContaining({ reason: "CURSOR_INVALID" }),
    );
  });

  it("explicitly rejects a correctly checksummed legacy v1 cursor", () => {
    expect(() => decodeReactionCursor(legacyV1Cursor())).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        reason: "CURSOR_INVALID",
        category: "pagination",
        action: "restart_pagination",
      }),
    );
  });

  it("explicitly rejects a correctly checksummed legacy v2 cursor", () => {
    expect(() => decodeReactionCursor(legacyV2Cursor())).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        reason: "CURSOR_INVALID",
        category: "pagination",
        action: "restart_pagination",
      }),
    );
  });
});
