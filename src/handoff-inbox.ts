import type { TelegramContextKey } from "./context-key.js";
import type { ContextHandoff } from "./session-registry.js";

type HandoffInboxMap = Record<string, unknown>;

export function findHandoffInboxRecord(
  raw: string,
  contextKey: TelegramContextKey,
  nowMs = Date.now(),
): ContextHandoff | undefined {
  const entry = parseHandoffInbox(raw).find((candidate) => candidate.contextKey === contextKey);
  if (!entry || isExpired(entry.handoff, nowMs)) {
    return undefined;
  }

  return entry.handoff;
}

export function removeHandoffInboxRecord(raw: string, contextKey: TelegramContextKey): string {
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) {
    const remaining = parsed.filter((entry) =>
      !entry ||
      typeof entry !== "object" ||
      (entry as { contextKey?: unknown }).contextKey !== contextKey,
    );
    return `${JSON.stringify(remaining, null, 2)}\n`;
  }

  if (parsed && typeof parsed === "object") {
    const next = { ...(parsed as HandoffInboxMap) };
    delete next[contextKey];
    return `${JSON.stringify(next, null, 2)}\n`;
  }

  return "{}\n";
}

export function upsertHandoffInboxRecord(
  raw: string | undefined,
  contextKey: TelegramContextKey,
  handoff: ContextHandoff,
): string {
  const parsed = raw ? parseJson(raw) : undefined;
  const next = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as HandoffInboxMap) }
    : {};

  next[contextKey] = handoff;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function parseHandoffInbox(raw: string): Array<{ contextKey: TelegramContextKey; handoff: ContextHandoff }> {
  const parsed = parseJson(raw);
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Object.entries(parsed as HandoffInboxMap).map(([key, value]) => ({
          contextKey: key,
          handoff: value,
        }))
      : [];

  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }

    const contextKey = (candidate as { contextKey?: unknown }).contextKey;
    if (typeof contextKey !== "string" || !contextKey) {
      return [];
    }

    const handoffCandidate = (candidate as { handoff?: unknown }).handoff;
    const handoff = handoffCandidate && typeof handoffCandidate === "object"
      ? handoffCandidate
      : candidate;

    if (!isContextHandoff(handoff)) {
      return [];
    }

    return [{ contextKey, handoff }];
  });
}

export function isContextHandoff(value: unknown): value is ContextHandoff {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ContextHandoff>;
  return (
    (candidate.status === "none" ||
      candidate.status === "pending_inbound" ||
      candidate.status === "attached" ||
      candidate.status === "pending_vsc_pickup") &&
    typeof candidate.workspace === "string" &&
    (typeof candidate.threadId === "string" || candidate.threadId === null) &&
    (candidate.model === undefined || typeof candidate.model === "string") &&
    typeof candidate.createdAt === "string"
  );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isExpired(handoff: ContextHandoff, nowMs: number): boolean {
  return Boolean(handoff.expiresAt && Date.parse(handoff.expiresAt) <= nowMs);
}
