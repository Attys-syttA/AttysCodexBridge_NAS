import type { ModelReasoningEffort } from "@openai/codex-sdk";

import { findLaunchProfile, type CodexLaunchProfile } from "./codex-launch.js";
import { resolveWorkerTarget, type TeleCodexConfig, type WorkerTarget } from "./config.js";
import type {
  CodexPromptInput,
  CodexSessionCallbacks,
  CodexSessionInfo,
  CodexSessionRuntime,
  CreateOptions,
  SwitchSessionOptions,
} from "./codex-session.js";
import type { CodexModelRecord, CodexThreadRecord } from "./codex-state.js";
import type { GitPushCapability, GitPushResult, RepoDiagnostics } from "./repo-diagnostics.js";
import { RemoteWorkerClient } from "./remote-worker-client.js";

export class RemoteCodexSessionService implements CodexSessionRuntime {
  private readonly client: RemoteWorkerClient;
  private readonly workerTarget: WorkerTarget;
  private sessionId: string;
  private currentInfo: CodexSessionInfo;
  private readonly workspaces: string[] = [];
  private readonly models: CodexModelRecord[] = [];
  private processing = false;
  private selectedLaunchProfile: CodexLaunchProfile;

  private constructor(
    private readonly config: TeleCodexConfig,
    sessionId: string,
    info: CodexSessionInfo,
    workerTargetId?: string,
  ) {
    this.workerTarget = resolveRequiredWorkerTarget(config, workerTargetId);
    this.client = new RemoteWorkerClient(config, this.workerTarget.id);
    this.sessionId = sessionId;
    this.currentInfo = info;
    this.selectedLaunchProfile = resolveProfile(config, info.nextLaunchProfileId ?? info.launchProfileId);
  }

  static async create(
    config: TeleCodexConfig,
    options?: CreateOptions,
    workerTargetId?: string,
  ): Promise<RemoteCodexSessionService> {
    const workerTarget = resolveRequiredWorkerTarget(config, workerTargetId);
    const client = new RemoteWorkerClient(config, workerTarget.id);
    const created = await client.createSession(options);
    return new RemoteCodexSessionService(config, created.sessionId, created.info, workerTarget.id);
  }

  getInfo(): CodexSessionInfo {
    return { ...this.currentInfo };
  }

  getWorkerTargetId(): string | undefined {
    return this.workerTarget.id;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  hasActiveThread(): boolean {
    return Boolean(this.currentInfo.threadId);
  }

  getCurrentWorkspace(): string {
    return this.currentInfo.workspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    this.processing = true;
    try {
      await this.client.prompt(this.sessionId, input, callbacks);
      this.currentInfo = await this.client.getSessionInfo(this.sessionId);
    } finally {
      this.processing = false;
    }
  }

  async abort(): Promise<void> {
    await this.client.abort(this.sessionId);
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.currentInfo = await this.client.newThread(this.sessionId, { workspace, model });
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.currentInfo = await this.client.resumeThread(this.sessionId, threadId);
    return this.getInfo();
  }

  async switchSession(threadId: string, options?: string | SwitchSessionOptions): Promise<CodexSessionInfo> {
    this.currentInfo = await this.client.switchSession(this.sessionId, threadId, options);
    return this.getInfo();
  }

  async listAllSessions(limit?: number): Promise<CodexThreadRecord[]> {
    return this.client.listSessions(this.sessionId, limit ?? 20);
  }

  async listWorkspaces(): Promise<string[]> {
    if (this.workspaces.length === 0) {
      await this.refreshLists();
    }
    return [...this.workspaces];
  }

  async listModels(): Promise<CodexModelRecord[]> {
    if (this.models.length === 0) {
      await this.refreshLists();
    }
    return [...this.models];
  }

  async inspectRepo(): Promise<RepoDiagnostics> {
    return this.client.inspectRepo(this.sessionId);
  }

  async probePushCapability(): Promise<GitPushCapability> {
    const capability = await this.client.probePushCapability(this.sessionId);
    this.currentInfo = {
      ...this.currentInfo,
      pushCapabilityStatus: capability.status,
      pushCapabilityReason: capability.reason,
      ...(capability.remoteName ? { pushRemoteName: capability.remoteName } : {}),
    };
    return capability;
  }

  async pushCurrentBranch(): Promise<GitPushResult> {
    const result = await this.client.pushCurrentBranch(this.sessionId);
    this.currentInfo = {
      ...this.currentInfo,
      pushCapabilityStatus: "available",
      pushCapabilityReason: "A push sikeresen lefutott.",
      pushRemoteName: result.remoteName,
    };
    return result;
  }

  async refreshLists(): Promise<void> {
    const [workspaces, models] = await Promise.all([
      this.client.listWorkspaces(this.sessionId),
      this.client.listModels(this.sessionId),
    ]);
    this.workspaces.splice(0, this.workspaces.length, ...workspaces);
    this.models.splice(0, this.models.length, ...models);
  }

  setModel(slug: string): string {
    void this.client.setModel(this.sessionId, slug).then((result) => {
      this.currentInfo = result.info;
    });
    this.currentInfo = { ...this.currentInfo, model: slug };
    return slug;
  }

  setReasoningEffort(effort: ModelReasoningEffort): void {
    void this.client.setReasoningEffort(this.sessionId, effort).then((info) => {
      this.currentInfo = info;
    });
    this.currentInfo = { ...this.currentInfo, reasoningEffort: effort };
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.selectedLaunchProfile = resolveProfile(this.config, profileId);
    void this.client.setLaunchProfile(this.sessionId, profileId).then((result) => {
      this.selectedLaunchProfile = result.profile;
      this.currentInfo = result.info;
    });
    this.currentInfo = {
      ...this.currentInfo,
      nextLaunchProfileId: profileId,
      nextLaunchProfileLabel: this.selectedLaunchProfile.label,
      nextLaunchProfileBehavior: `${this.selectedLaunchProfile.sandboxMode} / ${this.selectedLaunchProfile.approvalPolicy}`,
      nextCapabilityMode: this.selectedLaunchProfile.capabilityMode,
      nextGithubWriteEnabled: this.selectedLaunchProfile.capabilityMode === "github-write",
    };
    return this.selectedLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.selectedLaunchProfile;
  }

  async escalateLaunchProfile(profileId: string): Promise<CodexSessionInfo> {
    this.selectedLaunchProfile = resolveProfile(this.config, profileId);
    this.currentInfo = await this.client.escalateLaunchProfile(this.sessionId, profileId);
    return this.getInfo();
  }

  handback(): { threadId: string | null; workspace: string } {
    void this.client.handback(this.sessionId);
    const info = { threadId: this.currentInfo.threadId, workspace: this.currentInfo.workspace };
    this.currentInfo = { ...this.currentInfo, threadId: null };
    return info;
  }

  dispose(): void {
    void this.client.disposeSession(this.sessionId);
  }
}

function resolveRequiredWorkerTarget(config: TeleCodexConfig, workerTargetId?: string): WorkerTarget {
  const workerTarget = resolveWorkerTarget(config, workerTargetId);
  if (!workerTarget) {
    throw new Error("Missing remote worker target configuration for remote bridge mode");
  }
  return workerTarget;
}

function resolveProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}
