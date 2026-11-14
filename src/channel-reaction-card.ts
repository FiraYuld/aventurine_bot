import { InlineKeyboard } from "grammy";
import type { Chat, User } from "grammy/types";
import { discussionPostPublicLink, escapeHtml, formatActorChatHtml } from "./logger.js";

/**
 * A channel (not our own, not ignore-listed) reacted in the discussion chat. Instead of
 * acting automatically, moderators get a card: ban the channel or keep it (which adds it
 * to the ignore-list so it is never reported again).
 */

/** One open card per channel; a new one may appear after this if nobody decided. */
export const CHANNEL_CARD_TTL_SEC = 24 * 60 * 60;

export type ChannelCardAction = "ban" | "keep";

export function channelCardCallbackData(action: ChannelCardAction, channelId: number): string {
  return `ac:${action === "ban" ? "b" : "k"}:${channelId}`;
}

export function parseChannelCardCallback(
  data: string,
): { action: ChannelCardAction; channelId: number } | null {
  const m = /^ac:([bk]):(-\d+)$/.exec(data);
  if (!m) return null;
  const channelId = Number(m[2]);
  if (!Number.isSafeInteger(channelId)) return null;
  return { action: m[1] === "b" ? "ban" : "keep", channelId };
}

export function channelCardKeyboard(channelId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔨 Забанить канал", channelCardCallbackData("ban", channelId))
    .text("✅ Оставить", channelCardCallbackData("keep", channelId));
}

export function buildChannelCardHtml(params: {
  actorChat: Chat;
  chatId: number;
  messageId: number;
  emojis: string[];
}): string {
  const url = discussionPostPublicLink(params.chatId, params.messageId);
  const em = params.emojis.map(escapeHtml).join(" ");
  return (
    `📢 <b>Реакция от имени канала</b>${em ? ` (${em})` : ""} на ` +
    `<a href="${escapeHtml(url)}">сообщение ${params.messageId}</a>\n\n` +
    `<b>Канал:</b> ${formatActorChatHtml(params.actorChat)}\n\n` +
    `«Забанить» — канал не сможет писать и ставить реакции в чате, его реакции снимутся.\n` +
    `«Оставить» — канал попадёт в ignore-list, больше карточек о нём не будет.`
  );
}

function who(by: User): string {
  return escapeHtml([by.first_name, by.last_name].filter(Boolean).join(" ").trim() || "модератор");
}

export function channelCardResultHtml(
  action: ChannelCardAction,
  by: User,
  channelId: number,
  errors: string[] = [],
): string {
  const head =
    action === "ban"
      ? `🔨 <b>Канал забанен</b> (${who(by)}), реакции сняты.`
      : `✅ <b>Оставили</b> (${who(by)}): канал <code>${channelId}</code> в ignore-list.`;
  const tail =
    errors.length > 0 ? `\n⚠️ ${errors.map(escapeHtml).join("; ")}` : "";
  return head + tail;
}
