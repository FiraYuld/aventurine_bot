import type { Bot } from "grammy";
import { config } from "../config.js";
import { agentDebugLog } from "../debug-agent-log.js";
import { logError, logInfo } from "../logger.js";
import {
  buildPendingModerationText,
  pendingModerationKeyboard,
} from "../moderation-card.js";
import { computeRisk, isAdminAnywhere } from "../moderation.js";
import { executeReactionBan } from "../post-ban.js";
import {
  deleteReactionModSession,
  getReactionModSession,
  setReactionModSession,
} from "../reaction-mod-session.js";

function reactionEmojis(
  reactions: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>,
): string[] {
  return reactions.map((r) => {
    if (r.type === "emoji" && r.emoji) return r.emoji;
    if (r.type === "custom_emoji") return "[custom]";
    if (r.type === "paid") return "⭐";
    return "?";
  });
}

export function registerReactionHandler(bot: Bot): void {
  bot.on("message_reaction", async (ctx) => {
    const update = ctx.messageReaction;
    const { user, actor_chat, new_reaction, old_reaction, chat, message_id } = update;

    if (chat.id !== config.chatId) return;

    if (new_reaction.length <= old_reaction.length) {
      // #region agent log
      agentDebugLog({
        hypothesisId: "H4",
        location: "reaction.ts:reaction_len_gate",
        message: "skipped: new_reaction length not greater than old",
        data: {
          message_id,
          userId: user?.id,
          newLen: new_reaction.length,
          oldLen: old_reaction.length,
        },
      });
      // #endregion
      return;
    }

    if (!user) {
      if (actor_chat) {
        await logInfo(
          ctx.api,
          `ℹ️ Анонимная реакция от чата <code>${actor_chat.id}</code> на сообщение <code>${message_id}</code>. Бан невозможен.`,
        );
      }
      return;
    }

    if (user.is_bot) {
      try {
        await executeReactionBan({
          api: ctx.api,
          user,
          userId: user.id,
          reasons: ["бот-аккаунт"],
          discussionMessageId: message_id,
          logTitle: "Бан бот-аккаунт",
          reactionEmojis: reactionEmojis(new_reaction),
        });
      } catch (err) {
        await logError(ctx.api, "обработка реакции бота", err);
      }
      return;
    }

    try {
      if (await isAdminAnywhere(ctx.api, user.id)) return;

      const risk = await computeRisk(ctx.api, user);
      if (!risk.shouldBan) return;

      const now = Date.now();
      const windowMs = config.reactionAutoBanWindowMs;
      const windowSec = Math.round(windowMs / 1000);
      const ttlSec = config.reactionModSessionTtlSec;

      let session = await getReactionModSession(user.id);
      if (session && now - session.firstAt > windowMs) {
        await deleteReactionModSession(user.id);
        session = null;
      }

      // #region agent log
      agentDebugLog({
        hypothesisId: "H5",
        location: "reaction.ts:session_snapshot",
        message: "risk session state",
        data: {
          userId: user.id,
          message_id,
          hasSession: Boolean(session),
          strike: session?.strikeCount,
          firstAtAgeMs: session ? now - session.firstAt : undefined,
        },
      });
      // #endregion

      if (!session) {
        const text = buildPendingModerationText(user, risk.reasons, 1, windowSec);
        const keyboard = pendingModerationKeyboard(user.id, message_id);
        const sent = await ctx.api.sendMessage(config.moderationChatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
        await setReactionModSession(
          user.id,
          {
            moderationMessageId: sent.message_id,
            strikeCount: 1,
            firstAt: now,
            lastDiscussionMessageId: message_id,
            reasons: risk.reasons,
          },
          ttlSec,
        );
        return;
      }

      const strikeCount = session.strikeCount + 1;
      const lastDiscussionMessageId = message_id;

      // #region agent log
      agentDebugLog({
        hypothesisId: "H4",
        location: "reaction.ts:strike_increment",
        message: "incrementing strike path",
        data: { userId: user.id, strikeCount, windowMs },
      });
      // #endregion

      if (strikeCount >= 2 && now - session.firstAt <= windowMs) {
        await executeReactionBan({
          api: ctx.api,
          user,
          userId: user.id,
          reasons: session.reasons && session.reasons.length > 0 ? session.reasons : risk.reasons,
          discussionMessageId: lastDiscussionMessageId,
          logTitle: "Автобан",
          reactionEmojis: reactionEmojis(new_reaction),
          replaceModerationMessageId: session.moderationMessageId,
        });
        await deleteReactionModSession(user.id);
        return;
      }

      const next = {
        ...session,
        strikeCount,
        lastDiscussionMessageId,
      };
      await setReactionModSession(user.id, next, ttlSec);

      const editText = buildPendingModerationText(user, risk.reasons, strikeCount, windowSec);
      const editKb = pendingModerationKeyboard(user.id, lastDiscussionMessageId);
      await ctx.api.editMessageText(
        config.moderationChatId,
        session.moderationMessageId,
        editText,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: editKb,
        },
      );
    } catch (err) {
      console.error("reaction handler failed:", err);
      await logError(ctx.api, `обработка реакции от ${user.id}`, err);
    }
  });
}
