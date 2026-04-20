import type { Bot, Context } from "grammy";
import { GrammyError } from "grammy";
import { config } from "../config.js";
import { logError } from "../logger.js";
import { computeRisk } from "../moderation.js";
import { parseReactionModCallback } from "../moderation-card.js";
import { executeReactionBan } from "../post-ban.js";
import {
  deleteReactionModSession,
  getReactionModSession,
  setReactionLeaveAlone,
} from "../reaction-mod-session.js";

async function safeAnswer(
  ctx: Context,
  other?: Parameters<Context["answerCallbackQuery"]>[0],
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(other);
  } catch (e) {
    const msg = e instanceof GrammyError ? e.description : String(e);
    console.error("[mod-callback] answerCallbackQuery failed", msg);
  }
}

export function registerModerationCallbacks(bot: Bot): void {
  // Не использовать bot.callbackQuery(/^.../) — при несовпадении regex GrammY не
  // вызывает хендлер и Telegram ждёт answerCallbackQuery бесконечно.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parsed = parseReactionModCallback(data);
    if (!parsed) {
      await safeAnswer(ctx);
      return;
    }

    const { kind, userId } = parsed;
    const msg = ctx.callbackQuery.message;
    if (!msg || !("message_id" in msg)) {
      await safeAnswer(ctx, { text: "Нет сообщения" });
      return;
    }

    const modMessageId = msg.message_id;
    const session = await getReactionModSession(userId);
    if (!session || session.moderationMessageId !== modMessageId) {
      await safeAnswer(ctx, { text: "Уже обработано или устарело" });
      return;
    }

    const replyToMessageId = session.lastDiscussionMessageId;

    if (kind === "k") {
      await safeAnswer(ctx, { text: "Ок" });
      try {
        await ctx.api.editMessageText(
          config.moderationChatId,
          modMessageId,
          `✅ <b>Оставили</b>\n\nПользователь <code>${userId}</code> — без бана. Дальнейшие реакции по этому правилу не считаются (ограниченное время).`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          },
        );
        await deleteReactionModSession(userId);
        await setReactionLeaveAlone(userId, config.reactionLeaveAloneTtlSec);
      } catch (err) {
        await logError(ctx.api, "правка сообщения «оставили»", err);
      }
      return;
    }

    await safeAnswer(ctx);

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
        reactionEvents: session.reactionEvents,
        replaceModerationMessageId: modMessageId,
      });
      await deleteReactionModSession(userId);
    } catch (err) {
      await logError(ctx.api, "callback «забанить»", err);
    }
  });
}
