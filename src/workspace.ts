import { existsSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";

export function normalizeWorkspacePath(config: TeleCodexConfig, workspace: string | undefined): string {
  const raw = workspace?.trim();
  if (!raw) {
    return config.workspace;
  }

  if (raw.startsWith("/")) {
    return raw;
  }

  const resolved = isWindowsDrivePath(raw) || path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
  if (existsSync(resolved)) {
    return resolved;
  }

  const remapped = isWindowsDrivePath(raw) ? remapIntoWorkspaceRoot(config.workspaceRoot, resolved) : null;
  return remapped ?? resolved;
}

export function normalizeWorkspaceList(config: TeleCodexConfig, workspaces: string[]): string[] {
  const normalized = workspaces
    .filter(Boolean)
    .map((workspace) => normalizeWorkspacePath(config, workspace))
    .filter((workspace) => workspace.startsWith("/") || existsSync(workspace));

  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

export function formatWorkspaceButtonLabel(
  config: TeleCodexConfig,
  workspace: string,
  options?: { current?: boolean },
): string {
  const icon = options?.current ? "📂" : "📁";
  return `${icon} ${getWorkspaceShortName(workspace)} · ${config.hostLabel}`;
}

export function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function remapIntoWorkspaceRoot(workspaceRoot: string | undefined, workspace: string): string | null {
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return null;
  }

  const leaf = path.basename(workspace);
  const candidates = [
    path.join(workspaceRoot, leaf),
    path.join(workspaceRoot, leaf.replaceAll("_", "-")),
    path.join(workspaceRoot, leaf.replaceAll("-", "_")),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isWindowsDrivePath(workspace: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(workspace);
}
