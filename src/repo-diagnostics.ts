import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitStatusSummary {
  isRepo: boolean;
  workspace: string;
  repoRoot?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: string[];
  lastCommit?: string;
  error?: string;
}

export interface RepoDiagnostics {
  workspace: string;
  git: GitStatusSummary;
  agentsFiles: string[];
  workspaceLooksLikeParent: boolean;
}

export function normalizeLocalPathForCompare(value: string): string {
  let normalized = value.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  normalized = normalized.replace(/^\\\\\?\\/i, "");
  return path.resolve(normalized).toLowerCase();
}

export async function inspectRepo(workspace: string, workspaceRoot?: string): Promise<RepoDiagnostics> {
  const git = await getGitStatus(workspace);
  const agentsBase = git.repoRoot ?? workspace;
  return {
    workspace,
    git,
    agentsFiles: findAgentsFiles(agentsBase, workspaceRoot),
    workspaceLooksLikeParent: isWorkspaceParent(workspace, workspaceRoot, git.repoRoot),
  };
}

export async function getGitStatus(workspace: string): Promise<GitStatusSummary> {
  const base: GitStatusSummary = {
    isRepo: false,
    workspace,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  };

  try {
    const repoRootRaw = await git(workspace, ["rev-parse", "--show-toplevel"]);
    const repoRoot = normalizeGitPath(repoRootRaw.trim());
    const branch = (await git(repoRoot, ["branch", "--show-current"])).trim() || "(detached)";
    const statusRaw = await git(repoRoot, ["status", "--porcelain=v1", "--branch"]);
    const parsed = parseGitPorcelainStatus(statusRaw);
    const lastCommit = (await git(repoRoot, ["log", "-1", "--oneline"])).trim();

    return {
      ...base,
      isRepo: true,
      repoRoot,
      branch: parsed.branch ?? branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      dirty: parsed.changedFiles.length > 0,
      changedFiles: parsed.changedFiles,
      lastCommit,
    };
  } catch (error) {
    return {
      ...base,
      error: formatError(error),
    };
  }
}

export function parseGitPorcelainStatus(raw: string): {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changedFiles: string[];
} {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const result = {
    branch: undefined as string | undefined,
    upstream: undefined as string | undefined,
    ahead: 0,
    behind: 0,
    changedFiles: [] as string[],
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      const [left, trackingRaw] = header.split("...");
      result.branch = left?.trim() || undefined;
      if (trackingRaw) {
        const tracking = trackingRaw.trim();
        const match = tracking.match(/^([^\s]+)(?:\s+\[(.+)\])?$/);
        result.upstream = match?.[1];
        const flags = match?.[2] ?? "";
        const ahead = flags.match(/ahead\s+(\d+)/);
        const behind = flags.match(/behind\s+(\d+)/);
        result.ahead = ahead ? Number.parseInt(ahead[1] ?? "0", 10) : 0;
        result.behind = behind ? Number.parseInt(behind[1] ?? "0", 10) : 0;
      }
      continue;
    }

    if (line.length >= 4) {
      result.changedFiles.push(line.slice(3).trim());
    }
  }

  return result;
}

export function findAgentsFiles(startPath: string, workspaceRoot?: string): string[] {
  const files: string[] = [];
  let current = path.resolve(stripExtendedLengthPrefix(startPath));
  const stopAt = workspaceRoot ? path.resolve(stripExtendedLengthPrefix(workspaceRoot)) : path.parse(current).root;

  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (existsSync(candidate)) {
      files.unshift(candidate);
    }

    if (samePath(current, stopAt)) {
      break;
    }

    const parent = path.dirname(current);
    if (samePath(parent, current)) {
      break;
    }
    current = parent;
  }

  return files;
}

export function formatGitStatusPlain(status: GitStatusSummary): string {
  if (!status.isRepo) {
    return `Git repo: nincs (${status.error ?? "nem git munkamappa"})`;
  }

  const sync = status.upstream
    ? `${status.upstream}, ahead ${status.ahead}, behind ${status.behind}`
    : "nincs upstream";
  return [
    `Repo: ${status.repoRoot}`,
    `Branch: ${status.branch ?? "(ismeretlen)"}`,
    `Állapot: ${status.dirty ? "módosított" : "clean"}`,
    `Szinkron: ${sync}`,
    `Utolsó commit: ${status.lastCommit ?? "(nincs)"}`,
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function normalizeGitPath(value: string): string {
  return path.resolve(stripExtendedLengthPrefix(value));
}

function isWorkspaceParent(workspace: string, workspaceRoot: string | undefined, repoRoot: string | undefined): boolean {
  const resolvedWorkspace = stripExtendedLengthPrefix(workspace);
  if (workspaceRoot && samePath(resolvedWorkspace, workspaceRoot)) {
    return true;
  }
  return Boolean(repoRoot && samePath(resolvedWorkspace, path.dirname(stripExtendedLengthPrefix(repoRoot))));
}

function samePath(left: string, right: string): boolean {
  return normalizeLocalPathForCompare(left) === normalizeLocalPathForCompare(right);
}

function stripExtendedLengthPrefix(value: string): string {
  return value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
