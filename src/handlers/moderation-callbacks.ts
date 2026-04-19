import type { Bot } from "grammy";
import { config } from "../config.js";
import { logError } from "../logger.js";
import { computeRisk } from "../moderation.js";
import { parseReactionModCallback } from "../moderation-card.js";
import { executeReactionBan } from "../post-ban.js";
import {
  deleteReactionModSession,
  getReactionModSession,
} from "../reaction-mod-session.js";

export function registerModerationCallbacks(bot: Bot): void {
  bot.callbackQuery(/^([bk]):\d+:\d+$/, async (ctx) => {
    const parsed = parseReactionModCallback(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery();
      return;
    }

    const { kind, userId } = parsed;
    const msg = ctx.callbackQuery.message;
    if (!msg || !("message_id" in msg)) {
      await ctx.answerCallbackQuery({ text: "Нет сообщения" });
      return;
    }

    const modMessageId = msg.message_id;
    const session = await getReactionModSession(userId);
    if (!session || session.moderationMessageId !== modMessageId) {
      await ctx.answerCallbackQuery({ text: "Уже обработано или устарело" });
      return;
    }

    const replyToMessageId = session.lastDiscussionMessageId;

    if (kind === "k") {
      try {
        await ctx.api.editMessageText(
          config.moderationChatId,
          modMessageId,
          `✅ <b>Оставили</b>\n\nПользователь <code>${userId}</code> — без бана.`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          },
        );
        await deleteReactionModSession(userId);
      } catch (err) {
        await logError(ctx.api, "правка сообщения «оставили»", err);
      }
      await ctx.answerCallbackQuery({ text: "Ок" });
      return;
    }

    try {
      const member = await ctx.api.getChatMember(config.chatId, userId);
      const risk = await computeRisk(ctx.api, member.user);
      if (!risk.shouldBan) {
        try {
          await ctx.api.editMessageText(
            config.moderationChatId,
            modMessageId,
            `✅ <b>Не баним</b>\n\nПользователь уже не попадает под правила (например, подписался).`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [] },
            },
          );
          await deleteReactionModSession(userId);
        } catch (err) {
          await logError(ctx.api, "правка сообщения «не баним»", err);
        }
        await ctx.answerCallbackQuery({ text: "Уже не под подозрением" });
        return;
      }

      const reasonsForLog =
        session.reasons && session.reasons.length > 0 ? session.reasons : risk.reasons;

      await executeReactionBan({
        api: ctx.api,
        user: member.user,
        userId,
        reasons: reasonsForLog,
        discussionMessageId: replyToMessageId,
        logTitle: "Бан по кнопке",
        replaceModerationMessageId: modMessageId,
      });
      await deleteReactionModSession(userId);
      await ctx.answerCallbackQuery({ text: "Забанен" });
    } catch (err) {
      await logError(ctx.api, "callback «забанить»", err);
      await ctx.answerCallbackQuery({ text: "Ошибка", show_alert: true });
    }
  });
}
