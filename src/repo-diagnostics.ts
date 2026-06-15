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

export type GitPushCapabilityStatus = "unknown" | "available" | "blocked" | "degraded";

export interface GitRemoteSummary {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface GitPushCapability {
  status: GitPushCapabilityStatus;
  reason: string;
  remoteName?: string;
  remoteUrl?: string;
  branch?: string;
  targetBranch?: string;
}

export interface GitPushResult {
  remoteName: string;
  remoteUrl?: string;
  branch: string;
  targetBranch: string;
  output: string;
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

export async function probeGitPushCapability(workspace: string): Promise<GitPushCapability> {
  const status = await getGitStatus(workspace);
  if (!status.isRepo || !status.repoRoot) {
    return {
      status: "blocked",
      reason: "Az aktív workspace nem git repo.",
    };
  }

  if (!status.branch || status.branch === "(detached)") {
    return {
      status: "blocked",
      reason: "A repo detached HEAD állapotban van, nincs pusholható branch.",
      branch: status.branch,
    };
  }

  const remotes = await getGitRemotes(status.repoRoot);
  const target = resolvePushTarget(status, remotes);
  if (!target) {
    return {
      status: "blocked",
      reason: "Nincs használható git remote vagy upstream beállítás.",
      branch: status.branch,
    };
  }

  try {
    await git(status.repoRoot, ["ls-remote", "--exit-code", target.remote.name, "HEAD"]);
  } catch (error) {
    return {
      status: "blocked",
      reason: classifyGitPublishFailure(formatError(error)),
      remoteName: target.remote.name,
      remoteUrl: target.remote.pushUrl ?? target.remote.fetchUrl,
      branch: status.branch,
      targetBranch: target.targetBranch,
    };
  }

  if (status.behind > 0) {
    return {
      status: "degraded",
      reason: "A helyi branch le van maradva az upstreamhez képest, push előtt szinkron kell.",
      remoteName: target.remote.name,
      remoteUrl: target.remote.pushUrl ?? target.remote.fetchUrl,
      branch: status.branch,
      targetBranch: target.targetBranch,
    };
  }

  try {
    await git(status.repoRoot, [
      "push",
      "--dry-run",
      "--porcelain",
      target.remote.name,
      `HEAD:refs/heads/${target.targetBranch}`,
    ]);
  } catch (error) {
    return {
      status: "degraded",
      reason: classifyGitPublishFailure(formatError(error)),
      remoteName: target.remote.name,
      remoteUrl: target.remote.pushUrl ?? target.remote.fetchUrl,
      branch: status.branch,
      targetBranch: target.targetBranch,
    };
  }

  return {
    status: "available",
    reason: status.ahead > 0
      ? "A remote elérhető, az auth működik, a push útvonal ellenőrizve lett."
      : "A remote elérhető és a push útvonal ellenőrizve lett, de jelenleg nincs még feltétlen küldendő commit.",
    remoteName: target.remote.name,
    remoteUrl: target.remote.pushUrl ?? target.remote.fetchUrl,
    branch: status.branch,
    targetBranch: target.targetBranch,
  };
}

export async function executeGitPush(workspace: string): Promise<GitPushResult> {
  const status = await getGitStatus(workspace);
  if (!status.isRepo || !status.repoRoot) {
    throw new Error("Az aktív workspace nem git repo.");
  }
  if (!status.branch || status.branch === "(detached)") {
    throw new Error("A repo detached HEAD állapotban van, nincs pusholható branch.");
  }

  const remotes = await getGitRemotes(status.repoRoot);
  const target = resolvePushTarget(status, remotes);
  if (!target) {
    throw new Error("Nincs használható git remote vagy upstream beállítás.");
  }

  const output = await git(status.repoRoot, [
    "push",
    "--porcelain",
    target.remote.name,
    `HEAD:refs/heads/${target.targetBranch}`,
  ]);

  return {
    remoteName: target.remote.name,
    remoteUrl: target.remote.pushUrl ?? target.remote.fetchUrl,
    branch: status.branch,
    targetBranch: target.targetBranch,
    output: output.trim(),
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

export function parseGitRemoteList(raw: string): GitRemoteSummary[] {
  const remotes = new Map<string, GitRemoteSummary>();
  const lines = raw.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) {
      continue;
    }

    const [, name, url, kind] = match;
    const current = remotes.get(name) ?? { name };
    if (kind === "fetch") {
      current.fetchUrl = url;
    } else {
      current.pushUrl = url;
    }
    remotes.set(name, current);
  }

  return [...remotes.values()];
}

export function classifyGitPublishFailure(message: string): string {
  const normalized = message.toLowerCase();

  if (
    /failed to connect|could not connect|timed out|could not resolve host|network is unreachable|no route to host/.test(normalized)
  ) {
    return "A git remote hálózaton nem érhető el a worker felől.";
  }

  if (
    /authentication failed|permission denied|403|401|could not read username|repository not found|access denied/.test(normalized)
  ) {
    return "A git hitelesítés hiányzik vagy a remote elutasította.";
  }

  if (
    /non-fast-forward|fetch first|rejected|remote contains work that you do not have locally|updates were rejected/.test(normalized)
  ) {
    return "A remote branch állapota miatt a push most nem biztonságos; előbb szinkronizálni kell.";
  }

  return message.trim() || "A push ellenőrzése sikertelen lett.";
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

export function formatGitPushCapabilityPlain(capability: GitPushCapability): string {
  const parts = [
    `Remote GitHub push: ${capability.status}`,
    capability.reason,
    capability.remoteName ? `Remote: ${capability.remoteName}` : undefined,
    capability.branch ? `Branch: ${capability.branch}` : undefined,
    capability.targetBranch ? `Cél branch: ${capability.targetBranch}` : undefined,
  ];
  return parts.filter((line): line is string => Boolean(line)).join("\n");
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

async function getGitRemotes(repoRoot: string): Promise<GitRemoteSummary[]> {
  try {
    const raw = await git(repoRoot, ["remote", "-v"]);
    return parseGitRemoteList(raw);
  } catch {
    return [];
  }
}

function resolvePushTarget(
  status: GitStatusSummary,
  remotes: GitRemoteSummary[],
): { remote: GitRemoteSummary; targetBranch: string } | undefined {
  if (!status.branch) {
    return undefined;
  }

  if (status.upstream) {
    const slashIndex = status.upstream.indexOf("/");
    if (slashIndex > 0) {
      const remoteName = status.upstream.slice(0, slashIndex);
      const targetBranch = status.upstream.slice(slashIndex + 1);
      const remote = remotes.find((entry) => entry.name === remoteName);
      if (remote && targetBranch) {
        return { remote, targetBranch };
      }
    }
  }

  const origin = remotes.find((entry) => entry.name === "origin");
  if (origin) {
    return { remote: origin, targetBranch: status.branch };
  }

  const first = remotes[0];
  if (first) {
    return { remote: first, targetBranch: status.branch };
  }

  return undefined;
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
