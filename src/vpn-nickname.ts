import { InlineKeyboard } from "grammy";
import type { User } from "grammy/types";
import { discussionPostPublicLink, escapeHtml, formatUserLine } from "./logger.js";

/**
 * "VPN" / "ВПН" in a name or username is a typical marker of VPN-selling spam accounts.
 * When such a user writes in the discussion chat, moderators get a card. Matching is
 * deliberately loose (V.P.N, В-П-Н, cheap_vpn_bot): a human decides on every card.
 */
const VPN_NICKNAME_PATTERNS: RegExp[] = [
  /v[\s._\-]*p[\s._\-]*n/iu,
  /в[\s._\-]*п[\s._\-]*н/iu,
];

/** One open card per user. */
export const VPN_CARD_TTL_SEC = 24 * 60 * 60;
/** After "Keep", don't ask about this user again for a while. */
export const VPN_LEAVE_ALONE_TTL_SEC = 90 * 24 * 60 * 60;
export const VPN_BAN_CATCHPHRASE = "Схватил бота впнера!";

export function hasVpnNickname(user: Pick<User, "first_name" | "last_name" | "username">): boolean {
  const name = [user.first_name, user.last_name, user.username]
    .filter(Boolean)
    .join(" ")
    .replace(/ /g, " ");
  if (!name.trim()) return false;
  return VPN_NICKNAME_PATTERNS.some((re) => re.test(name));
}

export type VpnCardAction = "ban" | "keep";

export function vpnCallbackData(action: VpnCardAction, userId: number, messageId: number): string {
  return `v${action === "ban" ? "b" : "k"}:${userId}:${messageId}`;
}

export function parseVpnCallback(
  data: string,
): { action: VpnCardAction; userId: number; messageId: number } | null {
  const m = /^v([bk]):(\d+):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] === "b" ? "ban" : "keep", userId: Number(m[2]), messageId: Number(m[3]) };
}

export function vpnCardKeyboard(userId: number, messageId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔨 Забанить", vpnCallbackData("ban", userId, messageId))
    .text("✅ Оставить", vpnCallbackData("keep", userId, messageId));
}

export function buildVpnCardHtml(user: User, chatId: number, messageId: number): string {
  const url = discussionPostPublicLink(chatId, messageId);
  return (
    `⚠️ <b>VPN / ВПН в нике</b>\n\n` +
    `Пользователь: ${formatUserLine(user)}\n` +
    `Написал в чат: <a href="${escapeHtml(url)}">сообщение ${messageId}</a>\n\n` +
    `«Забанить» — бан в чате и канале, сообщения и реакции удалить можно отдельной кнопкой.\n` +
    `«Оставить» — больше не спрашивать про этого человека 90 дней.`
  );
}

export function vpnKeptFooterHtml(by: User): string {
  const name = [by.first_name, by.last_name].filter(Boolean).join(" ").trim() || "модератор";
  return `✅ <b>Оставили</b> (${escapeHtml(name)}).`;
}
