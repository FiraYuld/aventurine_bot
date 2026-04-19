import type { Context, NextFunction } from "grammy";
import { config } from "../config.js";
import { agentDebugLog } from "../debug-agent-log.js";

/**
 * Личка владельца (ADMIN_LOG_CHAT_ID = user id), чат обсуждения (CHAT_ID),
 * callback из чата модерации (MODERATION_CHAT_ID). Остальное — игнор.
 */
export async function scopeMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const mr = ctx.messageReaction;
  if (mr) {
    if (mr.chat.id !== config.chatId) return;
    return next();
  }

  const cq = ctx.callbackQuery;
  if (cq) {
    const chatId = cq.message && "chat" in cq.message ? cq.message.chat.id : undefined;
    if (chatId !== config.moderationChatId) {
      // #region agent log
      agentDebugLog({
        hypothesisId: "H1",
        location: "scope.ts:callback_blocked",
        message: "callback_query not forwarded to handlers",
        data: { chatId, expectedModerationChatId: config.moderationChatId, dataLen: cq.data?.length },
      });
      // #endregion
      return;
    }
    // #region agent log
    agentDebugLog({
      hypothesisId: "H1",
      location: "scope.ts:callback_ok",
      message: "callback_query passed scope",
      data: { chatId },
    });
    // #endregion
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
    if (chat.id !== config.chatId) return;
    return next();
  }

  // Каналы и прочее — не обрабатываем
}
