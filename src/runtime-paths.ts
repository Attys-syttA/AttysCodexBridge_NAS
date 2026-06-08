import path from "node:path";

import type { TeleCodexConfig } from "./config.js";

export interface RuntimeTurnPaths {
  turnId: string;
  inboxDir: string;
  outDir: string;
}

export function getRuntimeRoot(config: TeleCodexConfig): string {
  return path.resolve(config.stateDir);
}

export function getRuntimeInboxDir(config: TeleCodexConfig, turnId: string): string {
  return path.join(getRuntimeRoot(config), "inbox", turnId);
}

export function getRuntimeOutDir(config: TeleCodexConfig, turnId: string): string {
  return path.join(getRuntimeRoot(config), "turns", turnId, "out");
}

export function getRuntimeTurnPaths(config: TeleCodexConfig, turnId: string): RuntimeTurnPaths {
  return {
    turnId,
    inboxDir: getRuntimeInboxDir(config, turnId),
    outDir: getRuntimeOutDir(config, turnId),
  };
}

export function getOperatorEventsPath(config: TeleCodexConfig): string {
  return path.join(getRuntimeRoot(config), "operator-events.jsonl");
}

export function getOperatorNotesDir(config: TeleCodexConfig): string {
  return path.join(getRuntimeRoot(config), "operator-notes");
}
