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
  cap: number,
): string {
  const strikesLine = `\n\nРеакций подряд: <b>${strikeCount}</b> (при <b>${cap}</b> за <b>${windowSec} с</b> с первой — автобан)`;
  return (
    `⚠️ <b>Подозрительная реакция</b>\n\n` +
    `Пользователь: ${formatUserLine(user)}\n\n` +
    `Причины:\n${buildReasonsList(reasons)}` +
    strikesLine
  );
}

/**
 * HTML-меншн пользователя так, чтобы Telegram реально пинговал:
 *   - есть @username — используем `@username` (нативный пинг);
 *   - нет — `<a href="tg://user?id=…">` всё равно даёт уведомление.
 */
function userMentionHtml(user: User): string {
  if (user.username) return `@${escapeHtml(user.username)}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const safe = escapeHtml(name || "участник");
  return `<a href="tg://user?id=${user.id}">${safe}</a>`;
}

/**
 * Публичное предупреждение в основном чате. Шлётся на 1-й «подозрительной»
 * реакции и потом редактируется на каждом следующем страйке — чтобы не
 * захламлять чат серией сообщений от бота.
 *
 * Состояния:
 *   - strikeCount < cap: «реакций {N}/{cap}, ещё {cap-N} - и в бан».
 *   - strikeCount >= cap: «заблокирован {cap}/{cap}».
 */
export function buildReactionWarningHtml(
  user: User,
  strikeCount: number,
  cap: number,
): string {
  const mention = userMentionHtml(user);
  if (strikeCount >= cap) {
    return `🔒 ${mention} - заблокирован за реакции без подписки на канал. (${cap}/${cap})`;
  }
  const remaining = Math.max(1, cap - strikeCount);
  const tail =
    remaining === 1
      ? "ещё одна - и бан"
      : `ещё ${remaining} - и бан`;
  return (
    `👀 ${mention}, ты ставишь реакции, не подписавшись на канал. ` +
    `${tail}. (${strikeCount}/${cap})`
  );
}

/** Текст для варна, когда модератор нажал «Оставить» — короткий мирный финал. */
export function buildReactionWarningResolvedHtml(user: User): string {
  return `✅ ${userMentionHtml(user)} - модератор оставил, без бана.`;
}

/** Текст для варна, когда юзер уже подписался к моменту проверки кнопкой. */
export function buildReactionWarningSubscribedHtml(user: User): string {
  return `✅ ${userMentionHtml(user)} - подписался, вопросов нет.`;
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
