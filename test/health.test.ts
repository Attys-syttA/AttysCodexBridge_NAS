import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";
import { createRuntimeHealthMonitor } from "../src/health.js";

describe("RuntimeHealthMonitor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-health-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createConfig = (): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    hostLabel: "test-host",
    hostName: "test-machine",
    userName: "tester",
    workspace: tempDir,
    workspaceRoot: undefined,
    stateDir: path.join(tempDir, ".telecodex"),
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "o3",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [createDefaultLaunchProfile("workspace-write", "never")],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    telegramApiTimeoutMs: 20_000,
    telegramEditDebounceMs: 5_000,
    telegramTypingIntervalMs: 30_000,
    codexNoOutputStatusMs: 5 * 60_000,
    codexTurnHardTimeoutMs: 60 * 60_000,
  });

  it("writes health, pid, process events, and Codex checkpoint files", () => {
    const monitor = createRuntimeHealthMonitor(createConfig());

    monitor.markStarted();
    monitor.startRequest({ id: "request-1", contextKey: "chat:1", chatId: "1" });
    monitor.markRequestStreaming("request-1");
    monitor.markRequestOutput("request-1");
    monitor.markOutboundTelegramMessage("request-1");
    monitor.markTelegramEdit("request-1");

    const stateDir = path.join(tempDir, ".telecodex");
    const health = JSON.parse(readFileSync(path.join(stateDir, "health.json"), "utf8"));
    const pid = readFileSync(path.join(stateDir, "bot.pid"), "utf8").trim();
    const events = readFileSync(path.join(stateDir, "process-events.jsonl"), "utf8");
    const checkpoint = JSON.parse(readFileSync(path.join(stateDir, "codex-session.json"), "utf8"));

    expect(health.status).toBe("running");
    expect(health.host).toEqual({ label: "test-host", name: "test-machine", user: "tester" });
    expect(health.activeRequest.id).toBe("request-1");
    expect(pid).toBe(String(process.pid));
    expect(events).toContain('"type":"started"');
    expect(events).toContain('"type":"request_started"');
    expect(events).toContain('"type":"codex_stream_started"');
    expect(checkpoint.status).toBe("streaming");
    expect(checkpoint.activeRequest.id).toBe("request-1");
  });

  it("records timeout and clears the active request when finished", () => {
    const monitor = createRuntimeHealthMonitor(createConfig());

    monitor.markStarted();
    monitor.startRequest({ id: "request-1", contextKey: "chat:1", chatId: "1" });
    monitor.markRequestTimeout("request-1", 1000);
    monitor.finishRequest("request-1");

    const stateDir = path.join(tempDir, ".telecodex");
    const health = JSON.parse(readFileSync(path.join(stateDir, "health.json"), "utf8"));
    const events = readFileSync(path.join(stateDir, "process-events.jsonl"), "utf8");
    const checkpoint = JSON.parse(readFileSync(path.join(stateDir, "codex-session.json"), "utf8"));

    expect(health.activeRequest).toBeUndefined();
    expect(events).toContain('"type":"request_timeout"');
    expect(checkpoint.status).toBe("idle");
  });
});
