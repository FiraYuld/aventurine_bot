import type { Context, NextFunction } from "grammy";
import { config } from "../config.js";

/**
 * Личка владельца, чат обсуждения (CHAT_ID), чат модерации (MODERATION_CHAT_ID),
 * callback из чата модерации. Остальное — игнор.
 */
export async function scopeMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const mr = ctx.messageReaction;
  if (mr) {
    if (mr.chat.id !== config.chatId) return;
    return next();
  }

  const cq = ctx.callbackQuery;
  if (cq) {
    const msg = cq.message;
    const chatId =
      msg && "chat" in msg && msg.chat !== undefined ? (msg.chat as { id: number }).id : undefined;

    if (chatId === undefined) {
      await ctx.answerCallbackQuery({ text: "Нет данных чата" }).catch(() => {});
      return;
    }

    const expected = config.moderationChatId;
    if (chatId !== expected) {
      console.error("[scope] callback_query ignored", { chatId, expectedModerationChatId: expected });
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    return next();
  }

  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;

  if (chat.type === "private") {
    if (from.id !== config.adminLogChatId) return;
    return next();
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    if (chat.id === config.chatId || chat.id === config.moderationChatId) {
      return next();
    }
    return;
  }

  // Каналы и прочее — не обрабатываем
}
