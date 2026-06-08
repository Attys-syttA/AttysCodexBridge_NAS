import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexSessionFileInfo {
  path: string;
  sizeBytes: number;
}

export function findCodexSessionFile(threadId: string, home = getHomeDir()): CodexSessionFileInfo | undefined {
  if (!threadId || !home) {
    return undefined;
  }

  const sessionsDir = path.join(home, ".codex", "sessions");
  if (!existsSync(sessionsDir)) {
    return undefined;
  }

  const queue = [sessionsDir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.includes(threadId)) {
        try {
          const fileStat = statSync(fullPath);
          return {
            path: fullPath,
            sizeBytes: fileStat.size,
          };
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

function getHomeDir(): string | undefined {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}
