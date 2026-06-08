import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";

export interface TeleCodexConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  hostLabel: string;
  hostName: string;
  userName: string;
  workspace: string;
  workspaceRoot?: string;
  stateDir: string;
  maxFileSize: number;
  codexApiKey?: string;
  codexModel?: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  toolVerbosity: ToolVerbosity;
  showTurnTokenUsage: boolean;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  telegramApiTimeoutMs: number;
  telegramEditDebounceMs: number;
  telegramTypingIntervalMs: number;
  codexNoOutputStatusMs: number;
  codexTurnHardTimeoutMs: number;
  vscHandoffDirectResumeMaxSessionBytes: number;
}

export function loadConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"), {
    overrideKeys: new Set(["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"]),
  });

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const hostName = os.hostname();
  const userName = os.userInfo().username;
  const hostLabel = optionalString(process.env.TELECODEX_HOST_LABEL) ?? `${hostName}\\${userName}`;
  const workspaceRoot = resolveWorkspaceRoot();
  const workspace = resolveWorkspace(workspaceRoot);
  const stateDir = resolveStateDir();
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const enableTelegramLogin = parseBooleanEnv(optionalString(process.env.ENABLE_TELEGRAM_LOGIN), true);
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const telegramApiTimeoutMs = parsePositiveIntegerEnv(
    optionalString(process.env.TELEGRAM_API_TIMEOUT_MS),
    20_000,
    "TELEGRAM_API_TIMEOUT_MS",
  );
  const telegramEditDebounceMs = parsePositiveIntegerEnv(
    optionalString(process.env.TELEGRAM_EDIT_DEBOUNCE_MS),
    5_000,
    "TELEGRAM_EDIT_DEBOUNCE_MS",
  );
  const telegramTypingIntervalMs = parsePositiveIntegerEnv(
    optionalString(process.env.TELEGRAM_TYPING_INTERVAL_MS),
    30_000,
    "TELEGRAM_TYPING_INTERVAL_MS",
  );
  const codexNoOutputStatusMs = parsePositiveIntegerEnv(
    optionalString(process.env.CODEX_NO_OUTPUT_STATUS_MS),
    5 * 60_000,
    "CODEX_NO_OUTPUT_STATUS_MS",
  );
  const codexTurnHardTimeoutMs = parsePositiveIntegerEnv(
    optionalString(process.env.CODEX_TURN_HARD_TIMEOUT_MS),
    60 * 60_000,
    "CODEX_TURN_HARD_TIMEOUT_MS",
  );
  const vscHandoffDirectResumeMaxSessionBytes = parsePositiveIntegerEnv(
    optionalString(process.env.TELECODEX_VSC_HANDOFF_DIRECT_RESUME_MAX_SESSION_BYTES),
    20 * 1024 * 1024,
    "TELECODEX_VSC_HANDOFF_DIRECT_RESUME_MAX_SESSION_BYTES",
  );

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    hostLabel,
    hostName,
    userName,
    workspace,
    workspaceRoot,
    stateDir,
    maxFileSize,
    codexApiKey,
    codexModel,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    toolVerbosity,
    showTurnTokenUsage,
    enableTelegramLogin,
    enableTelegramReactions,
    telegramApiTimeoutMs,
    telegramEditDebounceMs,
    telegramTypingIntervalMs,
    codexNoOutputStatusMs,
    codexTurnHardTimeoutMs,
    vscHandoffDirectResumeMaxSessionBytes,
  };
}

/**
 * Optional workspace root used to discover candidate project directories.
 * Outside Docker this can point to the shared parent workspace folder.
 */
function resolveWorkspaceRoot(): string | undefined {
  const raw = optionalString(process.env.TELECODEX_WORKSPACE_ROOT);
  if (!raw) {
    return isRunningInDocker() ? "/workspace" : undefined;
  }
  return path.resolve(raw);
}

/**
 * Default workspace for first-turn messages before the user picks a different one.
 */
function resolveWorkspace(workspaceRoot?: string): string {
  const raw = optionalString(process.env.TELECODEX_DEFAULT_WORKSPACE);
  if (raw) {
    return path.resolve(raw);
  }

  if (isRunningInDocker()) {
    return "/workspace";
  }

  if (workspaceRoot) {
    return workspaceRoot;
  }

  return process.cwd();
}

function resolveStateDir(): string {
  const raw = optionalString(process.env.TELECODEX_STATE_DIR);
  if (raw) {
    return path.resolve(raw);
  }
  return path.resolve(process.cwd(), ".telecodex");
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string, options: { overrideKeys?: Set<string> } = {}): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || (process.env[key] !== undefined && !options.overrideKeys?.has(key))) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parsePositiveIntegerEnv(raw: string | undefined, defaultValue: number, name: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}
