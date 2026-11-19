import { InlineKeyboard } from "grammy";
import type { ChatPermissions, Message, MessageEntity, User } from "grammy/types";
import { joinCardCallbackData, joinLogKeyboard } from "./join-log.js";
import { escapeHtml } from "./logger.js";

/**
 * Tournament chat (TOURNAMENT_CHAT_ID): a separate public group, not linked to the channel.
 *
 * Spam there is "dirty": an account joins and posts a link right away (t.me/+… invite,
 * "ЖМИ" with a hidden link, a forward from a channel). So:
 *   - every join is logged to the moderation chat and marks the user as a newcomer;
 *   - a link from a newcomer is deleted, the user is muted (reversible), the card gets
 *     🔨 ban / ✅ unmute buttons;
 *   - bans stay inside the tournament chat (never the channel or the discussion chat);
 *   - deleting the rest of a banned user's messages is a separate 🧹 button.
 */

/** How long after joining a link counts as "joined and posted a link right away". */
export const NEWCOMER_WINDOW_SEC = 15 * 60;
/** One link card per user per this period (the spammer usually posts 2–3 copies). */
export const LINK_CARD_TTL_SEC = 24 * 60 * 60;
/** Card (join log / link card) lives this long, so buttons keep working. */
export const TOURNAMENT_CARD_TTL_SEC = 14 * 24 * 60 * 60;
/** Telegram allows deleting messages only within 48 h. */
export const TOURNAMENT_JOIN_MSG_TTL_SEC = 48 * 60 * 60;

const TG_LINK_RE = /(?:t\.me|telegram\.me|telegram\.dog)\/\S+/iu;
const URL_ENTITY_TYPES = new Set<MessageEntity["type"]>(["url", "text_link"]);

/** Why this message counts as a link, or null. Mentions (@user) are not links. */
export function findLinkReason(msg: Message): string | null {
  // Only channel forwards: a member forwarding a friend's message is not spam by itself.
  if (msg.forward_origin?.type === "channel") return "пересылка из канала";
  const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
  if (entities.some((e) => e.type === "text_link")) return "скрытая ссылка";
  if (entities.some((e) => URL_ENTITY_TYPES.has(e.type))) return "ссылка";
  const text = msg.text ?? msg.caption ?? "";
  if (TG_LINK_RE.test(text)) return "ссылка на Telegram";
  const rows = msg.reply_markup?.inline_keyboard ?? [];
  if (rows.some((row) => row.some((b) => "url" in b && b.url))) return "кнопка со ссылкой";
  return null;
}

export type TournamentAction = "ban" | "unmute" | "wipe";
const ACTION_CODE: Record<TournamentAction, string> = { ban: "b", unmute: "u", wipe: "w" };

export function tournamentCallbackData(action: TournamentAction, userId: number): string {
  return `t:${ACTION_CODE[action]}:${userId}`;
}

export function parseTournamentCallback(
  data: string,
): { action: TournamentAction; userId: number } | null {
  const m = /^t:([buw]):(\d+)$/.exec(data);
  if (!m) return null;
  const userId = Number(m[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const action: TournamentAction = m[1] === "b" ? "ban" : m[1] === "u" ? "unmute" : "wipe";
  return { action, userId };
}

/** 🔨 ban, ✅ Свой (t:o), 🔄 profile (t:p) — same layout as the discussion join log. */
export function joinKeyboard(userId: number): InlineKeyboard {
  return joinLogKeyboard(userId, "t");
}

export function mutedKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔨 Забанить", tournamentCallbackData("ban", userId))
    .text("✅ Размутить", tournamentCallbackData("unmute", userId))
    .row()
    .text("🔄 Профиль", joinCardCallbackData("refresh", userId, "t"));
}

export function wipeKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard().text(
    "🧹 Удалить его сообщения в чате турниров",
    tournamentCallbackData("wipe", userId),
  );
}

/** Mute: no messages of any kind. */
export const MUTED_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}

function who(by?: User): string {
  if (!by) return "";
  const name = [by.first_name, by.last_name].filter(Boolean).join(" ").trim() || "модератор";
  return ` (${escapeHtml(name)})`;
}

export function userCardHtml(user: Pick<User, "id" | "first_name" | "last_name" | "username">): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "(без имени)";
  const handle = user.username ? ` · @${escapeHtml(user.username)}` : "";
  return `👤 <a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>${handle} · ID <code>${user.id}</code>`;
}

export function linkSectionHtml(opts: {
  reason: string;
  text: string;
  deleted: boolean;
  muted: boolean;
  minutesSinceJoin?: number;
}): string {
  const when =
    opts.minutesSinceJoin !== undefined ? ` через ${Math.max(0, opts.minutesSinceJoin)} мин после входа` : "";
  const done = [
    opts.deleted ? "сообщение удалено" : "<b>удалить не вышло</b>",
    opts.muted ? "замучен" : "<b>замутить не вышло</b>",
  ].join(", ");
  const body = opts.text ? `\n<blockquote>${escapeHtml(clip(opts.text, 300))}</blockquote>` : "";
  return `🚫 <b>Ссылка от новичка</b> (${escapeHtml(opts.reason)})${when}: ${done}.${body}`;
}

export function bannedFooterHtml(by?: User): string {
  return `🔨 <b>Забанен в чате турниров</b>${who(by)}. Канал и чат обсуждения не тронуты.`;
}

export function unmutedFooterHtml(by?: User): string {
  return `✅ <b>Размучен</b>${who(by)}.`;
}

export function wipedFooterHtml(by?: User): string {
  return `🧹 <b>Сообщения в чате турниров удалены</b>${who(by)}.`;
}

// ---------------------------------------------------------------------------
// Actions (Telegram + Redis behind small interfaces, so tests use fakes).

export interface TournamentApi {
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  restrictChatMember(
    chatId: number,
    userId: number,
    permissions: ChatPermissions,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  banChatMember(chatId: number, userId: number, other?: { revoke_messages?: boolean }): Promise<unknown>;
  getChat(chatId: number): Promise<unknown>;
  getChatMember(chatId: number, userId: number): Promise<{ status: string }>;
  sendMessage(chatId: number, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface TournamentCard {
  messageId: number;
  html: string;
  /** Unix seconds when the card was posted. */
  at?: number;
}

export interface TournamentStore {
  /** Unix seconds of the join, or null if the user is not a newcomer. */
  getJoinedAt(userId: number): Promise<number | null>;
  /** Sets the newcomer marker unless it is already set (keeps the first join time). */
  markJoined(userId: number, at: number): Promise<void>;
  /** Clears the newcomer marker and the link-card slot (after a ban or an unmute). */
  clearJoined(userId: number): Promise<void>;
  /** true if this call took the per-user link-card slot. */
  claimLinkCard(userId: number): Promise<boolean>;
  /** Is the link-card slot taken (a link card was posted for the current stay)? */
  hasLinkCard(userId: number): Promise<boolean>;
  /** "✅ Свой": a moderator vouched for this person; never treat them as a newcomer. */
  isConfirmed(userId: number): Promise<boolean>;
  setConfirmed(userId: number, confirmed: boolean): Promise<void>;
  getCard(userId: number): Promise<TournamentCard | null>;
  setCard(userId: number, card: TournamentCard): Promise<void>;
  addJoinMessage(userId: number, messageId: number): Promise<void>;
  takeJoinMessages(userId: number): Promise<number[]>;
}

export interface TournamentDeps {
  api: TournamentApi;
  store: TournamentStore;
  tournamentChatId: number;
  moderationChatId: number;
  now?: () => number;
  /** Tests only: override GUARD_MAX_MS. */
  guardMaxMs?: number;
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "description" in err) {
    return String((err as { description: unknown }).description);
  }
  return err instanceof Error ? err.message : String(err);
}

const CARD_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

const nowSec = (deps: TournamentDeps) => deps.now?.() ?? Math.floor(Date.now() / 1000);

/** Appends `section` to the user's card (or posts a new one) and sets the keyboard. */
async function updateCard(
  deps: TournamentDeps,
  userId: number,
  user: Pick<User, "id" | "first_name" | "last_name" | "username"> | undefined,
  section: string,
  keyboard: InlineKeyboard | undefined,
  notify: boolean,
): Promise<void> {
  const { api, store, moderationChatId } = deps;
  const existing = await store.getCard(userId);
  if (existing) {
    const html = `${existing.html}\n\n${section}`;
    try {
      await api.editMessageText(moderationChatId, existing.messageId, html, {
        ...CARD_OPTS,
        reply_markup: keyboard,
      });
      await store.setCard(userId, { ...existing, html });
      return;
    } catch (err) {
      console.error("[tournament] card edit failed, posting a new one", { userId, err: errText(err) });
    }
  }
  const head = user ? userCardHtml(user) : userCardHtml({ id: userId, first_name: "пользователь" });
  const html = `🏆 <b>Чат турниров</b>\n${head}\n\n${section}`;
  const sent = await api.sendMessage(moderationChatId, html, {
    ...CARD_OPTS,
    reply_markup: keyboard,
    disable_notification: !notify,
  });
  await store.setCard(userId, { messageId: sent.message_id, html, at: nowSec(deps) });
}

const ADMIN_STATUSES = new Set(["creator", "administrator"]);
/** Link guard gives up before deleting if the admin check alone took this long. */
export const GUARD_MAX_MS = 4_000;

export interface LinkGuardResult {
  acted: boolean;
  errors: string[];
}

/**
 * A message in the tournament chat. Acts only on a newcomer's link; never on admins.
 * Deletes the message, mutes the user, posts/updates the card once per user.
 */
export async function guardNewcomerLink(deps: TournamentDeps, msg: Message): Promise<LinkGuardResult> {
  const user = msg.from;
  if (!user || user.is_bot || msg.sender_chat) return { acted: false, errors: [] };
  const reason = findLinkReason(msg);
  if (!reason) return { acted: false, errors: [] };

  const { api, store, tournamentChatId } = deps;
  const joinedAt = await store.getJoinedAt(user.id);
  if (joinedAt === null) return { acted: false, errors: [] };
  if (await store.isConfirmed(user.id)) return { acted: false, errors: [] };

  const started = Date.now();
  try {
    const m = await api.getChatMember(tournamentChatId, user.id);
    if (ADMIN_STATUSES.has(m.status)) return { acted: false, errors: [] };
  } catch {
    // Can't check: a just-joined account is almost never an admin, keep going.
  }
  // Slow Telegram: the card lock (8 s lease) may be about to expire. Don't act late —
  // re-check the confirmation right before the irreversible delete.
  if (Date.now() - started > (deps.guardMaxMs ?? GUARD_MAX_MS)) {
    return { acted: false, errors: ["проверка ссылки заняла слишком долго — сообщение не тронуто"] };
  }
  if (await store.isConfirmed(user.id)) return { acted: false, errors: [] };

  const errors: string[] = [];
  let deleted = true;
  try {
    await api.deleteMessage(tournamentChatId, msg.message_id);
  } catch (err) {
    deleted = false;
    errors.push(`удаление сообщения: ${errText(err)}`);
  }
  let muted = true;
  try {
    await api.restrictChatMember(tournamentChatId, user.id, MUTED_PERMISSIONS, {
      use_independent_chat_permissions: true,
    });
  } catch (err) {
    muted = false;
    errors.push(`мут: ${errText(err)}`);
  }

  // Copies of the same spam: deleted above, but only the first one touches the card.
  if (await store.claimLinkCard(user.id)) {
    const now = nowSec(deps);
    const section = linkSectionHtml({
      reason,
      text: msg.text ?? msg.caption ?? "",
      deleted,
      muted,
      minutesSinceJoin: Math.floor((now - joinedAt) / 60),
    });
    try {
      await updateCard(deps, user.id, user, section, mutedKeyboard(user.id), true);
    } catch (err) {
      errors.push(`карточка: ${errText(err)}`);
    }
  }
  return { acted: true, errors };
}

/** First thing on a join (before slow profile reads), so an instant link is still caught. */
export async function markNewcomer(deps: TournamentDeps, userId: number): Promise<void> {
  // A late or repeated join event must not turn a confirmed person back into a newcomer.
  if (await deps.store.isConfirmed(userId)) return;
  await deps.store.markJoined(userId, nowSec(deps));
}

/** A link card posted this recently belongs to the same join (the link beat the join log). */
const SAME_JOIN_SEC = 5 * 60;

export async function recordJoin(
  deps: TournamentDeps,
  user: User,
  joinLogHtml: string,
): Promise<void> {
  const existing = await deps.store.getCard(user.id);
  const recent = existing?.at !== undefined && nowSec(deps) - existing.at < SAME_JOIN_SEC;
  if (existing && recent && (await deps.store.hasLinkCard(user.id))) {
    // Link card is already up with 🔨/✅: add the join details under it, keep the buttons.
    await updateCard(deps, user.id, user, joinLogHtml, mutedKeyboard(user.id), false);
    return;
  }
  const sent = await deps.api.sendMessage(deps.moderationChatId, joinLogHtml, {
    ...CARD_OPTS,
    disable_notification: true,
    reply_markup: user.is_bot ? undefined : joinKeyboard(user.id),
  });
  await deps.store.setCard(user.id, { messageId: sent.message_id, html: joinLogHtml, at: nowSec(deps) });
}

async function deleteJoinMessages(deps: TournamentDeps, userId: number, errors: string[]): Promise<void> {
  let ids: number[] = [];
  try {
    ids = await deps.store.takeJoinMessages(userId);
  } catch (err) {
    errors.push(`id сообщения о входе: ${errText(err)}`);
  }
  for (const id of ids) {
    await deps.api.deleteMessage(deps.tournamentChatId, id).catch((err) => {
      errors.push(`сообщение о входе ${id}: ${errText(err)}`);
    });
  }
}

/**
 * After a ban in the tournament chat. `alreadyBanned` = someone else banned by hand,
 * we only clean up and mark the card. Never touches the channel or the discussion chat.
 */
export async function tournamentBan(
  deps: TournamentDeps,
  userId: number,
  opts: { by?: User; user?: User; alreadyBanned?: boolean } = {},
): Promise<string[]> {
  const errors: string[] = [];
  if (!opts.alreadyBanned) {
    try {
      await deps.api.banChatMember(deps.tournamentChatId, userId);
    } catch (err) {
      errors.push(`бан: ${errText(err)}`);
      return errors;
    }
  }
  await deps.store.clearJoined(userId).catch(() => {});
  await deleteJoinMessages(deps, userId, errors);
  try {
    await updateCard(deps, userId, opts.user, bannedFooterHtml(opts.by), wipeKeyboard(userId), false);
  } catch (err) {
    errors.push(`карточка: ${errText(err)}`);
  }
  return errors;
}

function chatPermissionsOf(chat: unknown): ChatPermissions | undefined {
  if (chat && typeof chat === "object" && "permissions" in chat) {
    return (chat as { permissions?: ChatPermissions }).permissions;
  }
  return undefined;
}

/** Lifts the mute: back to the chat's default permissions. */
export async function tournamentUnmute(deps: TournamentDeps, userId: number, by?: User): Promise<string[]> {
  const errors: string[] = [];
  let permissions: ChatPermissions | undefined;
  try {
    permissions = chatPermissionsOf(await deps.api.getChat(deps.tournamentChatId));
  } catch (err) {
    console.error("[tournament] getChat failed, unmuting with full text rights", errText(err));
  }
  try {
    await deps.api.restrictChatMember(
      deps.tournamentChatId,
      userId,
      permissions ?? { can_send_messages: true, can_send_other_messages: true, can_add_web_page_previews: true },
      { use_independent_chat_permissions: true },
    );
  } catch (err) {
    errors.push(`размут: ${errText(err)}`);
    return errors;
  }
  // Moderator vouched for them: stop treating them as a newcomer.
  await deps.store.clearJoined(userId).catch(() => {});
  try {
    await updateCard(deps, userId, undefined, unmutedFooterHtml(by), undefined, false);
  } catch (err) {
    errors.push(`карточка: ${errText(err)}`);
  }
  return errors;
}

/** Irreversible: only from the 🧹 button. Deletes their messages in the tournament chat. */
export async function tournamentWipe(deps: TournamentDeps, userId: number, by?: User): Promise<string[]> {
  const errors: string[] = [];
  try {
    await deps.api.banChatMember(deps.tournamentChatId, userId, { revoke_messages: true });
  } catch (err) {
    errors.push(`удаление сообщений: ${errText(err)}`);
    return errors;
  }
  try {
    await updateCard(deps, userId, undefined, wipedFooterHtml(by), undefined, false);
  } catch (err) {
    errors.push(`карточка: ${errText(err)}`);
  }
  return errors;
}
