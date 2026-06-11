import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService, type CodexSessionRuntime } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { RemoteCodexSessionService } from "./remote-session.js";
import { normalizeWorkspacePath } from "./workspace.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  workerId?: string;
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
  private readonly sessions = new Map<TelegramContextKey, CodexSessionRuntime>();
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
  ): Promise<CodexSessionRuntime> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    const normalizedWorkspace = meta?.workspace ? normalizeWorkspacePath(this.config, meta.workspace) : undefined;
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    const createOptions = {
      ...(normalizedWorkspace ? { workspace: normalizedWorkspace } : {}),
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      resumeThreadId: meta?.threadId ?? undefined,
      ...(options?.deferThreadStart && !meta?.threadId ? { deferThreadStart: true } : {}),
    };
    session = await createSessionRuntime(this.config, createOptions, meta?.workerId);

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionRuntime | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionRuntime): void {
    const info = session.getInfo();
    const existing = this.metadata.get(contextKey);
    const workerId =
      "getWorkerTargetId" in session && typeof session.getWorkerTargetId === "function"
        ? session.getWorkerTargetId()
        : undefined;
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      workerId: workerId ?? existing?.workerId,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      ...(existing?.handoff ? { handoff: existing.handoff } : {}),
      updatedAt: Date.now(),
    });
    this.pruneDuplicateThreadMetadata(contextKey);
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
      workerId: existing?.workerId,
      model: handoff.model ?? existing?.model,
      reasoningEffort: existing?.reasoningEffort,
      launchProfileId: existing?.launchProfileId,
      handoff,
      updatedAt: Date.now(),
    });
    this.pruneDuplicateThreadMetadata(contextKey);
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

  setWorker(contextKey: TelegramContextKey, workerId: string): void {
    const existing = this.metadata.get(contextKey);
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);

    this.metadata.set(contextKey, {
      contextKey,
      threadId: null,
      workspace: existing?.workspace ?? "",
      workerId,
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
      launchProfileId: existing?.launchProfileId,
      ...(existing?.handoff ? { handoff: existing.handoff } : {}),
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
      this.pruneDuplicateThreadMetadata();
      this.persistMetadata();
    } catch {
      // Silently ignore load errors.
    }
  }

  private pruneDuplicateThreadMetadata(preferredContextKey?: TelegramContextKey): void {
    const groupedByThread = new Map<string, ContextMetadata[]>();

    for (const metadata of this.metadata.values()) {
      if (!metadata.threadId) {
        continue;
      }

      const grouped = groupedByThread.get(metadata.threadId);
      if (grouped) {
        grouped.push(metadata);
      } else {
        groupedByThread.set(metadata.threadId, [metadata]);
      }
    }

    for (const entries of groupedByThread.values()) {
      if (entries.length < 2) {
        continue;
      }

      const keptEntry = this.pickPreferredMetadata(entries, preferredContextKey);
      for (const entry of entries) {
        if (entry.contextKey === keptEntry.contextKey) {
          continue;
        }

        this.removeContextMetadata(entry.contextKey);
      }
    }
  }

  private pickPreferredMetadata(
    entries: ContextMetadata[],
    preferredContextKey?: TelegramContextKey,
  ): ContextMetadata {
    const preferredEntry = preferredContextKey
      ? entries.find((entry) => entry.contextKey === preferredContextKey)
      : undefined;
    if (preferredEntry) {
      return preferredEntry;
    }

    return [...entries].sort((left, right) => {
      const priorityDelta = this.getMetadataPriority(right) - this.getMetadataPriority(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      const timeDelta = right.updatedAt - left.updatedAt;
      if (timeDelta !== 0) {
        return timeDelta;
      }

      return left.contextKey.localeCompare(right.contextKey);
    })[0];
  }

  private getMetadataPriority(metadata: ContextMetadata): number {
    let priority = 0;

    if (this.sessions.has(metadata.contextKey)) {
      priority += 100;
    }

    switch (metadata.handoff?.status) {
      case "attached":
        priority += 50;
        break;
      case "pending_inbound":
        priority += 20;
        break;
      case "pending_vsc_pickup":
        priority += 10;
        break;
      default:
        break;
    }

    return priority;
  }

  private removeContextMetadata(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
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

async function createSessionRuntime(
  config: TeleCodexConfig,
  options: {
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
    resumeThreadId?: string;
    deferThreadStart?: boolean;
  },
  workerId?: string,
): Promise<CodexSessionRuntime> {
  if (config.runtimeMode === "remote-bridge") {
    return RemoteCodexSessionService.create(config, options, workerId);
  }

  return CodexSessionService.create(config, options);
}
