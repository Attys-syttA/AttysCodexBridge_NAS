import { createBot, registerCommands } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import { createRuntimeHealthMonitor, type RuntimeHealthMonitor } from "./health.js";
import { clearBotControlRequest } from "./process-control.js";
import { SessionRegistry } from "./session-registry.js";
import { startWorkerServer } from "./worker-server.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let health: RuntimeHealthMonitor | undefined;

try {
  const config = loadConfig();
  await clearBotControlRequest(config, "stop");
  health = createRuntimeHealthMonitor(config);
  health.markStarted();

  if (config.runtimeMode === "remote-worker") {
    const server = startWorkerServer(config, health);
    const port = Number.parseInt(process.env.TELECODEX_WORKER_PORT ?? "8787", 10);
    server.listen(port, () => {
      console.log(`AttysCodexBridge worker running on port ${port}`);
      console.log(`State dir: ${config.stateDir}`);
      console.log(`Workspace: ${config.workspace}`);
    });
    process.once("SIGINT", () => server.close());
    process.once("SIGTERM", () => server.close());
    await new Promise(() => {});
  }

  registry = new SessionRegistry(config);
  bot = createBot(config, registry, health);
  await registerCommands(bot);

  console.log("AttysCodexBridge running");
  try {
    const authStatus = await checkAuthStatus(config.codexApiKey, config);
    console.log(`Auth: ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
    if (!authStatus.authenticated) {
      console.warn("Warning: Codex is not authenticated. Use /login or set CODEX_API_KEY.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: startup auth check failed: ${message}`);
    if (config.runtimeMode === "remote-bridge") {
      console.warn("Warning: remote worker is currently unreachable. Bridge will stay online and you can retry later.");
    }
  }
  console.log(`Workspace: ${config.workspace}`);
  if (config.workspaceRoot) {
    console.log(`Workspace root: ${config.workspaceRoot}`);
  }
  console.log(`State dir: ${config.stateDir}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start AttysCodexBridge: ${message}`);
  health?.markFatal(error);
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down AttysCodexBridge...`);
  health?.markStopping(signal);
  if (bot) bot.stop();

  setTimeout(() => {
    registry?.disposeAll();
    console.log("AttysCodexBridge stopped.");
    health?.markStopped(0);
    process.exit(0);
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: true,
      onStart: () => {
        restartAttempts = 0;
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    health?.markFatal(error);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
