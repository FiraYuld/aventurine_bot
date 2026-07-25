import type { Context, NextFunction } from "grammy";
import { config, isLlmPrivateDmUser, isOwnerUserId } from "../config.js";

/**
 * Личка владельца, чат обсуждения (CHAT_ID), чат модерации (MODERATION_CHAT_ID),
 * callback из чата модерации. Остальное — игнор.
 *
 * Пропуск текстов из CHAT_ID и лички владельца / LLM_UNLIMITED_DM_USER_IDS
 * для режима «Авантюрин общается в чате» (src/chat/handler.ts).
 */
export async function scopeMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.update.callback_query) {
    const d = ctx.update.callback_query.data;
    console.warn("[tg] callback_query", ctx.update.update_id, d?.slice(0, 80) ?? "(no data)");
  }

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
      console.warn("[scope] callback_query: no message.chat", {
        update_id: ctx.update.update_id,
        hasMessage: Boolean(msg),
        messageKeys: msg && typeof msg === "object" ? Object.keys(msg) : [],
      });
      await ctx.answerCallbackQuery({ text: "Нет данных чата" }).catch(() => {});
      return;
    }

    const data = cq.data;
    const from = ctx.from;
    const chat = msg && "chat" in msg ? msg.chat : undefined;
    if (data?.startsWith("post:")) {
      if (chat?.type === "private" && from && isOwnerUserId(from.id)) {
        return next();
      }
      await ctx.answerCallbackQuery().catch(() => {});
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
    if (!isLlmPrivateDmUser(from.id)) return;
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
