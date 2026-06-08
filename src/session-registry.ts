import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { normalizeWorkspacePath } from "./workspace.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  handoff?: ContextHandoff;
  updatedAt: number;
}

export type HandoffStatus = "none" | "pending_inbound" | "attached" | "pending_vsc_pickup";

export interface ContextHandoff {
  status: HandoffStatus;
  workspace: string;
  threadId: string | null;
  model?: string;
  sourceHost?: string;
  targetHost?: string;
  createdAt: string;
  expiresAt?: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = path.join(config.stateDir, "contexts.json");
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    const normalizedWorkspace = normalizeWorkspacePath(this.config, meta?.workspace);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    const createOptions = {
      workspace: normalizedWorkspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      resumeThreadId: meta?.threadId ?? undefined,
      ...(options?.deferThreadStart && !meta?.threadId ? { deferThreadStart: true } : {}),
    };
    session = await CodexSessionService.create(this.config, createOptions);

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
    const info = session.getInfo();
    const existing = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      ...(existing?.handoff ? { handoff: existing.handoff } : {}),
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  getMetadata(contextKey: TelegramContextKey): ContextMetadata | undefined {
    return this.metadata.get(contextKey);
  }

  getHandoff(contextKey: TelegramContextKey): ContextHandoff | undefined {
    return this.metadata.get(contextKey)?.handoff;
  }

  setHandoff(contextKey: TelegramContextKey, handoff: ContextHandoff): void {
    const existing = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: existing?.threadId ?? handoff.threadId,
      workspace: existing?.workspace ?? handoff.workspace,
      model: handoff.model ?? existing?.model,
      reasoningEffort: existing?.reasoningEffort,
      launchProfileId: existing?.launchProfileId,
      handoff,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  clearHandoff(contextKey: TelegramContextKey): void {
    const existing = this.metadata.get(contextKey);
    if (!existing?.handoff) {
      return;
    }

    const { handoff: _handoff, ...next } = existing;
    this.metadata.set(contextKey, {
      ...next,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, {
            ...entry,
            workspace: normalizeWorkspacePath(this.config, entry.workspace),
          });
        }
      }
      this.persistMetadata();
    } catch {
      // Silently ignore load errors.
    }
  }
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
