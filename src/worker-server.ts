import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectArtifactReport } from "./artifacts.js";
import { sanitizeFilename } from "./attachments.js";
import { startLogin, startLogout, checkAuthStatus } from "./codex-auth.js";
import { CodexSessionService, type CodexPromptInput, type CreateOptions, type SwitchSessionOptions } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import { createRuntimeHealthMonitor, type RuntimeHealthMonitor } from "./health.js";
import { getRuntimeOutDir } from "./runtime-paths.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";

type SessionEntry = {
  service: CodexSessionService;
};

export function startWorkerServer(
  config: TeleCodexConfig,
  health: RuntimeHealthMonitor = createRuntimeHealthMonitor(config),
): ReturnType<typeof createServer> {
  const sessions = new Map<string, SessionEntry>();

  const server = createServer(async (req, res) => {
    try {
      if (!isAuthorized(config, req)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized worker request" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          data: {
            mode: config.runtimeMode,
            stateDir: config.stateDir,
            workspace: config.workspace,
            updatedAt: new Date().toISOString(),
            health: health.getSnapshot(),
          },
        });
        return;
      }

      if (method === "GET" && url.pathname === "/auth/status") {
        sendJson(res, 200, { ok: true, data: await checkAuthStatus(config.codexApiKey) });
        return;
      }

      if (method === "POST" && url.pathname === "/auth/login") {
        sendJson(res, 200, { ok: true, data: await startLogin() });
        return;
      }

      if (method === "POST" && url.pathname === "/auth/logout") {
        sendJson(res, 200, { ok: true, data: await startLogout() });
        return;
      }

      if (method === "GET" && url.pathname === "/voice/backends") {
        sendJson(res, 200, { ok: true, data: await getAvailableBackends() });
        return;
      }

      if (method === "POST" && url.pathname === "/voice/transcribe") {
        const body = await readJson<{ localPath: string }>(req);
        sendJson(res, 200, { ok: true, data: await transcribeAudio(body.localPath) });
        return;
      }

      if (method === "POST" && url.pathname === "/uploads") {
        const body = await readJson<{
          kind: string;
          originalName: string;
          mimeType: string;
          contentBase64: string;
        }>(req);
        const localPath = await persistUploadedFile(config, body);
        sendJson(res, 200, {
          ok: true,
          data: {
            localPath,
            safeName: path.basename(localPath),
            originalName: body.originalName,
            mimeType: body.mimeType,
            sizeBytes: Buffer.byteLength(body.contentBase64, "base64"),
          },
        });
        return;
      }

      if (method === "POST" && url.pathname === "/uploads/out-dir") {
        const body = await readJson<{ turnId: string }>(req);
        const outDir = getRuntimeOutDir(config, body.turnId);
        await mkdir(outDir, { recursive: true });
        sendJson(res, 200, { ok: true, data: outDir });
        return;
      }

      if (method === "POST" && url.pathname === "/sessions/create") {
        const options = await readJson<CreateOptions>(req);
        const service = await CodexSessionService.create(config, options);
        const sessionId = randomUUID();
        sessions.set(sessionId, { service });
        sendJson(res, 200, { ok: true, data: { sessionId, info: service.getInfo() } });
        return;
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
        const tail = sessionMatch[2] ?? "";
        const entry = sessions.get(sessionId);
        if (!entry) {
          sendJson(res, 404, { ok: false, error: "Worker session not found" });
          return;
        }

        if (method === "DELETE" && tail === "") {
          entry.service.dispose();
          sessions.delete(sessionId);
          sendJson(res, 200, { ok: true, data: true });
          return;
        }

        if (method === "GET" && tail === "info") {
          sendJson(res, 200, { ok: true, data: entry.service.getInfo() });
          return;
        }

        if (method === "POST" && tail === "new-thread") {
          const body = await readJson<{ workspace?: string; model?: string }>(req);
          sendJson(res, 200, { ok: true, data: await entry.service.newThread(body.workspace, body.model) });
          return;
        }

        if (method === "POST" && tail === "resume") {
          const body = await readJson<{ threadId: string }>(req);
          sendJson(res, 200, { ok: true, data: await entry.service.resumeThread(body.threadId) });
          return;
        }

        if (method === "POST" && tail === "switch") {
          const body = await readJson<{ threadId: string; options?: string | SwitchSessionOptions }>(req);
          sendJson(res, 200, { ok: true, data: await entry.service.switchSession(body.threadId, body.options) });
          return;
        }

        if (method === "POST" && tail === "abort") {
          await entry.service.abort();
          sendJson(res, 200, { ok: true, data: true });
          return;
        }

        if (method === "POST" && tail === "model") {
          const body = await readJson<{ slug: string }>(req);
          const model = entry.service.setModel(body.slug);
          sendJson(res, 200, { ok: true, data: { model, info: entry.service.getInfo() } });
          return;
        }

        if (method === "POST" && tail === "reasoning-effort") {
          const body = await readJson<{ effort: "minimal" | "low" | "medium" | "high" | "xhigh" }>(req);
          entry.service.setReasoningEffort(body.effort);
          sendJson(res, 200, { ok: true, data: entry.service.getInfo() });
          return;
        }

        if (method === "POST" && tail === "launch-profile") {
          const body = await readJson<{ profileId: string }>(req);
          const profile = entry.service.setLaunchProfile(body.profileId);
          sendJson(res, 200, { ok: true, data: { profile, info: entry.service.getInfo() } });
          return;
        }

        if (method === "POST" && tail === "escalate") {
          const body = await readJson<{ profileId: string }>(req);
          sendJson(res, 200, { ok: true, data: await entry.service.escalateLaunchProfile(body.profileId) });
          return;
        }

        if (method === "GET" && tail.startsWith("threads")) {
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
          sendJson(res, 200, { ok: true, data: await entry.service.listAllSessions(limit) });
          return;
        }

        if (method === "GET" && tail === "workspaces") {
          sendJson(res, 200, { ok: true, data: await entry.service.listWorkspaces() });
          return;
        }

        if (method === "GET" && tail === "models") {
          sendJson(res, 200, { ok: true, data: await entry.service.listModels() });
          return;
        }

        if (method === "GET" && tail === "repo-diagnostics") {
          sendJson(res, 200, { ok: true, data: await entry.service.inspectRepo() });
          return;
        }

        if (method === "GET" && tail === "push-capability") {
          sendJson(res, 200, { ok: true, data: await entry.service.probePushCapability() });
          return;
        }

        if (method === "POST" && tail === "push") {
          sendJson(res, 200, { ok: true, data: await entry.service.pushCurrentBranch() });
          return;
        }

        if (method === "POST" && tail === "handback") {
          sendJson(res, 200, { ok: true, data: entry.service.handback() });
          return;
        }

        if (method === "POST" && tail === "prompt") {
          const input = await readJson<CodexPromptInput>(req);
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");

          try {
            await entry.service.prompt(input, {
              onTextDelta: (delta) => {
                res.write(`${JSON.stringify({ type: "text_delta", delta })}\n`);
              },
              onToolStart: (toolName, toolCallId) => {
                res.write(`${JSON.stringify({ type: "tool_start", toolName, toolCallId })}\n`);
              },
              onToolUpdate: (toolCallId, partialResult) => {
                res.write(`${JSON.stringify({ type: "tool_update", toolCallId, partialResult })}\n`);
              },
              onToolEnd: (toolCallId, isError) => {
                res.write(`${JSON.stringify({ type: "tool_end", toolCallId, isError })}\n`);
              },
              onTodoUpdate: (items) => {
                res.write(`${JSON.stringify({ type: "todo_update", items })}\n`);
              },
              onTurnComplete: (usage) => {
                res.write(`${JSON.stringify({ type: "turn_complete", ...usage })}\n`);
              },
              onAgentEnd: () => {
                res.write(`${JSON.stringify({ type: "agent_end" })}\n`);
              },
            });
          } catch (error) {
            res.write(`${JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            })}\n`);
          }
          res.end();
          return;
        }
      }

      const artifactsMatch = url.pathname.match(/^\/turns\/([^/]+)\/artifacts(?:\/(.+))?$/);
      if (artifactsMatch) {
        const turnId = decodeURIComponent(artifactsMatch[1] ?? "");
        const artifactName = artifactsMatch[2] ? decodeURIComponent(artifactsMatch[2]) : undefined;
        const outDir = getRuntimeOutDir(config, turnId);

        if (!artifactName) {
          const report = await collectArtifactReport(outDir);
          sendJson(res, 200, {
            ok: true,
            data: report.artifacts.map((artifact) => ({ name: artifact.name, sizeBytes: artifact.sizeBytes })),
          });
          return;
        }

        const targetPath = path.join(outDir, artifactName);
        const buffer = await readFile(targetPath);
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end(buffer);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown worker endpoint: ${method} ${url.pathname}` });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return server;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) as T : {} as T;
}

async function persistUploadedFile(
  config: TeleCodexConfig,
  body: { kind: string; originalName: string; mimeType: string; contentBase64: string },
): Promise<string> {
  const safeName = sanitizeFilename(body.originalName || `${body.kind}-${randomUUID().slice(0, 8)}`);
  const dir = path.join(config.stateDir, "remote-uploads", body.kind);
  await mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, safeName);
  await writeFile(targetPath, Buffer.from(body.contentBase64, "base64"));
  return targetPath;
}

function isAuthorized(config: TeleCodexConfig, req: IncomingMessage): boolean {
  const expected = config.workerSharedSecret?.trim();
  if (!expected) {
    return true;
  }

  return req.headers["x-telecodex-shared-secret"] === expected;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
