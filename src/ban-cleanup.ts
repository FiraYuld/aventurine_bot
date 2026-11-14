import type { User } from "grammy/types";
import { escapeHtml } from "./logger.js";

/**
 * Everything that should happen once a user is banned, no matter who banned them
 * (our button, Iris, a manual ban in Telegram, the reaction autoban):
 *   1. ban in the discussion chat with revoke_messages (deletes their messages),
 *   2. ban in the channel,
 *   3. remove all their reactions in the chat,
 *   4. delete the "… joined the group" service message,
 *   5. mark the join-log entry as banned (and drop its button).
 * Every step is best effort; failures are collected and returned.
 */

/** Telegram allows deleting messages only within 48 h, so there is no point keeping ids longer. */
export const JOIN_MESSAGE_TTL_SEC = 48 * 60 * 60;
export const JOIN_LOG_TTL_SEC = 14 * 24 * 60 * 60;
/** Our own bans fire chat_member "kicked" updates again; run the cleanup once per burst. */
export const CLEANUP_DEDUPE_TTL_SEC = 120;

export interface CleanupApi {
  banChatMember(chatId: number, userId: number, other?: { revoke_messages?: boolean }): Promise<unknown>;
  deleteAllMessageReactionsUser(chatId: number, userId: number): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface CleanupStore {
  /** true if this call took the dedupe slot (cleanup should run). */
  claimCleanup(userId: number): Promise<boolean>;
  getJoinMessageIds(userId: number): Promise<number[]>;
  clearJoinMessageIds(userId: number): Promise<void>;
  getJoinLog(userId: number): Promise<{ messageId: number; html: string } | null>;
}

export interface CleanupTargets {
  chatId: number;
  channelId: number;
  moderationChatId: number;
}

export interface CleanupResult {
  ran: boolean;
  errors: string[];
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "description" in err) {
    return String((err as { description: unknown }).description);
  }
  return err instanceof Error ? err.message : String(err);
}

export function bannedFooterHtml(by?: User): string {
  if (!by) return "🔨 <b>Забанен</b>: удалён из чата и канала, сообщения и реакции удалены.";
  const name = [by.first_name, by.last_name].filter(Boolean).join(" ").trim() || "модератор";
  return `🔨 <b>Забанен</b> (${escapeHtml(name)}): удалён из чата и канала, сообщения и реакции удалены.`;
}

export async function runBanCleanup(
  deps: { api: CleanupApi; store: CleanupStore; targets: CleanupTargets },
  userId: number,
  by?: User,
): Promise<CleanupResult> {
  const { api, store, targets } = deps;

  let claimed = true;
  try {
    claimed = await store.claimCleanup(userId);
  } catch (err) {
    console.error("[ban-cleanup] dedupe failed, running anyway", err);
  }
  if (!claimed) return { ran: false, errors: [] };

  const errors: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${errText(err)}`);
    }
  };

  await step("бан в чате", () =>
    api.banChatMember(targets.chatId, userId, { revoke_messages: true }),
  );
  await step("бан в канале", () => api.banChatMember(targets.channelId, userId));
  await step("реакции", () => api.deleteAllMessageReactionsUser(targets.chatId, userId));

  let joinIds: number[] = [];
  await step("чтение id сообщения о входе", async () => {
    joinIds = await store.getJoinMessageIds(userId);
  });
  for (const id of joinIds) {
    await step(`сообщение о входе ${id}`, () => api.deleteMessage(targets.chatId, id));
  }
  if (joinIds.length > 0) await store.clearJoinMessageIds(userId).catch(() => {});

  await step("запись журнала", async () => {
    const entry = await store.getJoinLog(userId);
    if (!entry) return;
    await api.editMessageText(
      targets.moderationChatId,
      entry.messageId,
      `${entry.html}\n\n${bannedFooterHtml(by)}`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      },
    );
  });

  return { ran: true, errors };
}
