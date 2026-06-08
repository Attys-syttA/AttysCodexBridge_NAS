import type { TeleCodexConfig } from "./config.js";
import type { RepoDiagnostics } from "./repo-diagnostics.js";
import { getRuntimeRoot } from "./runtime-paths.js";

export function buildOperatorPolicyPreamble(config: TeleCodexConfig, repo: RepoDiagnostics): string {
  const lines = [
    "Operator policy for this AttysCodexBridge turn:",
    `- Active workspace: ${repo.workspace}`,
    `- Detected git repo: ${repo.git.repoRoot ?? "(none)"}`,
    `- AttysCodexBridge private runtime/state root: ${getRuntimeRoot(config)}`,
    "- Bot runtime data, Telegram session data, watchdog data, restart/stop state, operator-events, uploads, and artifacts must stay under the AttysCodexBridge private runtime/state root.",
    "- Do not write bot lifecycle or Telegram operational details into target repository STATE.md or changelog files.",
    "- If the task changes a concrete target repository and that repository's AGENTS.md requires STATE.md or changelog updates, write only target-repository facts there.",
    "- Before substantial edits, follow the applicable AGENTS.md files for the detected target repository.",
  ];

  if (repo.agentsFiles.length > 0) {
    lines.push("- Applicable AGENTS.md files:");
    for (const file of repo.agentsFiles) {
      lines.push(`  - ${file}`);
    }
  }

  if (repo.workspaceLooksLikeParent) {
    lines.push("- Warning: the active workspace appears to be a parent folder, not a concrete repo. Prefer selecting a concrete project before broad edits.");
  }

  return lines.join("\n");
}
