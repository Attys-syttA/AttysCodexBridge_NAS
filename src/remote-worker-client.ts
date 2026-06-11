import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveWorkerTarget, type TeleCodexConfig } from "./config.js";
import type { AuthStatus, LoginResult } from "./codex-auth.js";
import type { CodexPromptInput, CodexSessionCallbacks, CodexSessionInfo, CreateOptions, SwitchSessionOptions } from "./codex-session.js";
import type { CodexLaunchProfile } from "./codex-launch.js";
import type { CodexModelRecord, CodexThreadRecord } from "./codex-state.js";
import type { TranscriptionBackend, TranscriptionResult } from "./voice.js";

interface WorkerEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface WorkerSessionCreateResponse {
  sessionId: string;
  info: CodexSessionInfo;
}

interface WorkerUploadResponse {
  localPath: string;
  safeName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

interface WorkerArtifactRecord {
  name: string;
  sizeBytes: number;
}

export class RemoteWorkerClient {
  constructor(
    private readonly config: TeleCodexConfig,
    private readonly workerTargetId?: string,
  ) {}

  async createSession(options?: CreateOptions): Promise<WorkerSessionCreateResponse> {
    return this.requestJson("POST", "/sessions/create", options ?? {});
  }

  async getSessionInfo(sessionId: string): Promise<CodexSessionInfo> {
    return this.requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/info`);
  }

  async newThread(sessionId: string, body: { workspace?: string; model?: string }): Promise<CodexSessionInfo> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/new-thread`, body);
  }

  async resumeThread(sessionId: string, threadId: string): Promise<CodexSessionInfo> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/resume`, { threadId });
  }

  async switchSession(
    sessionId: string,
    threadId: string,
    options?: string | SwitchSessionOptions,
  ): Promise<CodexSessionInfo> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/switch`, { threadId, options });
  }

  async setModel(sessionId: string, slug: string): Promise<{ model: string; info: CodexSessionInfo }> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/model`, { slug });
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<CodexSessionInfo> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/reasoning-effort`, { effort });
  }

  async setLaunchProfile(sessionId: string, profileId: string): Promise<{ profile: CodexLaunchProfile; info: CodexSessionInfo }> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/launch-profile`, { profileId });
  }

  async escalateLaunchProfile(sessionId: string, profileId: string): Promise<CodexSessionInfo> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/escalate`, { profileId });
  }

  async listSessions(sessionId: string, limit = 20): Promise<CodexThreadRecord[]> {
    return this.requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/threads?limit=${limit}`);
  }

  async listWorkspaces(sessionId: string): Promise<string[]> {
    return this.requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/workspaces`);
  }

  async listModels(sessionId: string): Promise<CodexModelRecord[]> {
    return this.requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/models`);
  }

  async abort(sessionId: string): Promise<void> {
    await this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/abort`, {});
  }

  async handback(sessionId: string): Promise<{ threadId: string | null; workspace: string }> {
    return this.requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/handback`, {});
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.requestJson("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async prompt(
    sessionId: string,
    input: CodexPromptInput,
    callbacks: CodexSessionCallbacks,
  ): Promise<void> {
    const prepared = await this.preparePromptInput(input);
    const response = await this.fetch(`${this.baseUrl()}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(prepared.body),
    });

    if (!response.ok || !response.body) {
      throw new Error(await this.readError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffered += decoder.decode(chunk.value, { stream: true });
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffered.slice(0, newlineIndex).trim();
        buffered = buffered.slice(newlineIndex + 1);
        if (line) {
          this.handlePromptEvent(JSON.parse(line) as Record<string, unknown>, callbacks);
        }
        newlineIndex = buffered.indexOf("\n");
      }
    }

    if (prepared.localOutDir && prepared.turnId) {
      await this.downloadArtifacts(prepared.turnId, prepared.localOutDir);
    }
  }

  async checkAuthStatus(): Promise<AuthStatus> {
    return this.requestJson("GET", "/auth/status");
  }

  async startLogin(): Promise<LoginResult> {
    return this.requestJson("POST", "/auth/login", {});
  }

  async startLogout(): Promise<LoginResult> {
    return this.requestJson("POST", "/auth/logout", {});
  }

  async getVoiceBackends(): Promise<TranscriptionBackend[]> {
    return this.requestJson("GET", "/voice/backends");
  }

  async transcribeAudio(filePath: string): Promise<TranscriptionResult> {
    const payload = await this.uploadFile(filePath, "audio/ogg", "audio");
    return this.requestJson("POST", "/voice/transcribe", { localPath: payload.localPath });
  }

  async getHealth(): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/health");
  }

  private async preparePromptInput(input: CodexPromptInput): Promise<{
    body: CodexPromptInput;
    localOutDir?: string;
    turnId?: string;
  }> {
    if (typeof input === "string") {
      return { body: input };
    }

    const remoteImagePaths: string[] = [];
    for (const imagePath of input.imagePaths ?? []) {
      const uploaded = await this.uploadFile(imagePath, "application/octet-stream", "image");
      remoteImagePaths.push(uploaded.localPath);
    }

    const remoteStagedFiles = [];
    for (const file of input.stagedFiles ?? []) {
      const uploaded = await this.uploadFile(file.localPath, file.mimeType, "staged-file", file.originalName);
      remoteStagedFiles.push({
        ...file,
        localPath: uploaded.localPath,
      });
    }

    const remoteOutDir = input.turnId
      ? await this.requestJson<string>("POST", "/uploads/out-dir", { turnId: input.turnId })
      : undefined;

    const body: CodexPromptInput = {
      ...input,
      imagePaths: remoteImagePaths,
      stagedFiles: remoteStagedFiles,
      ...(remoteStagedFiles.length > 0 && remoteOutDir
        ? { stagedFileInstructions: buildRemoteFileInstructions(remoteStagedFiles, remoteOutDir) }
        : {}),
      ...(remoteOutDir ? { outDir: remoteOutDir } : {}),
    };

    return {
      body,
      localOutDir: input.outDir,
      turnId: input.turnId,
    };
  }

  private handlePromptEvent(event: Record<string, unknown>, callbacks: CodexSessionCallbacks): void {
    switch (event.type) {
      case "text_delta":
        callbacks.onTextDelta(String(event.delta ?? ""));
        break;
      case "tool_start":
        callbacks.onToolStart(String(event.toolName ?? ""), String(event.toolCallId ?? ""));
        break;
      case "tool_update":
        callbacks.onToolUpdate(String(event.toolCallId ?? ""), String(event.partialResult ?? ""));
        break;
      case "tool_end":
        callbacks.onToolEnd(String(event.toolCallId ?? ""), Boolean(event.isError));
        break;
      case "todo_update":
        callbacks.onTodoUpdate?.((event.items as Array<{ text: string; completed: boolean }>) ?? []);
        break;
      case "turn_complete":
        callbacks.onTurnComplete?.({
          inputTokens: Number(event.inputTokens ?? 0),
          cachedInputTokens: Number(event.cachedInputTokens ?? 0),
          outputTokens: Number(event.outputTokens ?? 0),
        });
        break;
      case "agent_end":
        callbacks.onAgentEnd();
        break;
      case "error":
        throw new Error(String(event.message ?? "Remote worker prompt failed"));
      default:
        break;
    }
  }

  private async uploadFile(
    localPath: string,
    mimeType: string,
    kind: "image" | "staged-file" | "audio",
    originalName?: string,
  ): Promise<WorkerUploadResponse> {
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(localPath);
    return this.requestJson("POST", "/uploads", {
      kind,
      originalName: originalName ?? path.basename(localPath),
      mimeType,
      contentBase64: buffer.toString("base64"),
    });
  }

  private async downloadArtifacts(turnId: string, localOutDir: string): Promise<void> {
    const artifacts = await this.requestJson<WorkerArtifactRecord[]>(
      "GET",
      `/turns/${encodeURIComponent(turnId)}/artifacts`,
    );
    await mkdir(localOutDir, { recursive: true });

    for (const artifact of artifacts) {
      const response = await this.fetch(
        `${this.baseUrl()}/turns/${encodeURIComponent(turnId)}/artifacts/${encodeURIComponent(artifact.name)}`,
        { headers: this.authHeaders() },
      );
      if (!response.ok) {
        throw new Error(await this.readError(response));
      }
      const arrayBuffer = await response.arrayBuffer();
      await writeFile(path.join(localOutDir, artifact.name), Buffer.from(arrayBuffer));
    }
  }

  private async requestJson<T>(method: string, resourcePath: string, body?: unknown): Promise<T> {
    const response = await this.fetch(`${this.baseUrl()}${resourcePath}`, {
      method,
      headers: body === undefined ? this.authHeaders() : this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(await this.readError(response));
    }

    const payload = await response.json() as WorkerEnvelope<T>;
    if (!payload.ok) {
      throw new Error(payload.error || "Remote worker request failed");
    }
    return payload.data as T;
  }

  private async readError(response: Response): Promise<string> {
    const text = (await response.text().catch(() => "")).trim();
    return text || `${response.status} ${response.statusText}`.trim();
  }

  private headers(): Record<string, string> {
    return {
      ...this.authHeaders(),
      "content-type": "application/json",
    };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const workerTarget = resolveWorkerTarget(this.config, this.workerTargetId);
    const sharedSecret = workerTarget?.sharedSecret ?? this.config.workerSharedSecret;
    if (sharedSecret) {
      headers["x-telecodex-shared-secret"] = sharedSecret;
    }
    return headers;
  }

  private baseUrl(): string {
    const baseUrl = resolveWorkerTarget(this.config, this.workerTargetId)?.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error("Missing remote worker base URL for remote bridge mode");
    }
    return baseUrl.replace(/\/+$/, "");
  }

  private fetch(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.workerTimeoutMs);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
  }
}

function buildRemoteFileInstructions(
  files: Array<{ safeName: string; localPath: string; mimeType: string; sizeBytes: number }>,
  outDir: string,
): string {
  const lines = ["The following files were uploaded by the user and staged on disk:", ""];

  for (const file of files) {
    lines.push(`- ${file.safeName} (${file.mimeType}, ${formatBytes(file.sizeBytes)}) -> ${file.localPath}`);
  }

  lines.push("");
  lines.push(`Write any output files to: ${outDir}`);
  lines.push("The user will receive files from that directory after this turn completes.");
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
