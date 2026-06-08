import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";

export type HealthEventType =
  | "started"
  | "heartbeat"
  | "request_started"
  | "codex_stream_started"
  | "telegram_send_failed"
  | "telegram_edit_failed"
  | "request_timeout"
  | "abort_requested"
  | "fatal_error"
  | "stopping"
  | "stopped";

export interface ActiveRequestState {
  id: string;
  contextKey: string;
  chatId: string;
  startedAt: string;
  lastActivityAt: string;
  lastOutputAt?: string;
  lastTelegramSendAt?: string;
  lastTelegramEditAt?: string;
  lastTypingAt?: string;
  abortRequestedAt?: string;
  timedOutAt?: string;
  status: "starting" | "streaming" | "waiting" | "aborting" | "timed_out" | "finalizing";
}

export interface BridgeHealth {
  schemaVersion: 1;
  process: {
    pid: number;
    ppid?: number;
    startedAt: string;
    cwd: string;
    node: string;
  };
  host: {
    label: string;
    name: string;
    user: string;
  };
  updatedAt: string;
  status: "starting" | "running" | "stopping" | "stopped" | "fatal";
  lastInboundTelegramUpdateAt?: string;
  lastOutboundTelegramMessageAt?: string;
  lastTelegramEditAt?: string;
  lastTypingAt?: string;
  lastError?: {
    at: string;
    type: string;
    message: string;
  };
  activeRequest?: ActiveRequestState;
}

export interface HealthEvent {
  at: string;
  type: HealthEventType;
  pid: number;
  detail?: Record<string, unknown>;
}

export class RuntimeHealthMonitor {
  private readonly healthPath: string;
  private readonly pidPath: string;
  private readonly eventPath: string;
  private readonly checkpointPath: string;
  private health: BridgeHealth;

  constructor(config: TeleCodexConfig) {
    this.healthPath = path.join(config.stateDir, "health.json");
    this.pidPath = path.join(config.stateDir, "bot.pid");
    this.eventPath = path.join(config.stateDir, "process-events.jsonl");
    this.checkpointPath = path.join(config.stateDir, "codex-session.json");
    this.health = {
      schemaVersion: 1,
      process: {
        pid: process.pid,
        ppid: process.ppid,
        startedAt: new Date().toISOString(),
        cwd: process.cwd(),
        node: process.version,
      },
      host: {
        label: config.hostLabel,
        name: config.hostName,
        user: config.userName,
      },
      updatedAt: new Date().toISOString(),
      status: "starting",
    };
  }

  markStarted(): void {
    this.patch({ status: "running" });
    this.writePid();
    this.record("started", { cwd: process.cwd(), node: process.version });
  }

  markStopping(signal?: string): void {
    this.patch({ status: "stopping" });
    this.record("stopping", signal ? { signal } : undefined);
  }

  markStopped(exitCode?: number): void {
    this.patch({ status: "stopped", activeRequest: undefined });
    this.record("stopped", exitCode === undefined ? undefined : { exitCode });
  }

  markFatal(error: unknown): void {
    const formatted = formatError(error);
    this.patch({
      status: "fatal",
      lastError: {
        at: new Date().toISOString(),
        type: formatted.type,
        message: formatted.message,
      },
    });
    this.record("fatal_error", formatted);
  }

  markInboundTelegramUpdate(): void {
    this.patch({ lastInboundTelegramUpdateAt: new Date().toISOString() });
  }

  markOutboundTelegramMessage(requestId?: string): void {
    const at = new Date().toISOString();
    this.patchRequest(requestId, { lastTelegramSendAt: at, lastActivityAt: at });
    this.patch({ lastOutboundTelegramMessageAt: at });
  }

  markTelegramEdit(requestId?: string): void {
    const at = new Date().toISOString();
    this.patchRequest(requestId, { lastTelegramEditAt: at, lastActivityAt: at });
    this.patch({ lastTelegramEditAt: at });
  }

  markTyping(requestId?: string): void {
    const at = new Date().toISOString();
    this.patchRequest(requestId, { lastTypingAt: at });
    this.patch({ lastTypingAt: at });
  }

  startRequest(request: Pick<ActiveRequestState, "id" | "contextKey" | "chatId">): void {
    const at = new Date().toISOString();
    this.patch({
      activeRequest: {
        ...request,
        startedAt: at,
        lastActivityAt: at,
        status: "starting",
      },
    });
    this.writeCodexCheckpoint("starting");
    this.record("request_started", request);
  }

  markRequestStreaming(requestId: string): void {
    this.patchRequest(requestId, { status: "streaming" });
    this.writeCodexCheckpoint("streaming");
    this.record("codex_stream_started", { requestId });
  }

  markRequestOutput(requestId: string): void {
    const at = new Date().toISOString();
    this.patchRequest(requestId, { lastOutputAt: at, lastActivityAt: at, status: "streaming" });
    this.writeCodexCheckpoint("streaming");
  }

  markAbortRequested(requestId?: string): void {
    const at = new Date().toISOString();
    this.patchRequest(requestId, { abortRequestedAt: at, status: "aborting", lastActivityAt: at });
    this.writeCodexCheckpoint("aborting");
    this.record("abort_requested", requestId ? { requestId } : undefined);
  }

  markRequestTimeout(requestId: string, timeoutMs: number): void {
    const at = new Date().toISOString();
    this.patchRequest(requestId, { timedOutAt: at, status: "timed_out", lastActivityAt: at });
    this.writeCodexCheckpoint("timed_out");
    this.record("request_timeout", { requestId, timeoutMs });
  }

  finishRequest(requestId: string): void {
    if (this.health.activeRequest?.id === requestId) {
      this.patch({ activeRequest: undefined });
      this.writeCodexCheckpoint("idle");
    }
  }

  markTelegramFailure(type: "telegram_send_failed" | "telegram_edit_failed", error: unknown): void {
    const formatted = formatError(error);
    this.patch({
      lastError: {
        at: new Date().toISOString(),
        type,
        message: formatted.message,
      },
    });
    this.record(type, formatted);
  }

  getSnapshot(): BridgeHealth {
    return { ...this.health, activeRequest: this.health.activeRequest ? { ...this.health.activeRequest } : undefined };
  }

  record(type: HealthEventType, detail?: Record<string, unknown>): void {
    try {
      ensureDir(path.dirname(this.eventPath));
      const event: HealthEvent = {
        at: new Date().toISOString(),
        type,
        pid: process.pid,
        ...(detail ? { detail } : {}),
      };
      appendJsonLine(this.eventPath, event);
    } catch (error) {
      console.warn("Failed to write lifecycle event:", error instanceof Error ? error.message : String(error));
    }
  }

  private patch(update: Partial<BridgeHealth>): void {
    this.health = {
      ...this.health,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.writeHealth();
  }

  private patchRequest(requestId: string | undefined, update: Partial<ActiveRequestState>): void {
    if (!requestId || this.health.activeRequest?.id !== requestId) {
      return;
    }

    this.patch({
      activeRequest: {
        ...this.health.activeRequest,
        ...update,
      },
    });
  }

  private writeHealth(): void {
    try {
      ensureDir(path.dirname(this.healthPath));
      writeFileSync(this.healthPath, `${JSON.stringify(this.health, null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn("Failed to write health file:", error instanceof Error ? error.message : String(error));
    }
  }

  private writePid(): void {
    try {
      ensureDir(path.dirname(this.pidPath));
      writeFileSync(this.pidPath, `${process.pid}\n`, "utf8");
    } catch (error) {
      console.warn("Failed to write pid file:", error instanceof Error ? error.message : String(error));
    }
  }

  private writeCodexCheckpoint(status: string): void {
    try {
      ensureDir(path.dirname(this.checkpointPath));
      const activeRequest = this.health.activeRequest;
      const checkpoint = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        status,
        processId: process.pid,
        activeRequest: activeRequest
          ? {
              id: activeRequest.id,
              contextKey: activeRequest.contextKey,
              startedAt: activeRequest.startedAt,
              lastActivityAt: activeRequest.lastActivityAt,
              lastOutputAt: activeRequest.lastOutputAt,
            }
          : undefined,
      };
      writeFileSync(this.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn("Failed to write Codex checkpoint:", error instanceof Error ? error.message : String(error));
    }
  }
}

export function createRuntimeHealthMonitor(config: TeleCodexConfig): RuntimeHealthMonitor {
  return new RuntimeHealthMonitor(config);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function appendJsonLine(filePath: string, value: unknown): void {
  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf8");
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${existing}${prefix}${JSON.stringify(value)}\n`, "utf8");
}

function formatError(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message };
  }

  return { type: typeof error, message: String(error) };
}
