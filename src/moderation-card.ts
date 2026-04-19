import { InlineKeyboard } from "grammy";
import type { User } from "grammy/types";
import { escapeHtml, formatUserLine } from "./logger.js";

function buildReasonsList(reasons: string[]): string {
  return reasons.map((r) => `• ${escapeHtml(r)}`).join("\n");
}

export function buildPendingModerationText(
  user: User,
  reasons: string[],
  strikeCount: number,
  windowSec: number,
): string {
  const strikesLine =
    strikeCount > 1
      ? `\n\nРеакций подряд на <b>этом же сообщении</b>: <b>${strikeCount}</b> (при <b>2</b> за <b>${windowSec} с</b> — автобан)`
      : `\n\nРеакций подряд на <b>этом же сообщении</b>: <b>1</b> (при <b>2</b> за <b>${windowSec} с</b> — автобан)`;
  return (
    `⚠️ <b>Подозрительная реакция</b>\n\n` +
    `Пользователь: ${formatUserLine(user)}\n\n` +
    `Причины:\n${buildReasonsList(reasons)}` +
    strikesLine
  );
}

/** Telegram лимит callback_data — 64 байта UTF-8 */
export function reactionModCallbackData(kind: "b" | "k", userId: number, discussionMessageId: number): string {
  return `${kind}:${userId}:${discussionMessageId}`;
}

export function parseReactionModCallback(
  data: string,
): { kind: "b" | "k"; userId: number; discussionMessageId: number } | null {
  const m = /^([bk]):(\d+):(\d+)$/.exec(data);
  if (!m) return null;
  return {
    kind: m[1] as "b" | "k",
    userId: Number(m[2]),
    discussionMessageId: Number(m[3]),
  };
}

export function pendingModerationKeyboard(
  userId: number,
  discussionMessageId: number,
): InlineKeyboard {
  const banData = reactionModCallbackData("b", userId, discussionMessageId);
  const keepData = reactionModCallbackData("k", userId, discussionMessageId);
  if (Buffer.byteLength(banData, "utf8") > 64 || Buffer.byteLength(keepData, "utf8") > 64) {
    throw new Error("callback_data превышает 64 байта");
  }
  return new InlineKeyboard().text("Забанить", banData).text("Оставить", keepData);
}
