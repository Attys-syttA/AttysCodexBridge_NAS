import type { Context } from "grammy";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildReplyParameters,
  getDirectResumeWarning,
  renderDirectResumeWarningPlain,
  renderPendingHandoffPlain,
  resolveReplyToMessageId,
  shouldBlockPromptForHandoff,
} from "../src/bot.js";

describe("Telegram reply targeting", () => {
  it("prefers the explicit reply target when provided", () => {
    const ctx = {
      message: { message_id: 11 },
    } as Context;

    expect(resolveReplyToMessageId(ctx, 42)).toBe(42);
  });

  it("uses the inbound message id for normal messages", () => {
    const ctx = {
      message: { message_id: 77 },
    } as Context;

    expect(resolveReplyToMessageId(ctx)).toBe(77);
  });

  it("falls back to callback query message id for button-driven flows", () => {
    const ctx = {
      callbackQuery: {
        message: { message_id: 99 },
      },
    } as Context;

    expect(resolveReplyToMessageId(ctx)).toBe(99);
    expect(buildReplyParameters(99)).toEqual({ message_id: 99 });
    expect(buildReplyParameters(undefined)).toBeUndefined();
  });
});

describe("Telegram handoff prompt guard", () => {
  const baseHandoff = {
    workspace: "/workspace/app",
    threadId: "thread-a",
    sourceHost: "vsc",
    targetHost: "telegram",
    createdAt: "2026-06-08T19:00:00.000Z",
  };

  it("allows prompts when no handoff is pending or the context is attached", () => {
    expect(shouldBlockPromptForHandoff(undefined)).toBe(false);
    expect(shouldBlockPromptForHandoff({ ...baseHandoff, status: "none" })).toBe(false);
    expect(shouldBlockPromptForHandoff({ ...baseHandoff, status: "attached" })).toBe(false);
  });

  it("blocks prompts while inbound or VSC pickup handoff is pending", () => {
    expect(shouldBlockPromptForHandoff({ ...baseHandoff, status: "pending_inbound" })).toBe(true);
    expect(shouldBlockPromptForHandoff({ ...baseHandoff, status: "pending_vsc_pickup" })).toBe(true);
  });

  it("renders attach and new choices for pending handoff", () => {
    const text = renderPendingHandoffPlain({ ...baseHandoff, status: "pending_inbound" });

    expect(text).toContain("/attach thread-a");
    expect(text).toContain("/new");
  });

  it("warns before automatically resuming an oversized VSC handoff thread", () => {
    const originalUserProfile = process.env.USERPROFILE;
    const originalHome = process.env.HOME;
    const home = mkdtempSync(path.join(os.tmpdir(), "telecodex-home-"));
    try {
      delete process.env.HOME;
      process.env.USERPROFILE = home;
      const sessionsDir = path.join(home, ".codex", "sessions", "2026", "06", "08");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(path.join(sessionsDir, "rollout-thread-a.jsonl"), "12345678901", "utf8");

      const warning = getDirectResumeWarning(
        { vscHandoffDirectResumeMaxSessionBytes: 10 },
        { ...baseHandoff, status: "attached" },
      );

      expect(warning).toMatchObject({ sizeBytes: 11, maxBytes: 10 });
      expect(renderDirectResumeWarningPlain({ ...baseHandoff, status: "pending_inbound" }, warning!)).toContain(
        "/attach thread-a",
      );
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
