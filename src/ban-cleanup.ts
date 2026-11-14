import { InlineKeyboard } from "grammy";
import type { User } from "grammy/types";
import { escapeHtml } from "./logger.js";

/**
 * What happens after a user is banned (join-log button, Iris, a manual ban in Telegram).
 *
 * Step 1 — automatic, reversible by an unban:
 *   ban in the discussion chat and in the channel (no message deletion),
 *   delete the "… joined the group" service message (not the user's own content),
 *   mark the join-log entry (or post a small card) with a "🧹 wipe" button.
 *
 * Step 2 — only after a moderator presses that button (irreversible):
 *   delete all their messages in the chat (re-ban with revoke_messages) and all reactions.
 *
 * A real person banned by mistake or as a joke keeps their messages unless someone
 * explicitly confirms the wipe.
 */

/** Telegram allows deleting messages only within 48 h, so there is no point keeping ids longer. */
export const JOIN_MESSAGE_TTL_SEC = 48 * 60 * 60;
export const JOIN_LOG_TTL_SEC = 14 * 24 * 60 * 60;
/** Our own bans fire chat_member "kicked" updates again; run the follow-up once per burst. */
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
  sendMessage(chatId: number, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
}

export interface JoinLogEntry {
  messageId: number;
  html: string;
}

export interface CleanupStore {
  /** true if this call took the dedupe slot (follow-up should run). */
  claimCleanup(userId: number): Promise<boolean>;
  getJoinMessageIds(userId: number): Promise<number[]>;
  clearJoinMessageIds(userId: number): Promise<void>;
  getJoinLog(userId: number): Promise<JoinLogEntry | null>;
  setJoinLog(userId: number, entry: JoinLogEntry): Promise<void>;
}

export interface CleanupTargets {
  chatId: number;
  channelId: number;
  moderationChatId: number;
}

export interface CleanupDeps {
  api: CleanupApi;
  store: CleanupStore;
  targets: CleanupTargets;
}

export interface StepResult {
  ran: boolean;
  errors: string[];
}

/** callback_data of the wipe button: `j:w:<userId>`. */
export function wipeCallbackData(userId: number): string {
  return `j:w:${userId}`;
}

export function parseWipeCallback(data: string): number | null {
  const m = /^j:w:(\d+)$/.exec(data);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function wipeKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard().text("🧹 Удалить сообщения и реакции", wipeCallbackData(userId));
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "description" in err) {
    return String((err as { description: unknown }).description);
  }
  return err instanceof Error ? err.message : String(err);
}

function whoHtml(by?: User): string {
  if (!by) return "";
  const name = [by.first_name, by.last_name].filter(Boolean).join(" ").trim() || "модератор";
  return ` (${escapeHtml(name)})`;
}

const NOT_WIPED_LINE = "Сообщения и реакции не тронуты — удалить можно кнопкой ниже.";

export function bannedFooterHtml(by?: User): string {
  return `🔨 <b>Забанен</b>${whoHtml(by)}: удалён из чата и канала.\n${NOT_WIPED_LINE}`;
}

export function wipedFooterHtml(by?: User): string {
  return `🧹 <b>Сообщения и реакции удалены</b>${whoHtml(by)}.`;
}

export function banCardHtml(userId: number, user?: User): string {
  const name = user
    ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "(без имени)"
    : "пользователь";
  const handle = user?.username ? ` · @${escapeHtml(user.username)}` : "";
  return `👤 <a href="tg://user?id=${userId}">${escapeHtml(name)}</a>${handle} · ID <code>${userId}</code>`;
}

async function runSteps(): Promise<{
  errors: string[];
  step: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}> {
  const errors: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${errText(err)}`);
    }
  };
  return { errors, step };
}

/** Step 1: reversible follow-up after a ban. Never deletes the user's own content. */
export async function runBanFollowUp(
  deps: CleanupDeps,
  userId: number,
  opts: { by?: User; user?: User } = {},
): Promise<StepResult> {
  const { api, store, targets } = deps;

  let claimed = true;
  try {
    claimed = await store.claimCleanup(userId);
  } catch (err) {
    console.error("[ban-cleanup] dedupe failed, running anyway", err);
  }
  if (!claimed) return { ran: false, errors: [] };

  const { errors, step } = await runSteps();

  await step("бан в чате", () => api.banChatMember(targets.chatId, userId));
  await step("бан в канале", () => api.banChatMember(targets.channelId, userId));

  let joinIds: number[] = [];
  await step("чтение id сообщения о входе", async () => {
    joinIds = await store.getJoinMessageIds(userId);
  });
  for (const id of joinIds) {
    await step(`сообщение о входе ${id}`, () => api.deleteMessage(targets.chatId, id));
  }
  if (joinIds.length > 0) await store.clearJoinMessageIds(userId).catch(() => {});

  await step("отметка в чате модерации", async () => {
    const entry = await store.getJoinLog(userId);
    const opts2 = {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: wipeKeyboard(userId),
    };
    if (entry) {
      const html = `${entry.html}\n\n${bannedFooterHtml(opts.by)}`;
      await api.editMessageText(targets.moderationChatId, entry.messageId, html, opts2);
      await store.setJoinLog(userId, { messageId: entry.messageId, html });
    } else {
      // No join-log entry (joined long ago / before the log existed): post a small card.
      const html = `${banCardHtml(userId, opts.user)}\n\n${bannedFooterHtml(opts.by)}`;
      const sent = await api.sendMessage(targets.moderationChatId, html, {
        ...opts2,
        disable_notification: true,
      });
      await store.setJoinLog(userId, { messageId: sent.message_id, html });
    }
  });

  return { ran: true, errors };
}

/** Step 2: irreversible wipe, only on explicit moderator confirmation. */
export async function runWipe(deps: CleanupDeps, userId: number, by?: User): Promise<StepResult> {
  const { api, store, targets } = deps;
  const { errors, step } = await runSteps();

  // Re-banning with revoke_messages deletes all of the user's messages in the chat.
  await step("удаление сообщений", () =>
    api.banChatMember(targets.chatId, userId, { revoke_messages: true }),
  );
  await step("удаление реакций", () => api.deleteAllMessageReactionsUser(targets.chatId, userId));

  await step("отметка в чате модерации", async () => {
    const entry = await store.getJoinLog(userId);
    if (!entry) return;
    const tail = errors.length > 0 ? `\n⚠️ ${errors.map(escapeHtml).join("; ")}` : "";
    const done = `${wipedFooterHtml(by)}${tail}`;
    const html = entry.html.includes(NOT_WIPED_LINE)
      ? entry.html.replace(NOT_WIPED_LINE, done)
      : `${entry.html}\n${done}`;
    await api.editMessageText(targets.moderationChatId, entry.messageId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
    await store.setJoinLog(userId, { messageId: entry.messageId, html });
  });

  return { ran: true, errors };
}
