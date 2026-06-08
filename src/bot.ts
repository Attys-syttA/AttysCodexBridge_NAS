import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderHelpTopicMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
} from "./codex-session.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import { findCodexSessionFile } from "./codex-session-file.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
} from "./codex-launch.js";
import { getThread } from "./codex-state.js";
import { createCommit, runCommitChecks, suggestCommitMessage } from "./commit-flow.js";
import type { TeleCodexConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { createRuntimeHealthMonitor, type RuntimeHealthMonitor } from "./health.js";
import { findHandoffInboxRecord, removeHandoffInboxRecord } from "./handoff-inbox.js";
import { appendOperatorEvent, appendOperatorNote } from "./operator-log.js";
import { buildOperatorPolicyPreamble } from "./operator-policy.js";
import {
  requestGracefulBotShutdown,
  scheduleBotRestart,
  writeBotControlRequest,
  type BotControlAction,
} from "./process-control.js";
import { formatGitStatusPlain, inspectRepo, type RepoDiagnostics } from "./repo-diagnostics.js";
import { getRuntimeRoot } from "./runtime-paths.js";
import { SessionRegistry, type ContextHandoff } from "./session-registry.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";
import { formatWorkspaceButtonLabel } from "./workspace.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 20_000;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";
const BOT_CONTROL_CONFIRM_TTL_MS = 2 * 60 * 1000;
const COMMIT_CONFIRM_TTL_MS = 5 * 60 * 1000;

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };
type PendingBotControlConfirmation = {
  action: BotControlAction;
  contextKey: TelegramContextKey;
  requestedBy?: string;
  expiresAt: number;
};
type PendingCommitConfirmation = {
  contextKey: TelegramContextKey;
  repoRoot: string;
  message: string;
  files: string[];
  expiresAt: number;
};
export type DirectResumeWarning = {
  sessionPath: string;
  sizeBytes: number;
  maxBytes: number;
};

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
  replyToMessageId?: number;
  timeoutMs?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Előző", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Következő ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export function createBot(
  config: TeleCodexConfig,
  registry: SessionRegistry,
  health: RuntimeHealthMonitor = createRuntimeHealthMonitor(config),
): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingProjectWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingProjectWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingBotControlConfirmations = new Map<string, PendingBotControlConfirmation>();
  const pendingCommitConfirmations = new Map<string, PendingCommitConfirmation>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    for (const [nonce, pending] of pendingBotControlConfirmations) {
      if (pending.contextKey === key) {
        pendingBotControlConfirmations.delete(nonce);
      }
    }
    for (const [nonce, pending] of pendingCommitConfirmations) {
      if (pending.contextKey === key) {
        pendingCommitConfirmations.delete(nonce);
      }
    }
    lastPromptInput.delete(key);
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(state?.processing || state?.switching || state?.transcribing || session?.isProcessing());
  };

  const isBotControlBusy = (contextKey: TelegramContextKey): boolean => {
    return Boolean(health.getSnapshot().activeRequest || isBusy(contextKey));
  };

  const getRequesterLabel = (ctx: Context): string | undefined => {
    if (!ctx.from) {
      return undefined;
    }

    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim();
    return name ? `${name} (${ctx.from.id})` : String(ctx.from.id);
  };

  const inspectContextRepo = async (session: CodexSessionService): Promise<RepoDiagnostics> => {
    return inspectRepo(session.getInfo().workspace, config.workspaceRoot);
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const setAttachedHandoff = (contextKey: TelegramContextKey, info: CodexSessionInfo, sourceHost = config.hostLabel): void => {
    if (!info.threadId) {
      return;
    }

    registry.setHandoff(contextKey, {
      status: "attached",
      workspace: info.workspace,
      threadId: info.threadId,
      sourceHost,
      targetHost: config.hostLabel,
      createdAt: new Date().toISOString(),
    });
  };

  const blockPromptForPendingHandoff = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    const inboxHandoff = await loadHandoffInboxRecord(config, contextKey);
    const handoff = inboxHandoff ?? registry.getHandoff(contextKey);
    if (handoff) {
      registry.setHandoff(contextKey, handoff);
    }

    if (!handoff || !shouldBlockPromptForHandoff(handoff)) {
      if (inboxHandoff?.status === "attached" && inboxHandoff.threadId) {
        if (isBusy(contextKey)) {
          await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet átadott szálra váltani."), {
            fallbackText: "Futó kérés közben nem lehet átadott szálra váltani.",
          });
          return true;
        }

        const resumeWarning = getDirectResumeWarning(config, inboxHandoff);
        if (resumeWarning) {
          const pendingHandoff: ContextHandoff = {
            ...inboxHandoff,
            status: "pending_inbound",
          };
          registry.setHandoff(contextKey, pendingHandoff);
          await clearHandoffInboxRecord(config, contextKey);
          await safeReply(ctx, renderDirectResumeWarningHTML(pendingHandoff, resumeWarning), {
            fallbackText: renderDirectResumeWarningPlain(pendingHandoff, resumeWarning),
          });
          return true;
        }

        try {
          const info = await session.switchSession(inboxHandoff.threadId, {
            workspaceOverride: inboxHandoff.workspace,
            modelOverride: inboxHandoff.model,
            preferWorkspaceOverride: true,
            ignoreStoredModel: true,
          });
          updateSessionMetadata(contextKey, session);
          setAttachedHandoff(contextKey, info, inboxHandoff.sourceHost);
          await clearHandoffInboxRecord(config, contextKey);
        } catch (error) {
          await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
            fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
          });
          return true;
        }
      }
      return false;
    }

    const plainText = renderPendingHandoffPlain(handoff);
    await safeReply(ctx, renderPendingHandoffHTML(handoff), { fallbackText: plainText });
    return true;
  };

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Még dolgozom az előző üzeneten..."), {
      fallbackText: "Még dolgozom az előző üzeneten...",
    });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Nem sikerült szálat létrehozni: ${friendlyErrorText(error)}`), {
        fallbackText: `Nem sikerült szálat létrehozni: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const replyToMessageId = resolveReplyToMessageId(ctx);
    const requestId = randomUUID();

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;

    const abortKeyboard = new InlineKeyboard().text("⏹ Megszakítás", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let accumulatedText = "";
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let lastOutputAt = Date.now();
    let lastStatusMessageAt = 0;
    let timeoutTriggered = false;

    const typingInterval = setInterval(() => {
      const now = Date.now();
      if (
        now - lastOutputAt >= config.codexNoOutputStatusMs &&
        now - lastStatusMessageAt >= config.codexNoOutputStatusMs
      ) {
        lastStatusMessageAt = now;
        void safeReply(
          ctx,
          escapeHTML("Még várok Codex válaszára. Ha ez a kör túllépi a hard timeoutot, automatikusan lezárom."),
          {
            fallbackText:
              "Még várok Codex válaszára. Ha ez a kör túllépi a hard timeoutot, automatikusan lezárom.",
          },
        ).catch((error) => {
          health.markTelegramFailure("telegram_send_failed", error);
          console.error("Failed to send no-output status message", error);
        });
      }

      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .then(() => health.markTyping(requestId))
        .catch(() => {});
    }, config.telegramTypingIntervalMs);
    void bot.api
      .sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .then(() => health.markTyping(requestId))
      .catch(() => {});
    const hardTimeout = setTimeout(() => {
      timeoutTriggered = true;
      health.markRequestTimeout(requestId, config.codexTurnHardTimeoutMs);
      void session.abort().catch((error) => {
        console.error("Failed to abort timed out Codex turn", error);
      });
    }, config.codexTurnHardTimeoutMs);

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const clearHardTimeout = (): void => {
      clearTimeout(hardTimeout);
    };

    const renderPreview = (): RenderedChunk => {
      const previewText = buildStreamingPreview(accumulatedText);
      return renderMarkdownChunkWithinLimit(previewText);
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        stopTyping();
        const preview = renderPreview();
        const message = await sendTextMessage(bot.api, chatId, preview.text, {
          parseMode: preview.parseMode,
          fallbackText: preview.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
          replyToMessageId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = preview.text;
        lastEditAt = Date.now();
        health.markOutboundTelegramMessage(requestId);
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText) {
        return;
      }
      if (!responseMessageId) {
        await ensureResponseMessage();
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      if (!force && now - lastEditAt < config.telegramEditDebounceMs) {
        return;
      }

      const nextText = renderPreview();
      if (nextText.text === lastRenderedText) {
        return;
      }

      isFlushing = true;
      try {
        await safeEditMessage(bot, chatId, responseMessageId, nextText.text, {
          parseMode: nextText.parseMode,
          fallbackText: nextText.fallbackText,
          replyMarkup: abortKeyboard,
        });
        lastRenderedText = nextText.text;
        lastEditAt = Date.now();
        health.markTelegramEdit(requestId);
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized) {
        return;
      }

      const delay = Math.max(0, config.telegramEditDebounceMs - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await bot.api.editMessageReplyMarkup(chatId, responseMessageId, {
          reply_markup: new InlineKeyboard(),
        });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await safeEditMessage(bot, chatId, responseMessageId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
        });
        health.markTelegramEdit(requestId);
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
          replyToMessageId,
        });
        responseMessageId = message.message_id;
        health.markOutboundTelegramMessage(requestId);
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
          replyToMessageId,
        });
        health.markOutboundTelegramMessage(requestId);
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      const finalText = buildFinalResponseText(accumulatedText);
      if (!finalText) {
        const html = "<b>✅ Kész</b>";
        const plainText = "✅ Kész";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        return;
      }

      await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
    };

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: (delta: string) => {
        accumulatedText += delta;
        lastOutputAt = Date.now();
        health.markRequestOutput(requestId);
        if (!responseMessageId) {
          void ensureResponseMessage()
            .then(() => {
              scheduleFlush();
            })
            .catch((error) => {
              console.error("Failed to send initial Telegram response message", error);
            });
          return;
        }

        scheduleFlush();
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        health.markRequestStreaming(requestId);
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
            replyToMessageId,
          });
          health.markOutboundTelegramMessage(requestId);
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
            replyToMessageId,
          })
            .then(() => health.markOutboundTelegramMessage(requestId))
            .catch((error) => {
              health.markTelegramFailure("telegram_send_failed", error);
              console.error(`Failed to send tool error message for ${state.toolName}`, error);
            });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        })
          .then(() => health.markTelegramEdit(requestId))
          .catch((error) => {
            health.markTelegramFailure("telegram_edit_failed", error);
            console.error(`Failed to update tool message for ${state.toolName}`, error);
          });
      },
      onTodoUpdate: (items) => {
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, {
            parseMode: "HTML",
            messageThreadId,
            replyToMessageId,
          })
            .then((msg) => {
              planMessageId = msg.message_id;
              health.markOutboundTelegramMessage(requestId);
            })
            .catch((err) => {
              health.markTelegramFailure("telegram_send_failed", err);
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" })
            .then(() => health.markTelegramEdit(requestId))
            .catch((err) => {
              health.markTelegramFailure("telegram_edit_failed", err);
              console.error("Failed to update plan message", err);
            });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onAgentEnd: () => {
        void finalizeResponse().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    health.startRequest({
      id: requestId,
      contextKey,
      chatId: String(chatId),
    });

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex nincs hitelesítve.</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "A hitelesítés indításához használd a /login parancsot, vagy állítsd be a CODEX_API_KEY értéket a gépen.",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex nincs hitelesítve.",
              "",
              authStatus.detail,
              "",
              "A hitelesítés indításához használd a /login parancsot, vagy állítsd be a CODEX_API_KEY értéket a gépen.",
            ].join("\n"),
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      const repo = await inspectContextRepo(session);
      const policyPreamble = buildOperatorPolicyPreamble(config, repo);
      const promptInput: CodexPromptInput = typeof userInput === "string"
        ? { policyPreamble, text: userInput }
        : { ...userInput, policyPreamble };
      await session.prompt(promptInput, callbacks);
      updateSessionMetadata(contextKey, session);
      await finalizeResponse();
    } catch (error) {
      if (timeoutTriggered) {
        health.markRequestTimeout(requestId, config.codexTurnHardTimeoutMs);
      }
      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          await deliverRenderedChunks(chunks);
        } catch (telegramError) {
          health.markTelegramFailure("telegram_send_failed", telegramError);
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      clearFlushTimer();
      clearHardTimeout();
      busyState.processing = false;
      health.finishRequest(requestId);
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);
    const replyToMessageId = resolveReplyToMessageId(ctx);
    const replyParameters = buildReplyParameters(replyToMessageId);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
          ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    health.markInboundTelegramUpdate();

    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Nincs jogosultság" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Nincs jogosultság"), { fallbackText: "Nincs jogosultság" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Nincs hitelesítve. Használd a /login parancsot, vagy állítsd be a CODEX_API_KEY értéket.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(config, info),
        renderSessionInfoPlain(config, info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderHostInfoHTML(config), renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderHostInfoPlain(config), renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const topic = rawText.replace(/^\/help(?:@\w+)?\s*/i, "").trim();
    const help = topic ? renderHelpTopicMessage(topic) : renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Hitelesítési állapot:</b> ${authStatus.authenticated ? "hitelesítve" : "nincs hitelesítve"}`,
      `<b>Módszer:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Részlet:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Hitelesítési állapot: ${authStatus.authenticated ? "hitelesítve" : "nincs hitelesítve"}`,
      `Módszer: ${authStatus.method}`,
      `Részlet: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Már hitelesítve van</b> ezzel: <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Már hitelesítve van ezzel: ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>A Telegramból indított bejelentkezés ki van kapcsolva.</b>",
          "",
          "Futtasd a <code>codex login</code> parancsot a gépen, vagy állítsd be a CODEX_API_KEY értéket a .env fájlban.",
        ].join("\n"),
        {
          fallbackText: [
            "A Telegramból indított bejelentkezés ki van kapcsolva.",
            "",
            "Futtasd a 'codex login' parancsot a gépen, vagy állítsd be a CODEX_API_KEY értéket a .env fájlban.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Bejelentkezés elindítva.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Bejelentkezés elindítva.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ A bejelentkezés nem sikerült.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ A bejelentkezés nem sikerült.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>CODEX_API_KEY használata mellett Telegramból nem lehet kijelentkezni.</b>",
          "",
          "A CLI-alapú hitelesítéshez vedd ki a CODEX_API_KEY értéket a .env fájlból.",
        ].join("\n"),
        {
          fallbackText: [
            "CODEX_API_KEY használata mellett Telegramból nem lehet kijelentkezni.",
            "",
            "A CLI-alapú hitelesítéshez vedd ki a CODEX_API_KEY értéket a .env fájlból.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>A Telegramból indított hitelesítéskezelés ki van kapcsolva.</b>",
        "",
        "Futtasd a <code>codex logout</code> parancsot a gépen.",
      ].join("\n"), {
        fallbackText: [
          "A Telegramból indított hitelesítéskezelés ki van kapcsolva.",
          "",
          "Futtasd a 'codex logout' parancsot a gépen.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Jelenleg nincs hitelesítve."), {
        fallbackText: "Jelenleg nincs hitelesítve.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Kijelentkezve.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Kijelentkezve.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ A kijelentkezés nem sikerült.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ A kijelentkezés nem sikerült.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>A hangfelismerés nem érhető el.</b>",
          "",
          "Telepítsd a <code>parakeet-coreml</code> + ffmpeg párost, vagy állítsd be az <code>OPENAI_API_KEY</code> értéket.",
          "<i>Megjegyzés: a hangfelismerés OPENAI_API_KEY-t használ, nem CODEX_API_KEY-t.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "A hangfelismerés nem érhető el.",
            "",
            "Telepítsd a parakeet-coreml + ffmpeg párost, vagy állítsd be az OPENAI_API_KEY értéket.",
            "Megjegyzés: a hangfelismerés OPENAI_API_KEY-t használ, nem CODEX_API_KEY-t.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>Hangfelismerési backendek:</b> <code>${escapeHTML(joined)}</code>`, {
      fallbackText: `Hangfelismerési backendek: ${joined}`,
    });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet új szálat létrehozni."), {
        fallbackText: "Futó kérés közben nem lehet új szálat létrehozni.",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    if (workspaces.length <= 1) {
      try {
        const info = await session.newThread();
        updateSessionMetadata(contextKey, session);
        registry.clearHandoff(contextKey);
        await clearHandoffInboxRecord(config, contextKey);
        const label = isTopicContext(contextKey) ? "Új szál létrehozva ehhez a témához." : "Új szál létrehozva.";
        const plainText = `${label}\n\n${renderSessionInfoPlain(config, info)}`;
        const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(config, info)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: formatWorkspaceButtonLabel(config, workspace, { current: workspace === currentWorkspace }),
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>Válassz munkamappát az új szálhoz:</b>", {
      fallbackText: "Válassz munkamappát az új szálhoz:",
      replyMarkup: keyboard,
    });
  });

  bot.command("projekts", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet projektet váltani."), {
        fallbackText: "Futó kérés közben nem lehet projektet váltani.",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    if (workspaces.length <= 1) {
      try {
        const info = await session.newThread();
        updateSessionMetadata(contextKey, session);
        registry.clearHandoff(contextKey);
        await clearHandoffInboxRecord(config, contextKey);
        const label = isTopicContext(contextKey)
          ? "Az aktív projekt megerősítve ehhez a témához."
          : "Az aktív projekt megerősítve ehhez a chathez.";
        const plainText = `${label}\nProjekt: ${getWorkspaceShortName(info.workspace)}\n\n${renderSessionInfoPlain(config, info)}`;
        const html = `<b>${escapeHTML(label)}</b>\nProjekt: <code>${escapeHTML(getWorkspaceShortName(info.workspace))}</code>\n\n${renderSessionInfoHTML(config, info)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    pendingProjectWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: formatWorkspaceButtonLabel(config, workspace, { current: workspace === currentWorkspace }),
      callbackData: `proj_${index}`,
    }));
    pendingProjectWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "proj");

    await safeReply(ctx, "<b>Válassz projektet ehhez a chathez:</b>", {
      fallbackText: "Válassz projektet ehhez a chathez:",
      replyMarkup: keyboard,
    });
  });

  bot.command("abort", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    try {
      await session.abort();
      await safeReply(ctx, escapeHTML("A futó művelet megszakítva."), {
        fallbackText: "A futó művelet megszakítva.",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nincs mit újraküldeni. Előbb küldj egy üzenetet."), {
        fallbackText: "Nincs mit újraküldeni. Előbb küldj egy üzenetet.",
      });
      return;
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, cached);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Téma szál" : "Chat szál";
    const handoff = registry.getHandoff(contextKey);

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(config, info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(config, info)];
    if (handoff && handoff.status !== "none") {
      plainLines.push("", renderHandoffPlain(handoff));
      htmlLines.push("", renderHandoffHTML(handoff));
    }

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("watchdog", async (ctx) => {
    const snapshot = health.getSnapshot();
    const active = snapshot.activeRequest;
    const lines = [
      "Watchdog bridge állapot:",
      `Host: ${snapshot.host.label}`,
      `Gép: ${snapshot.host.name}\\${snapshot.host.user}`,
      `Állapot: ${snapshot.status}`,
      `PID: ${snapshot.process.pid}`,
      `Frissítve: ${snapshot.updatedAt}`,
      `Utolsó bejövő: ${snapshot.lastInboundTelegramUpdateAt ?? "(nincs)"}`,
      `Utolsó kimenő: ${snapshot.lastOutboundTelegramMessageAt ?? "(nincs)"}`,
      `Utolsó edit: ${snapshot.lastTelegramEditAt ?? "(nincs)"}`,
      active
        ? `Aktív kérés: ${active.status}, indult: ${active.startedAt}, utolsó aktivitás: ${active.lastActivityAt}`
        : "Aktív kérés: nincs",
      snapshot.lastError ? `Utolsó hiba: ${snapshot.lastError.type}: ${snapshot.lastError.message}` : "Utolsó hiba: nincs",
    ];

    await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
  });

  const sendRepoDiagnostics = async (
    ctx: Context,
    command: "git" | "repo",
    session: CodexSessionService,
  ): Promise<void> => {
    const info = session.getInfo();
    const repo = await inspectContextRepo(session);
    const lines = command === "git"
      ? ["Git állapot:", formatGitStatusPlain(repo.git)]
      : [
          "Repo diagnosztika:",
          `Workspace: ${repo.workspace}`,
          `Git repo: ${repo.git.repoRoot ?? "(nincs)"}`,
          `Főkönyvtárnak tűnik: ${repo.workspaceLooksLikeParent ? "igen" : "nem"}`,
          "",
          "AGENTS.md lánc:",
          ...(repo.agentsFiles.length > 0 ? repo.agentsFiles : ["(nincs találat)"]),
          "",
          repo.workspaceLooksLikeParent
            ? "Figyelem: ez főkönyvtárnak tűnik. Konkrét munkához használd a /projekts parancsot."
            : "Konkrét repo munkamappának tűnik.",
        ];

    await appendOperatorEvent(config, {
      command: `/${command}`,
      decision: "read-only",
      workspace: info.workspace,
      threadId: info.threadId,
      detail: {
        repoRoot: repo.git.repoRoot,
        dirty: repo.git.dirty,
        ahead: repo.git.ahead,
        behind: repo.git.behind,
      },
    }).catch(() => {});
    await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
  };

  bot.command("git", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    await sendRepoDiagnostics(ctx, "git", contextSession.session);
  });

  bot.command("repo", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    await sendRepoDiagnostics(ctx, "repo", contextSession.session);
  });

  bot.command("doctor", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    const info = session.getInfo();
    const repo = await inspectContextRepo(session);
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const snapshot = health.getSnapshot();
    const lines = [
      "Doctor állapot:",
      `Bot: ${snapshot.status}, PID ${snapshot.process.pid}`,
      `Host: ${snapshot.host.label} (${snapshot.host.name}\\${snapshot.host.user})`,
      `Codex auth: ${authStatus.authenticated ? "OK" : "nincs"} (${authStatus.method})`,
      `Workspace: ${info.workspace}`,
      `Thread ID: ${info.threadId ?? "(még nincs)"}`,
      `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})`,
      `Runtime root: ${getRuntimeRoot(config)}`,
      "",
      formatGitStatusPlain(repo.git),
      "",
      snapshot.activeRequest
        ? `Aktív kérés: ${snapshot.activeRequest.status}, ${snapshot.activeRequest.startedAt}`
        : "Aktív kérés: nincs",
      repo.workspaceLooksLikeParent
        ? "Figyelem: a workspace főkönyvtárnak tűnik. Konkrét repóhoz használd a /projekts parancsot."
        : undefined,
    ].filter((line): line is string => Boolean(line));

    await appendOperatorEvent(config, {
      command: "/doctor",
      decision: "read-only",
      workspace: info.workspace,
      threadId: info.threadId,
      detail: { repoRoot: repo.git.repoRoot, auth: authStatus.method },
    }).catch(() => {});
    await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
  });

  bot.command("notes", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    const info = session.getInfo();
    const repo = await inspectContextRepo(session);
    const notePath = await appendOperatorNote(config, "/notes", info, {
      repoRoot: repo.git.repoRoot,
      branch: repo.git.branch,
      dirty: repo.git.dirty,
      ahead: repo.git.ahead,
      behind: repo.git.behind,
      lastCommit: repo.git.lastCommit,
      followUp: repo.git.ahead > 0 ? "local commits need push from a network-enabled session" : "none recorded",
    });
    await appendOperatorEvent(config, {
      command: "/notes",
      decision: "noted",
      workspace: info.workspace,
      threadId: info.threadId,
      detail: { notePath },
    }).catch(() => {});
    const lines = [
      "Operator jegyzet elmentve a bot saját runtime mappájába.",
      `Fájl: ${notePath}`,
      `Workspace: ${info.workspace}`,
      `Repo: ${repo.git.repoRoot ?? "(nincs)"}`,
      `Utolsó commit: ${repo.git.lastCommit ?? "(nincs)"}`,
    ];
    await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
  });

  bot.command("handoff", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text("CLI/VS Code átadás", "handoff_handback")
      .row()
      .text("Thread ID", "handoff_thread")
      .row()
      .text("Másik host", "handoff_host_help")
      .row()
      .text("Attach segítség", "handoff_attach_help");
    await safeReply(ctx, "<b>Handoff menü:</b>", {
      fallbackText: "Handoff menü:",
      replyMarkup: keyboard,
    });
  });

  bot.command("commit", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó Codex kérés közben nem indítok commit-flow-t."), {
        fallbackText: "Futó Codex kérés közben nem indítok commit-flow-t.",
      });
      return;
    }

    const info = session.getInfo();
    const repo = await inspectContextRepo(session);
    if (!repo.git.isRepo || !repo.git.repoRoot) {
      await appendOperatorEvent(config, {
        command: "/commit",
        decision: "blocked",
        workspace: info.workspace,
        threadId: info.threadId,
        detail: { reason: "no_git_repo" },
      }).catch(() => {});
      await safeReply(ctx, escapeHTML("Nem git repo az aktív workspace. Válassz konkrét projektet a /projekts paranccsal."), {
        fallbackText: "Nem git repo az aktív workspace. Válassz konkrét projektet a /projekts paranccsal.",
      });
      return;
    }

    if (!repo.git.dirty) {
      await appendOperatorEvent(config, {
        command: "/commit",
        decision: "blocked",
        workspace: info.workspace,
        threadId: info.threadId,
        detail: { reason: "clean_repo", repoRoot: repo.git.repoRoot },
      }).catch(() => {});
      await safeReply(ctx, escapeHTML("Nincs commitolható változás."), { fallbackText: "Nincs commitolható változás." });
      return;
    }

    const unsafeFiles = repo.git.changedFiles.filter(isUnsafeCommitPath);
    if (unsafeFiles.length > 0) {
      const lines = [
        "Commit blokkolva: secret/config jellegű fájl szerepel a változáslistában.",
        "",
        ...unsafeFiles.map((file) => `- ${file}`),
      ];
      await appendOperatorEvent(config, {
        command: "/commit",
        decision: "blocked",
        workspace: info.workspace,
        threadId: info.threadId,
        detail: { reason: "unsafe_files", files: unsafeFiles },
      }).catch(() => {});
      await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
      return;
    }

    const message = suggestCommitMessage(repo.git);
    const nonce = randomUUID();
    pendingCommitConfirmations.set(nonce, {
      contextKey,
      repoRoot: repo.git.repoRoot,
      message,
      files: repo.git.changedFiles,
      expiresAt: Date.now() + COMMIT_CONFIRM_TTL_MS,
    });
    const keyboard = new InlineKeyboard()
      .text("Commit megerősítése", `commit_yes:${nonce}`)
      .row()
      .text("Mégse", `commit_no:${nonce}`);
    const lines = [
      "Commit előnézet:",
      `Repo: ${repo.git.repoRoot}`,
      `Branch: ${repo.git.branch ?? "(ismeretlen)"}`,
      `Fájlok: ${repo.git.changedFiles.length}`,
      `Javasolt üzenet: ${message}`,
      "",
      "Push nem fog történni.",
      "Megerősítés után build/test/diff-check/ggshield fut, majd commit készül, ha minden rendben.",
      "",
      ...repo.git.changedFiles.slice(0, 20).map((file) => `- ${file}`),
      repo.git.changedFiles.length > 20 ? `... és még ${repo.git.changedFiles.length - 20} fájl` : undefined,
    ].filter((line): line is string => Boolean(line));
    await safeReply(ctx, escapeHTML(lines.join("\n")), {
      fallbackText: lines.join("\n"),
      replyMarkup: keyboard,
    });
  });

  const requestBotControlConfirmation = async (ctx: Context, action: BotControlAction): Promise<void> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    if (isBotControlBusy(contextKey)) {
      const text = action === "restart"
        ? "Futó kérés közben nem indítom újra a botot. Várd meg, vagy használd a /abort parancsot."
        : "Futó kérés közben nem állítom le a botot. Várd meg, vagy használd a /abort parancsot.";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const nonce = randomUUID();
    const requestedBy = getRequesterLabel(ctx);
    pendingBotControlConfirmations.set(nonce, {
      action,
      contextKey,
      ...(requestedBy ? { requestedBy } : {}),
      expiresAt: Date.now() + BOT_CONTROL_CONFIRM_TTL_MS,
    });

    const keyboard = new InlineKeyboard()
      .text(action === "restart" ? "Restart megerősítése" : "Stop megerősítése", `botctl_${action}_yes:${nonce}`)
      .row()
      .text("Mégse", `botctl_${action}_no:${nonce}`);
    const lines = action === "restart"
      ? [
          "<b>Biztosan újraindítsam a botot?</b>",
          "",
          "A jelenlegi bot finoman leáll, majd a launcher újra elindítja.",
          "Codex/MCP/VS Code folyamatokat nem állít le.",
        ]
      : [
          "<b>Biztosan leállítsam a botot?</b>",
          "",
          "Csak az AttysCodexBridge bot áll le.",
          "A watchdog rövid ideig szándékos leállításként kezeli, és nem indítja vissza azonnal.",
        ];
    const plain = lines.map((line) => line.replace(/<[^>]+>/g, "")).join("\n");

    await safeReply(ctx, lines.join("\n"), {
      fallbackText: plain,
      replyMarkup: keyboard,
    });
  };

  bot.command("restart", async (ctx) => {
    await requestBotControlConfirmation(ctx, "restart");
  });

  bot.command("stop", async (ctx) => {
    await requestBotControlConfirmation(ctx, "stop");
  });

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet indítási profilt váltani."), {
        fallbackText: "Futó kérés közben nem lehet indítási profilt váltani.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Kiválasztott indítási profil:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Működés:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "Válassz profilt az új vagy újracsatolt szálakhoz:",
    ];
    const plainLines = [
      `Kiválasztott indítási profil: ${selectedLaunchProfile.label}`,
      `Működés: ${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "Válassz profilt az új vagy újracsatolt szálakhoz:",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>A kiválasztott profil danger-full-access módot használ.</i>");
      plainLines.splice(2, 0, "⚠️ A kiválasztott profil danger-full-access módot használ.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Az aktív szál még ezt használja:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Az aktív szál még ezt használja: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet visszaadni a szálat. Előbb használd a /abort parancsot."), {
        fallbackText: "Futó kérés közben nem lehet visszaadni a szálat. Előbb használd a /abort parancsot.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("Nincs aktív szál, amit vissza lehetne adni."), {
        fallbackText: "Nincs aktív szál, amit vissza lehetne adni.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "Ez a szál még nem indult el, ezért nincs folytatható thread ID. Küldj egy üzenetet a létrehozáshoz, vagy használd a /new parancsot.",
          ),
          {
            fallbackText:
              "Ez a szál még nem indult el, ezért nincs folytatható thread ID. Küldj egy üzenetet a létrehozáshoz, vagy használd a /new parancsot.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;
      const handoff: ContextHandoff = {
        status: "pending_vsc_pickup",
        workspace: info.workspace,
        threadId: info.threadId,
        sourceHost: config.hostLabel,
        targetHost: config.hostLabel,
        createdAt: new Date().toISOString(),
      };
      registry.setHandoff(contextKey, handoff);
      await appendHandoffOutboxRecord(config, {
        kind: "handback",
        contextKey,
        handoff,
        resumeCommand,
      });

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Szál visszaadva a Codex CLI-nek.",
        "",
        "Ezt futtasd a terminálban:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Parancs vágólapra másolva!" : undefined,
        "",
        "Küldj ide bármilyen üzenetet egy új AttysCodexBridge szál indításához.",
        "Ha mégis ezt folytatnád Telegramon, használd: /attach " + info.threadId,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Szál visszaadva a Codex CLI-nek.</b>",
        "",
        "Ezt futtasd a terminálban:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Parancs vágólapra másolva!</i>" : undefined,
        "",
        "Küldj ide bármilyen üzenetet egy új AttysCodexBridge szál indításához.",
        `Ha mégis ezt folytatnád Telegramon, használd: <code>/attach ${escapeHTML(info.threadId)}</code>`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("handoff_to", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet célgépre átadni a szálat."), {
        fallbackText: "Futó kérés közben nem lehet célgépre átadni a szálat.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const targetHost = rawText.replace(/^\/handoff_to(?:@\w+)?\s*/, "").trim();
    if (!targetHost) {
      await safeReply(ctx, escapeHTML("Használat: /handoff_to <host>"), {
        fallbackText: "Használat: /handoff_to <host>",
      });
      return;
    }

    const info = session.getInfo();
    if (!info.threadId) {
      await safeReply(ctx, escapeHTML("Nincs aktív thread ID, amit át lehetne adni. Előbb indíts vagy csatolj egy szálat."), {
        fallbackText: "Nincs aktív thread ID, amit át lehetne adni. Előbb indíts vagy csatolj egy szálat.",
      });
      return;
    }

    const handoff: ContextHandoff = {
      status: "pending_vsc_pickup",
      workspace: info.workspace,
      threadId: info.threadId,
      sourceHost: config.hostLabel,
      targetHost,
      createdAt: new Date().toISOString(),
    };
    registry.setHandoff(contextKey, handoff);
    await appendHandoffOutboxRecord(config, {
      kind: "handoff_to",
      contextKey,
      handoff,
      resumeCommand: `codex resume ${info.threadId}`,
    });

    const plainText = [
      `Átadás előkészítve: ${targetHost}`,
      `Workspace: ${info.workspace}`,
      `Thread ID: ${info.threadId}`,
      `Folytatás: codex resume ${info.threadId}`,
    ].join("\n");
    const html = [
      `<b>Átadás előkészítve:</b> <code>${escapeHTML(targetHost)}</code>`,
      `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
      `<b>Thread ID:</b> <code>${escapeHTML(info.threadId)}</code>`,
      `<b>Folytatás:</b> <code>codex resume ${escapeHTML(info.threadId)}</code>`,
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plainText });
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet szálat csatolni."), {
        fallbackText: "Futó kérés közben nem lehet szálat csatolni.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Használat: /attach <thread-id>"), {
        fallbackText: "Használat: /attach <thread-id>",
      });
      return;
    }

    const handoff = (await loadHandoffInboxRecord(config, contextKey)) ?? registry.getHandoff(contextKey);
    const threadRecord = getThread(threadId);
    const matchesHandoff = handoff?.threadId === threadId;
    if (!threadRecord && !matchesHandoff) {
      await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(`Ismeretlen Codex szál: ${threadId}`)}`, {
        fallbackText: `Nem sikerült: Ismeretlen Codex szál: ${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(
        threadId,
        matchesHandoff
          ? {
              workspaceOverride: handoff.workspace,
              modelOverride: handoff.model,
              preferWorkspaceOverride: true,
              ignoreStoredModel: true,
            }
          : undefined,
      );
      updateSessionMetadata(contextKey, session);
      setAttachedHandoff(contextKey, info);
      await clearHandoffInboxRecord(config, contextKey);
      const html = `<b>Szál csatolva.</b>\n\n${renderSessionInfoHTML(config, info)}`;
      const plain = `Szál csatolva.\n\n${renderSessionInfoPlain(config, info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet szálat váltani."), {
        fallbackText: "Futó kérés közben nem lehet szálat váltani.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        setAttachedHandoff(contextKey, info);
        await clearHandoffInboxRecord(config, contextKey);
        const html = `<b>Szál váltva.</b>\n\n${renderSessionInfoHTML(config, info)}`;
        const plain = `Szál váltva.\n\n${renderSessionInfoPlain(config, info)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Nem sikerült: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50);
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("Nem találtam friss szálat."), {
        fallbackText: "Nem találtam friss szálat.",
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");

    await safeReply(ctx, `<b>Friss szálak</b> (${orderedSessions.length}):\nKoppints a váltáshoz.`, {
      fallbackText: `Friss szálak (${orderedSessions.length}):\nKoppints a váltáshoz.`,
      replyMarkup: keyboard,
    });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Futó kérés közben nem lehet modellt váltani."), {
        fallbackText: "Futó kérés közben nem lehet modellt váltani.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("Nincs elérhető modell."), {
        fallbackText: "Nincs elérhető modell.",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "(alapértelmezett)";
    const modelButtons = models.map((model) => ({
      label: `${model.displayName}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Aktuális modell:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Válassz modellt az új szálakhoz:"].join("\n"),
      {
        fallbackText: [`Aktuális modell: ${currentModel}`, "", "Válassz modellt az új szálakhoz:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>Reasoning effort:</b> <code>${escapeHTML(current)}</code>\n\nVálassz értéket az új szálakhoz:`
      : "<b>Reasoning effort:</b> nincs beállítva (modell alapértéke)\n\nVálassz értéket az új szálakhoz:";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^botctl_(restart|stop)_(yes|no):(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1] as BotControlAction | undefined;
    const decision = ctx.match?.[2];
    const nonce = ctx.match?.[3];
    const contextKey = contextKeyFromCtx(ctx);

    if (!chatId || !messageId || !action || !decision || !nonce || !contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const pending = pendingBotControlConfirmations.get(nonce);
    if (!pending || pending.action !== action || pending.contextKey !== contextKey || pending.expiresAt < Date.now()) {
      pendingBotControlConfirmations.delete(nonce);
      await ctx.answerCallbackQuery({ text: "A megerősítés lejárt" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML("A megerősítés lejárt. Futtasd újra a parancsot."), {
        fallbackText: "A megerősítés lejárt. Futtasd újra a parancsot.",
      });
      return;
    }

    pendingBotControlConfirmations.delete(nonce);
    if (decision === "no") {
      await ctx.answerCallbackQuery({ text: "Mégse" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML("Mégse. Nem változott semmi."), {
        fallbackText: "Mégse. Nem változott semmi.",
      });
      return;
    }

    if (isBotControlBusy(contextKey)) {
      const text = "Közben elindult egy kérés, ezért nem állítom le a botot. Várd meg, vagy használd a /abort parancsot.";
      await ctx.answerCallbackQuery({ text: "Futó kérés van" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML(text), { fallbackText: text });
      return;
    }

    try {
      await writeBotControlRequest(config, action, pending.requestedBy);
      if (action === "restart") {
        scheduleBotRestart();
      }

      const text = action === "restart"
        ? "Restart indul. A bot pár másodpercre elhallgat, majd visszatér."
        : "Stop indul. Csak az AttysCodexBridge bot áll le.";
      await ctx.answerCallbackQuery({ text: action === "restart" ? "Restart indul" : "Stop indul" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML(text), { fallbackText: text });
      requestGracefulBotShutdown();
    } catch (error) {
      const message = `Nem sikerült elindítani a műveletet: ${friendlyErrorText(error)}`;
      await ctx.answerCallbackQuery({ text: "Nem sikerült" });
      await safeEditMessage(bot, chatId, messageId, `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: message,
      });
    }
  });

  bot.callbackQuery(/^commit_(yes|no):(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const decision = ctx.match?.[1];
    const nonce = ctx.match?.[2];
    const contextKey = contextKeyFromCtx(ctx);

    if (!chatId || !messageId || !decision || !nonce || !contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const pending = pendingCommitConfirmations.get(nonce);
    if (!pending || pending.contextKey !== contextKey || pending.expiresAt < Date.now()) {
      pendingCommitConfirmations.delete(nonce);
      await ctx.answerCallbackQuery({ text: "A commit megerősítés lejárt" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML("A commit megerősítés lejárt. Futtasd újra: /commit"), {
        fallbackText: "A commit megerősítés lejárt. Futtasd újra: /commit",
      });
      return;
    }

    pendingCommitConfirmations.delete(nonce);
    if (decision === "no") {
      await ctx.answerCallbackQuery({ text: "Mégse" });
      await appendOperatorEvent(config, {
        command: "/commit",
        decision: "blocked",
        workspace: pending.repoRoot,
        detail: { reason: "cancelled" },
      }).catch(() => {});
      await safeEditMessage(bot, chatId, messageId, escapeHTML("Mégse. Commit nem készült."), {
        fallbackText: "Mégse. Commit nem készült.",
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Ellenőrzések indulnak..." });
    await safeEditMessage(
      bot,
      chatId,
      messageId,
      escapeHTML("Ellenőrzések futnak. Push nem fog történni."),
      { fallbackText: "Ellenőrzések futnak. Push nem fog történni." },
    );

    try {
      const checks = await runCommitChecks(pending.repoRoot);
      if (!checks.ok) {
        const lines = [
          "Commit blokkolva, mert legalább egy ellenőrzés hibázott:",
          "",
          ...checks.checks.map((check) => `- ${check.name}: ${check.status} (${trimLine(check.detail, 160)})`),
        ];
        await appendOperatorEvent(config, {
          command: "/commit",
          decision: "blocked",
          workspace: pending.repoRoot,
          detail: { reason: "checks_failed", checks: checks.checks.map((check) => ({ name: check.name, status: check.status })) },
        }).catch(() => {});
        await safeEditMessage(bot, chatId, messageId, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
        return;
      }

      const commit = await createCommit(pending.repoRoot, pending.message, pending.files);
      const lines = [
        "Commit elkészült. Push nem történt.",
        "",
        commit,
        "",
        "Ellenőrzések:",
        ...checks.checks.map((check) => `- ${check.name}: ${check.status}`),
      ];
      await appendOperatorEvent(config, {
        command: "/commit",
        decision: "commit-created",
        workspace: pending.repoRoot,
        detail: { commit, files: pending.files.length },
      }).catch(() => {});
      await safeEditMessage(bot, chatId, messageId, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
    } catch (error) {
      const message = `Commit-flow hiba: ${friendlyErrorText(error)}`;
      await appendOperatorEvent(config, {
        command: "/commit",
        decision: "failed",
        workspace: pending.repoRoot,
        detail: { error: friendlyErrorText(error) },
      }).catch(() => {});
      await safeEditMessage(bot, chatId, messageId, `<b>Nem sikerült:</b> ${escapeHTML(message)}`, {
        fallbackText: message,
      });
    }
  });

  bot.callbackQuery(/^handoff_(handback|thread|host_help|attach_help)$/, async (ctx) => {
    const action = ctx.match?.[1];
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !action) {
      await ctx.answerCallbackQuery();
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    if (action === "thread") {
      await ctx.answerCallbackQuery({ text: "Thread ID" });
      const lines = [
        "Aktuális thread:",
        `Thread ID: ${info.threadId ?? "(még nincs)"}`,
        `Workspace: ${info.workspace}`,
      ];
      await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
      return;
    }

    if (action === "host_help") {
      await ctx.answerCallbackQuery({ text: "Másik host" });
      await safeReply(ctx, escapeHTML("Másik hostra átadás: /handoff_to <host>"), {
        fallbackText: "Másik hostra átadás: /handoff_to <host>",
      });
      return;
    }

    if (action === "attach_help") {
      await ctx.answerCallbackQuery({ text: "Attach" });
      await safeReply(ctx, escapeHTML("Attach használat: /attach <thread-id>"), {
        fallbackText: "Attach használat: /attach <thread-id>",
      });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    if (!session.hasActiveThread() || !info.threadId) {
      await ctx.answerCallbackQuery({ text: "Nincs aktív thread" });
      await safeReply(ctx, escapeHTML("Nincs aktív thread ID, amit át lehetne adni."), {
        fallbackText: "Nincs aktív thread ID, amit át lehetne adni.",
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Átadás..." });
    const handedBack = session.handback();
    updateSessionMetadata(contextKey, session);
    const threadId = handedBack.threadId ?? info.threadId;
    const workspace = handedBack.workspace;
    const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    const resumeCommand = `cd ${shellEscape(workspace)} && codex resume ${shellEscape(threadId)}`;
    const handoff: ContextHandoff = {
      status: "pending_vsc_pickup",
      workspace,
      threadId,
      sourceHost: config.hostLabel,
      targetHost: config.hostLabel,
      createdAt: new Date().toISOString(),
    };
    registry.setHandoff(contextKey, handoff);
    await appendHandoffOutboxRecord(config, {
      kind: "handback",
      contextKey,
      handoff,
      resumeCommand,
    });
    const lines = [
      "Szál visszaadva a Codex CLI-nek.",
      "",
      "Ezt futtasd a terminálban:",
      resumeCommand,
      "",
      `Ha mégis Telegramon folytatnád: /attach ${threadId}`,
    ];
    await safeReply(ctx, escapeHTML(lines.join("\n")), { fallbackText: lines.join("\n") });
  });

  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Lejárt, futtasd újra: /sessions");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Lejárt, futtasd újra: /new");
  handlePageCallback(/^proj_page_(\d+)$/, "proj", pendingProjectWorkspaceButtons, "Lejárt, futtasd újra: /projekts");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Lejárt, futtasd újra: ${LAUNCH_PROFILES_COMMAND}`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Lejárt, futtasd újra: /model");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Lejárt, futtasd újra: /effort");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nincs mit megszakítani" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Megszakítás..." });
    await session.abort();
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "A szállista lejárt, futtasd újra: /sessions" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Váltás..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      setAttachedHandoff(contextKey, info);
      await clearHandoffInboxRecord(config, contextKey);
      const plainText = `Szál váltva.\n\n${renderSessionInfoPlain(config, info)}`;
      const html = `<b>Szál váltva.</b>\n\n${renderSessionInfoHTML(config, info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Nem sikerült: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Lejárt, futtasd újra: /new" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Szál létrehozása..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      registry.clearHandoff(contextKey);
      await clearHandoffInboxRecord(config, contextKey);
      const label = isTopicContext(contextKey) ? "Új szál létrehozva ehhez a témához." : "Új szál létrehozva.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(config, info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(config, info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Nem sikerült: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^proj_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingProjectWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Lejárt, futtasd újra: /projekts" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Projekt váltása..." });
    pendingProjectWorkspacePicks.delete(contextKey);
    pendingProjectWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      registry.clearHandoff(contextKey);
      await clearHandoffInboxRecord(config, contextKey);
      const label = isTopicContext(contextKey)
        ? "Az aktív projekt megváltozott ennél a témánál."
        : "Az aktív projekt megváltozott ennél a chatnél.";
      const projectLabel = getWorkspaceShortName(workspace);
      const plainText = `${label}\nProjekt: ${projectLabel}\n\n${renderSessionInfoPlain(config, info)}`;
      const html = `<b>${escapeHTML(label)}</b>\nProjekt: <code>${escapeHTML(projectLabel)}</code>\n\n${renderSessionInfoHTML(config, info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Nem sikerült: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Lejárt, futtasd újra: ${LAUNCH_PROFILES_COMMAND}` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Az indítási profil már nem létezik" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "danger-full-access megerősítés szükséges" });
      const confirmKeyboard = new InlineKeyboard()
        .text("danger-full-access engedélyezése", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Mégse", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Indítási profil megerősítése:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Működés:</b> <code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>Ez a profil danger-full-access módot használ.</b>",
        "Az új vagy újracsatolt szálakra fog érvényesülni ebben a Telegram kontextusban.",
      ].join("\n");
      const plain = [
        `Indítási profil megerősítése: ${profile.label}`,
        `Működés: ${formatLaunchProfileBehavior(profile)}`,
        "",
        "FIGYELEM: Ez a profil danger-full-access módot használ.",
        "Az új vagy újracsatolt szálakra fog érvényesülni ebben a Telegram kontextusban.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Indítási profil beállítva: ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Indítási profil beállítva:</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Működés:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "Az új vagy újracsatolt szálakra érvényes.",
    ].join("\n");
    const plain = [
      `Indítási profil beállítva: ${selectedProfile.label}`,
      `Működés: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "Az új vagy újracsatolt szálakra érvényes.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Lejárt, futtasd újra: ${LAUNCH_PROFILES_COMMAND}` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Mégsem" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Indítási profil váltása megszakítva.</b>\n\nMásik profil választásához futtasd újra: ${LAUNCH_PROFILES_COMMAND}`,
        {
          fallbackText: `Indítási profil váltása megszakítva.\n\nMásik profil választásához futtasd újra: ${LAUNCH_PROFILES_COMMAND}`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Az indítási profil már nem létezik" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Az indítási profil lejárt.</b>\n\nFuttasd újra: ${LAUNCH_PROFILES_COMMAND}`,
        {
          fallbackText: `Az indítási profil lejárt.\n\nFuttasd újra: ${LAUNCH_PROFILES_COMMAND}`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `Indítási profil beállítva: ${selectedProfile.label}` });

    const html = [
      `<b>Indítási profil beállítva:</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Működés:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "⚠️ <i>danger-full-access megerősítve az új vagy újracsatolt szálakhoz.</i>",
    ].join("\n");
    const plain = [
      `Indítási profil beállítva: ${selectedProfile.label}`,
      `Működés: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "danger-full-access megerősítve az új vagy újracsatolt szálakhoz.",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Lejárt, futtasd újra: /model" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Lejárt, futtasd újra: /model" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Várd meg a futó kérést" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Modell beállítása..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Modell beállítva:</b> <code>${escapeHTML(model)}</code> — az új szálakra érvényes.`;
      const plainText = `Modell beállítva: ${model} — az új szálakra érvényes.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Nem sikerült:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Nem sikerült: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as ModelReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Lejárt, futtasd újra: /effort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort beállítva: ${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Reasoning effort beállítva: <code>${escapeHTML(effort)}</code> — az új szálakra érvényes.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Reasoning effort beállítva: ${effort} — az új szálakra érvényes.`,
    });
  });

  bot.hears(/^\/(?:azzach|atach|attch|attac|atatch|attache)(?:@\w+)?(?:\s|$)/i, async (ctx) => {
    await safeReply(ctx, escapeHTML("Attach parancsra gondoltál? Használat: /attach <thread-id>"), {
      fallbackText: "Attach parancsra gondoltál? Használat: /attach <thread-id>",
    });
  });

  bot.on("message:text", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (await blockPromptForPendingHandoff(ctx, contextKey, session)) {
      return;
    }

    lastPromptInput.set(contextKey, userText);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (await blockPromptForPendingHandoff(ctx, contextKey, session)) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Az átírás üres lett. Próbáld újra, vagy küldj inkább szöveget."), {
          fallbackText: "Az átírás üres lett. Próbáld újra, vagy küldj inkább szöveget.",
        });
        return;
      }

      const preview = trimLine(transcript.replace(/\s+/g, " "), 100);
      await safeReply(
        ctx,
        `🎙️ <b>Átírva:</b> ${escapeHTML(preview)} <i>(${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎙️ Átírva: ${preview} (${result.backend})` },
      );
    } catch (error) {
      const note = "Megjegyzés: a hangfelismerés OPENAI_API_KEY-t használ, nem CODEX_API_KEY-t.";
      await safeReply(ctx, `<b>Az átírás nem sikerült:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Az átírás nem sikerült:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    lastPromptInput.set(contextKey, transcript);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, transcript);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (await blockPromptForPendingHandoff(ctx, contextKey, session)) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Nem sikerült letölteni a fotót:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Nem sikerült letölteni a fotót: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      await unlink(tempFilePath).catch(() => {});
    }
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (await blockPromptForPendingHandoff(ctx, contextKey, session)) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>Túl nagy fájl</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `Túl nagy fájl (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Nem sikerült letölteni a fájlt:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Nem sikerült letölteni a fájlt: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        stateDir: config.stateDir,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Nem sikerült előkészíteni a fájlt:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Nem sikerült előkészíteni a fájlt: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Megérkezett:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Megérkezett: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(config.stateDir, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      try {
        await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
      } catch (artifactError) {
        console.error("Failed to deliver artifacts:", artifactError);
      } finally {
        await cleanupInbox(config.stateDir, turnId);
        // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
      }
    }
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Üdvözlés és állapot" },
    { command: "help", description: "Parancslista" },
    { command: "new", description: "Új szál indítása" },
    { command: "projekts", description: "Projekt választása ehhez a chathez" },
    { command: "session", description: "Aktuális szál adatai" },
    { command: "doctor", description: "Bot, auth, repo és watchdog állapot" },
    { command: "git", description: "Aktuális repo git állapota" },
    { command: "repo", description: "Workspace, repo és AGENTS.md lánc" },
    { command: "sessions", description: "Szálak böngészése és váltása" },
    { command: "retry", description: "Utolsó kérés újraküldése" },
    { command: "abort", description: "Futó művelet megszakítása" },
    { command: "launch_profiles", description: "Indítási profil kiválasztása" },
    { command: "model", description: "Modell megtekintése és váltása" },
    { command: "effort", description: "Reasoning effort beállítása" },
    { command: "auth", description: "Hitelesítési állapot" },
    { command: "login", description: "Bejelentkezés indítása" },
    { command: "logout", description: "Kijelentkezés" },
    { command: "voice", description: "Hangfelismerés állapota" },
    { command: "watchdog", description: "Bridge állapotkép" },
    { command: "notes", description: "Bot-saját operator jegyzet mentése" },
    { command: "commit", description: "Biztonságos commit-flow push nélkül" },
    { command: "restart", description: "Bot finom újraindítása megerősítéssel" },
    { command: "stop", description: "Bot leállítása megerősítéssel" },
    { command: "handoff", description: "Handoff menü" },
    { command: "handback", description: "Szál visszaadása Codex CLI-nek" },
    { command: "handoff_to", description: "Szál átadása célgépnek" },
    { command: "attach", description: "Codex szál csatolása ehhez a témához" },
    { command: "switch", description: "Váltás thread ID alapján" },
  ]);
}

function renderHostInfoPlain(config: TeleCodexConfig): string {
  return `Host: ${config.hostLabel} (${config.hostName}\\${config.userName})`;
}

function renderHostInfoHTML(config: TeleCodexConfig): string {
  return `<b>Host:</b> <code>${escapeHTML(config.hostLabel)}</code> <code>(${escapeHTML(`${config.hostName}\\${config.userName}`)})</code>`;
}

function renderSessionInfoPlain(config: TeleCodexConfig, info: CodexSessionInfo): string {
  return [
    renderHostInfoPlain(config),
    `Thread ID: ${info.threadId ?? "(még nincs elindítva)"}`,
    `Workspace: ${info.workspace}`,
    `Indítási profil: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Következő indítási profil: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    info.model ? `Modell: ${info.model}` : undefined,
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(config: TeleCodexConfig, info: CodexSessionInfo): string {
  return [
    renderHostInfoHTML(config),
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(még nincs elindítva)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Indítási profil:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Indítási működés:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Következő indítási profil:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>Modell:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.sessionTokens ? `<b>Session tokenek:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderHandoffPlain(handoff: ContextHandoff): string {
  return [
    `Átadás állapot: ${formatHandoffStatus(handoff.status)}`,
    `Átadás workspace: ${handoff.workspace}`,
    handoff.threadId ? `Átadás thread ID: ${handoff.threadId}` : undefined,
    handoff.model ? `Átadás modell: ${handoff.model}` : undefined,
    handoff.sourceHost ? `Forrás host: ${handoff.sourceHost}` : undefined,
    handoff.targetHost ? `Cél host: ${handoff.targetHost}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderHandoffHTML(handoff: ContextHandoff): string {
  return [
    `<b>Átadás állapot:</b> <code>${escapeHTML(formatHandoffStatus(handoff.status))}</code>`,
    `<b>Átadás workspace:</b> <code>${escapeHTML(handoff.workspace)}</code>`,
    handoff.threadId ? `<b>Átadás thread ID:</b> <code>${escapeHTML(handoff.threadId)}</code>` : undefined,
    handoff.model ? `<b>Átadás modell:</b> <code>${escapeHTML(handoff.model)}</code>` : undefined,
    handoff.sourceHost ? `<b>Forrás host:</b> <code>${escapeHTML(handoff.sourceHost)}</code>` : undefined,
    handoff.targetHost ? `<b>Cél host:</b> <code>${escapeHTML(handoff.targetHost)}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderPendingHandoffPlain(handoff: ContextHandoff): string {
  return [
    "Átadás vár megerősítésre.",
    renderHandoffPlain(handoff),
    "",
    handoff.threadId ? `Folytatás Telegramon: /attach ${handoff.threadId}` : "Folytatás Telegramon: /attach <thread-id>",
    "Új szál indítása: /new",
  ].join("\n");
}

export function renderPendingHandoffHTML(handoff: ContextHandoff): string {
  const attachCommand = handoff.threadId ? `/attach ${handoff.threadId}` : "/attach <thread-id>";
  return [
    "<b>Átadás vár megerősítésre.</b>",
    renderHandoffHTML(handoff),
    "",
    `Folytatás Telegramon: <code>${escapeHTML(attachCommand)}</code>`,
    "Új szál indítása: <code>/new</code>",
  ].join("\n");
}

export function renderDirectResumeWarningPlain(
  handoff: ContextHandoff,
  warning: DirectResumeWarning,
): string {
  return [
    "Az átadott VSC/Codex szál túl nagy az automatikus Telegram-folytatáshoz.",
    renderHandoffPlain(handoff),
    `Session fájl méret: ${formatBytes(warning.sizeBytes)} (küszöb: ${formatBytes(warning.maxBytes)})`,
    "",
    "A bot ezért nem indított vakon direkt resume-ot.",
    handoff.threadId ? `Ha mégis direkt folytatod: /attach ${handoff.threadId}` : "Ha mégis direkt folytatod: /attach <thread-id>",
    "Biztonságosabb új szál: /new",
  ].join("\n");
}

export function renderDirectResumeWarningHTML(
  handoff: ContextHandoff,
  warning: DirectResumeWarning,
): string {
  const attachCommand = handoff.threadId ? `/attach ${handoff.threadId}` : "/attach <thread-id>";
  return [
    "<b>Az átadott VSC/Codex szál túl nagy az automatikus Telegram-folytatáshoz.</b>",
    renderHandoffHTML(handoff),
    `<b>Session fájl méret:</b> <code>${escapeHTML(formatBytes(warning.sizeBytes))}</code> <i>(küszöb: ${escapeHTML(formatBytes(warning.maxBytes))})</i>`,
    "",
    "A bot ezért nem indított vakon direkt resume-ot.",
    `Ha mégis direkt folytatod: <code>${escapeHTML(attachCommand)}</code>`,
    "Biztonságosabb új szál: <code>/new</code>",
  ].join("\n");
}

export function shouldBlockPromptForHandoff(handoff?: ContextHandoff): boolean {
  return Boolean(handoff && handoff.status !== "none" && handoff.status !== "attached");
}

export function getDirectResumeWarning(
  config: Pick<TeleCodexConfig, "vscHandoffDirectResumeMaxSessionBytes">,
  handoff: ContextHandoff,
): DirectResumeWarning | undefined {
  if (handoff.status !== "attached" || !handoff.threadId || handoff.sourceHost !== "vsc") {
    return undefined;
  }

  const sessionFile = findCodexSessionFile(handoff.threadId);
  if (!sessionFile || sessionFile.sizeBytes <= config.vscHandoffDirectResumeMaxSessionBytes) {
    return undefined;
  }

  return {
    sessionPath: sessionFile.path,
    sizeBytes: sessionFile.sizeBytes,
    maxBytes: config.vscHandoffDirectResumeMaxSessionBytes,
  };
}

function formatHandoffStatus(status: ContextHandoff["status"]): string {
  switch (status) {
    case "pending_inbound":
      return "bejövő átvétel függőben";
    case "attached":
      return "csatolva";
    case "pending_vsc_pickup":
      return "VSC átvétel függőben";
    case "none":
    default:
      return "nincs";
  }
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

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Indítás: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Indítás:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Fut:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Fut: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Használt eszközök: ${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Terv</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokenek: ${formatSessionTokensValue(tokens)}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  const replyToMessageId = options.replyToMessageId ?? resolveReplyToMessageId(ctx);

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
      replyToMessageId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";
  const timeoutMs = options.timeoutMs ?? resolveTelegramApiTimeoutMs();
  const replyParameters = buildReplyParameters(options.replyToMessageId);

  try {
    return await withTimeout(
      api.sendMessage(chatId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        reply_markup: options.replyMarkup,
      }),
      timeoutMs,
      "Telegram sendMessage timed out",
    );
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await withTimeout(
        api.sendMessage(chatId, options.fallbackText, {
          ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
          ...(replyParameters ? { reply_parameters: replyParameters } : {}),
          reply_markup: options.replyMarkup,
        }),
        timeoutMs,
        "Telegram fallback sendMessage timed out",
      );
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";
  const timeoutMs = options.timeoutMs ?? resolveTelegramApiTimeoutMs();

  try {
    await withTimeout(
      bot.api.editMessageText(chatId, messageId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        reply_markup: options.replyMarkup,
      }),
      timeoutMs,
      "Telegram editMessageText timed out",
    );
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await withTimeout(
        bot.api.editMessageText(chatId, messageId, options.fallbackText, {
          reply_markup: options.replyMarkup,
        }),
        timeoutMs,
        "Telegram fallback editMessageText timed out",
      );
      return;
    }

    throw error;
  }
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

export function resolveReplyToMessageId(ctx: Context, explicitReplyToMessageId?: number): number | undefined {
  return explicitReplyToMessageId ?? ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;
}

export function buildReplyParameters(replyToMessageId?: number): { message_id: number } | undefined {
  if (!replyToMessageId) {
    return undefined;
  }

  return { message_id: replyToMessageId };
}

async function appendHandoffOutboxRecord(
  config: TeleCodexConfig,
  record: {
    kind: "handback" | "handoff_to";
    contextKey: TelegramContextKey;
    handoff: ContextHandoff;
    resumeCommand: string;
  },
): Promise<void> {
  await mkdir(config.stateDir, { recursive: true });
  const outboxPathname = path.join(config.stateDir, "handoff-outbox.jsonl");
  const line = JSON.stringify({
    schemaVersion: 1,
    at: new Date().toISOString(),
    host: {
      label: config.hostLabel,
      name: config.hostName,
      user: config.userName,
    },
    ...record,
  });
  await appendFile(outboxPathname, `${line}\n`, "utf8");
}

async function loadHandoffInboxRecord(
  config: TeleCodexConfig,
  contextKey: TelegramContextKey,
): Promise<ContextHandoff | undefined> {
  const inboxPathname = path.join(config.stateDir, "handoff-inbox.json");
  try {
    const raw = await readFile(inboxPathname, "utf8");
    return findHandoffInboxRecord(raw, contextKey);
  } catch {
    return undefined;
  }
}

async function clearHandoffInboxRecord(config: TeleCodexConfig, contextKey: TelegramContextKey): Promise<void> {
  const inboxPathname = path.join(config.stateDir, "handoff-inbox.json");
  let raw: string;
  try {
    raw = await readFile(inboxPathname, "utf8");
  } catch {
    return;
  }

  try {
    await writeFile(inboxPathname, removeHandoffInboxRecord(raw, contextKey), "utf8");
  } catch {
    return;
  }
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveTelegramApiTimeoutMs(): number {
  const parsed = Number(process.env.TELEGRAM_API_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TELEGRAM_API_TIMEOUT_MS;
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsafeCommitPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return true;
  }
  return normalized.includes("/.telecodex/") || normalized.startsWith(".telecodex/");
}
