import type { Api } from "grammy";
import type { User } from "grammy/types";
import { config } from "./config.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Публичная ссылка на сообщение в супергруппе / канале с обсуждением (t.me/c/…) */
export function discussionPostPublicLink(chatId: number, messageId: number): string {
  const s = String(chatId);
  const slug = s.startsWith("-100") ? s.slice(4) : s.replace(/^-/, "");
  return `https://t.me/c/${slug}/${messageId}`;
}

export function formatUserLine(user: User): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const safeName = escapeHtml(name || "(без имени)");
  const link = `<a href="tg://user?id=${user.id}">${safeName}</a>`;
  const username = user.username ? ` @${escapeHtml(user.username)}` : "";
  return `${link}${username} <code>${user.id}</code>`;
}

export type ReactionEventLog = { messageId: number; emojis: string[] };

export function buildBanLogHtml(
  user: User,
  reasons: string[],
  extra?: {
    messageId?: number;
    reactionEmojis?: string[];
    reactionEvents?: ReactionEventLog[];
    title?: string;
  },
): string {
  const title = extra?.title ?? "Бан по реакции";
  const reasonsList = reasons.map((r) => `• ${escapeHtml(r)}`).join("\n");

  let reactionsBlock = "";
  if (extra?.reactionEvents && extra.reactionEvents.length > 0) {
    const lines = extra.reactionEvents.map((ev) => {
      const url = discussionPostPublicLink(config.chatId, ev.messageId);
      const em = ev.emojis.map(escapeHtml).join(" ");
      return `• <a href="${url}">сообщение ${escapeHtml(String(ev.messageId))}</a>: ${em}`;
    });
    reactionsBlock = `\n\nРеакции:\n${lines.join("\n")}`;
  } else if (extra?.reactionEmojis && extra.reactionEmojis.length > 0) {
    reactionsBlock = `\n\nРеакция: ${extra.reactionEmojis.map(escapeHtml).join(" ")}`;
    if (extra.messageId !== undefined) {
      const url = discussionPostPublicLink(config.chatId, extra.messageId);
      reactionsBlock += `\n<a href="${url}">Перейти к сообщению</a>`;
    }
  }

  const hasEventList = Boolean(extra?.reactionEvents && extra.reactionEvents.length > 0);
  const hasEmojiWithLink =
    Boolean(extra?.reactionEmojis && extra.reactionEmojis.length > 0) &&
    extra?.messageId !== undefined;
  const messageRef =
    extra?.messageId !== undefined && !hasEventList && !hasEmojiWithLink
      ? `\nСообщение в чате: <code>${extra.messageId}</code>`
      : "";

  return (
    `🚫 <b>${escapeHtml(title)}</b>\n\n` +
    `Пользователь: ${formatUserLine(user)}\n\n` +
    `Причины:\n${reasonsList}` +
    reactionsBlock +
    messageRef
  );
}

export async function logBan(
  api: Api,
  user: User,
  reasons: string[],
  extra?: {
    messageId?: number;
    reactionEmojis?: string[];
    reactionEvents?: ReactionEventLog[];
    title?: string;
  },
): Promise<void> {
  const text = buildBanLogHtml(user, reasons, extra);

  try {
    await api.sendMessage(config.moderationChatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("Не удалось отправить лог в чат модерации:", err);
  }
}

export async function logError(
  api: Api,
  context: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const text =
    `⚠️ <b>Ошибка</b>\n\n` +
    `Контекст: ${escapeHtml(context)}\n` +
    `Сообщение: <code>${escapeHtml(message)}</code>`;

  try {
    await api.sendMessage(config.adminLogChatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Не удалось отправить лог об ошибке:", err);
  }
}

export async function logInfo(api: Api, text: string): Promise<void> {
  try {
    await api.sendMessage(config.adminLogChatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Не удалось отправить инфо-лог:", err);
  }
}
