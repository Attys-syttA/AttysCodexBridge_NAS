import { formatCapabilityMode } from "./codex-launch.js";
import type { CodexPromptInput, CodexSessionInfo } from "./codex-session.js";

export function promptLikelyNeedsGithubWrite(input: CodexPromptInput): boolean {
  const text = typeof input === "string"
    ? input
    : [input.policyPreamble, input.stagedFileInstructions, input.text].filter(Boolean).join("\n");
  const normalized = text.toLowerCase();

  return [
    "git push",
    "push to github",
    "push the branch",
    "push branch",
    "open a pr",
    "create a pr",
    "pull request",
    "gh pr create",
    "github pr",
  ].some((needle) => normalized.includes(needle));
}

export function formatCapabilitySummary(info: Pick<CodexSessionInfo, "capabilityMode" | "githubWriteEnabled">): string {
  return `${formatCapabilityMode(info.capabilityMode as "safe" | "github-write")}${info.githubWriteEnabled ? " [github-write]" : ""}`;
}
