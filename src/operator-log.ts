import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";
import type { CodexSessionInfo } from "./codex-session.js";
import { getOperatorEventsPath, getOperatorNotesDir } from "./runtime-paths.js";

export type OperatorDecision = "read-only" | "commit-created" | "blocked" | "failed" | "noted";

export interface OperatorEvent {
  command: string;
  decision: OperatorDecision;
  workspace?: string;
  threadId?: string | null;
  detail?: Record<string, unknown>;
}

export async function appendOperatorEvent(config: TeleCodexConfig, event: OperatorEvent): Promise<void> {
  const line = JSON.stringify({
    schemaVersion: 1,
    at: new Date().toISOString(),
    host: config.hostLabel,
    command: event.command,
    decision: event.decision,
    ...(event.workspace ? { workspace: event.workspace } : {}),
    ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  });
  await appendJsonLine(getOperatorEventsPath(config), line);
}

export async function appendOperatorNote(
  config: TeleCodexConfig,
  command: string,
  info: CodexSessionInfo,
  detail: Record<string, unknown>,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const dir = getOperatorNotesDir(config);
  const filePath = path.join(dir, `${date}.jsonl`);
  const line = JSON.stringify({
    schemaVersion: 1,
    at: new Date().toISOString(),
    host: config.hostLabel,
    command,
    workspace: info.workspace,
    threadId: info.threadId,
    detail,
  });
  await appendJsonLine(filePath, line);
  return filePath;
}

async function appendJsonLine(filePath: string, line: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    existing = "";
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(filePath, `${existing}${prefix}${line}\n`, "utf8");
}
