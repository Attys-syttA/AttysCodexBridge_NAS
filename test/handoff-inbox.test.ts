import { describe, expect, it } from "vitest";

import {
  findHandoffInboxRecord,
  parseHandoffInbox,
  removeHandoffInboxRecord,
  upsertHandoffInboxRecord,
} from "../src/handoff-inbox.js";
import type { ContextHandoff } from "../src/session-registry.js";

describe("handoff inbox records", () => {
  const handoff: ContextHandoff = {
    status: "attached",
    workspace: "E:\\codex_works\\AttysCodexBridge",
    threadId: "019ea8c1-1c72-7e71-9a2d-22b970843743",
    sourceHost: "vsc",
    targetHost: "otthon",
    createdAt: "2026-06-08T19:00:00.000Z",
    expiresAt: "2026-06-08T20:00:00.000Z",
  };

  it("parses map-style inbox records", () => {
    const raw = JSON.stringify({
      "111": handoff,
    });

    expect(parseHandoffInbox(raw)).toEqual([{ contextKey: "111", handoff }]);
  });

  it("parses array-style inbox records with nested handoff payloads", () => {
    const raw = JSON.stringify([
      {
        contextKey: "111:22",
        handoff,
      },
    ]);

    expect(parseHandoffInbox(raw)).toEqual([{ contextKey: "111:22", handoff }]);
  });

  it("finds active records and ignores expired records", () => {
    const raw = JSON.stringify({
      "111": handoff,
    });

    expect(findHandoffInboxRecord(raw, "111", Date.parse("2026-06-08T19:30:00.000Z"))).toEqual(handoff);
    expect(findHandoffInboxRecord(raw, "111", Date.parse("2026-06-08T20:00:00.000Z"))).toBeUndefined();
  });

  it("upserts and removes context records without touching other contexts", () => {
    const existing = JSON.stringify({
      "222": {
        ...handoff,
        threadId: "019ea8d0-0000-7000-9000-000000000000",
      },
    });

    const upserted = upsertHandoffInboxRecord(existing, "111", handoff);
    expect(findHandoffInboxRecord(upserted, "111", Date.parse("2026-06-08T19:30:00.000Z"))).toEqual(handoff);
    expect(findHandoffInboxRecord(upserted, "222", Date.parse("2026-06-08T19:30:00.000Z"))).toBeDefined();

    const removed = removeHandoffInboxRecord(upserted, "111");
    expect(findHandoffInboxRecord(removed, "111", Date.parse("2026-06-08T19:30:00.000Z"))).toBeUndefined();
    expect(findHandoffInboxRecord(removed, "222", Date.parse("2026-06-08T19:30:00.000Z"))).toBeDefined();
  });
});
