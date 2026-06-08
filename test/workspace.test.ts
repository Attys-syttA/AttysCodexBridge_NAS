import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";
import {
  formatWorkspaceButtonLabel,
  normalizeWorkspaceList,
  normalizeWorkspacePath,
} from "../src/workspace.js";

describe("workspace helpers", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-workspace-"));
    workspaceRoot = path.join(tempDir, "codex_works");
    mkdirSync(path.join(workspaceRoot, "email-header-analyzer"), { recursive: true });
    mkdirSync(path.join(workspaceRoot, "AttysCodexBridge"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createConfig = (): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    hostLabel: "otthon",
    hostName: "test-machine",
    userName: "tester",
    workspace: path.join(workspaceRoot, "AttysCodexBridge"),
    workspaceRoot,
    stateDir: path.join(workspaceRoot, "AttysCodexBridge", ".telecodex"),
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

  it("remaps stale drive-specific workspace paths into the current workspace root", () => {
    const config = createConfig();

    expect(normalizeWorkspacePath(config, "D:\\codex_works\\email_header_analyzer")).toBe(
      path.join(workspaceRoot, "email-header-analyzer"),
    );
  });

  it("deduplicates normalized workspace lists and filters missing paths", () => {
    const config = createConfig();

    expect(
      normalizeWorkspaceList(config, [
        "D:\\codex_works\\email_header_analyzer",
        path.join(workspaceRoot, "email-header-analyzer"),
        "D:\\codex_works\\missing-project",
      ]),
    ).toEqual([path.join(workspaceRoot, "email-header-analyzer")]);
  });

  it("includes the host label in workspace button labels", () => {
    const config = createConfig();

    expect(formatWorkspaceButtonLabel(config, path.join(workspaceRoot, "email-header-analyzer"))).toBe(
      "📁 email-header-analyzer · otthon",
    );
  });
});
