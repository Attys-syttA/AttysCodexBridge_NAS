import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { TeleCodexConfig } from "../src/config.js";
import { clearBotControlRequest, writeBotControlRequest } from "../src/process-control.js";

describe("process-control", () => {
  it("writes a restart request without a stop expiry", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "telecodex-control-"));
    try {
      const config = { stateDir, hostLabel: "test-host" } as TeleCodexConfig;
      const now = new Date("2026-06-08T10:00:00.000Z");

      const request = await writeBotControlRequest(config, "restart", "Tester (1)", now);
      const raw = await readFile(path.join(stateDir, "restart-request.json"), "utf8");
      const saved = JSON.parse(raw) as typeof request;

      expect(saved.action).toBe("restart");
      expect(saved.requestedAt).toBe("2026-06-08T10:00:00.000Z");
      expect(saved.requestedBy).toBe("Tester (1)");
      expect(saved.hostLabel).toBe("test-host");
      expect(saved.expiresAt).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes a stop request with an expiry for the watchdog", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "telecodex-control-"));
    try {
      const config = { stateDir, hostLabel: "test-host" } as TeleCodexConfig;
      const now = new Date("2026-06-08T10:00:00.000Z");

      const request = await writeBotControlRequest(config, "stop", undefined, now);
      const raw = await readFile(path.join(stateDir, "stop-request.json"), "utf8");
      const saved = JSON.parse(raw) as typeof request;

      expect(saved.action).toBe("stop");
      expect(saved.expiresAt).toBe("2026-06-08T10:15:00.000Z");
      expect(saved.pid).toBe(process.pid);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("clears stale control requests", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "telecodex-control-"));
    try {
      const config = { stateDir, hostLabel: "test-host" } as TeleCodexConfig;

      await writeBotControlRequest(config, "stop", undefined, new Date("2026-06-08T10:00:00.000Z"));
      await clearBotControlRequest(config, "stop");

      await expect(readFile(path.join(stateDir, "stop-request.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
