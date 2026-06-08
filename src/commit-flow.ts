import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { GitStatusSummary } from "./repo-diagnostics.js";

const execFileAsync = promisify(execFile);

export interface CheckResult {
  name: string;
  status: "passed" | "skipped" | "failed";
  detail: string;
}

export interface CommitCheckResult {
  ok: boolean;
  checks: CheckResult[];
}

export function suggestCommitMessage(status: GitStatusSummary): string {
  const files = status.changedFiles;
  if (files.some((file) => file.includes("bot") || file.includes("operator") || file.includes("runtime"))) {
    return "Update bot operator workflow";
  }
  if (files.some((file) => file.startsWith("docs/") || file.toLowerCase().includes("readme"))) {
    return "Update documentation";
  }
  if (files.some((file) => file.startsWith("test/"))) {
    return "Update tests";
  }
  return "Update project state";
}

export async function runCommitChecks(repoRoot: string): Promise<CommitCheckResult> {
  const checks: CheckResult[] = [];
  const packageScripts = readPackageScripts(repoRoot);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  if (packageScripts.has("build")) {
    checks.push(await runCheck("npm run build", repoRoot, npmCommand, ["run", "build"]));
  } else {
    checks.push({ name: "npm run build", status: "skipped", detail: "missing package script" });
  }

  if (packageScripts.has("test")) {
    checks.push(await runCheck("npm test", repoRoot, npmCommand, ["test"]));
  } else {
    checks.push({ name: "npm test", status: "skipped", detail: "missing package script" });
  }

  checks.push(await runCheck("git diff --check", repoRoot, "git", ["diff", "--check"]));
  checks.push(await runCheck("ggshield secret scan repo .", repoRoot, "ggshield", ["secret", "scan", "repo", "."]));

  return {
    ok: checks.every((check) => check.status !== "failed"),
    checks,
  };
}

export async function createCommit(repoRoot: string, message: string, files: string[]): Promise<string> {
  await run(repoRoot, "git", ["add", "-A", "--", ...files]);
  await run(repoRoot, "git", ["commit", "-m", message]);
  return (await run(repoRoot, "git", ["log", "-1", "--oneline"])).trim();
}

async function runCheck(name: string, cwd: string, command: string, args: string[]): Promise<CheckResult> {
  try {
    const output = await run(cwd, command, args);
    return { name, status: "passed", detail: summarizeOutput(output) || "OK" };
  } catch (error) {
    return { name, status: "failed", detail: summarizeOutput(formatError(error)) };
  }
}

async function run(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return [stdout, stderr].filter(Boolean).join("\n");
}

function readPackageScripts(repoRoot: string): Set<string> {
  const packagePath = path.join(repoRoot, "package.json");
  if (!existsSync(packagePath)) {
    return new Set();
  }

  try {
    const data = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    return new Set(Object.keys(data.scripts ?? {}));
  } catch {
    return new Set();
  }
}

function summarizeOutput(output: string): string {
  const cleaned = output.replace(/\r/g, "").trim();
  if (cleaned.length <= 800) {
    return cleaned;
  }
  return `${cleaned.slice(0, 760)}\n...`;
}

function formatError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      return stderr;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
