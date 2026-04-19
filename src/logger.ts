import type { Api } from "grammy";
import type { User } from "grammy/types";
import { config } from "./config.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatUserLine(user: User): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const safeName = escapeHtml(name || "(без имени)");
  const link = `<a href="tg://user?id=${user.id}">${safeName}</a>`;
  const username = user.username ? ` @${escapeHtml(user.username)}` : "";
  return `${link}${username} <code>${user.id}</code>`;
}

export function buildBanLogHtml(
  user: User,
  reasons: string[],
  extra?: { messageId?: number; reactionEmojis?: string[]; title?: string },
): string {
  const title = extra?.title ?? "Бан по реакции";
  const reasonsList = reasons.map((r) => `• ${escapeHtml(r)}`).join("\n");
  const reactions =
    extra?.reactionEmojis && extra.reactionEmojis.length > 0
      ? `\n\nРеакция: ${extra.reactionEmojis.map(escapeHtml).join(" ")}`
      : "";
  const messageRef =
    extra?.messageId !== undefined
      ? `\nСообщение в чате: <code>${extra.messageId}</code>`
      : "";

  return (
    `🚫 <b>${escapeHtml(title)}</b>\n\n` +
    `Пользователь: ${formatUserLine(user)}\n\n` +
    `Причины:\n${reasonsList}` +
    reactions +
    messageRef
  );
}

export async function logBan(
  api: Api,
  user: User,
  reasons: string[],
  extra?: { messageId?: number; reactionEmojis?: string[]; title?: string },
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
