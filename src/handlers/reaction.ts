import type { Bot } from "grammy";
import { config } from "../config.js";
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

function reactionSetSignature(
  reactions: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>,
): string {
  return [...reactions]
    .map((r) => `${r.type}:${r.emoji ?? ""}:${r.custom_emoji_id ?? ""}`)
    .sort()
    .join("|");
}

function shouldProcessReactionChange(
  newR: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>,
  oldR: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>,
): boolean {
  if (newR.length > oldR.length) return true;
  if (newR.length < oldR.length) return false;
  if (newR.length === 0) return false;
  return reactionSetSignature(newR) !== reactionSetSignature(oldR);
}

export function registerReactionHandler(bot: Bot): void {
  bot.on("message_reaction", async (ctx) => {
    const update = ctx.messageReaction;
    const { user, actor_chat, new_reaction, old_reaction, chat, message_id } = update;

    if (chat.id !== config.chatId) return;

    if (!shouldProcessReactionChange(new_reaction, old_reaction)) {
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
          reactionEvents: [{ messageId: message_id, emojis: reactionEmojis(new_reaction) }],
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

      const thisEvent = { messageId: message_id, emojis: reactionEmojis(new_reaction) };

      if (!session) {
        const text = buildPendingModerationText(user, risk.reasons, 1, windowSec);
        const keyboard = pendingModerationKeyboard(user.id, message_id);
        const sent = await ctx.api.sendMessage(config.moderationChatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
        await setReactionModSession(user.id, {
          moderationMessageId: sent.message_id,
          strikeCount: 1,
          firstAt: now,
          lastDiscussionMessageId: message_id,
          reasons: risk.reasons,
          reactionEvents: [thisEvent],
        }, ttlSec);
        return;
      }

      const strikeCount = session.strikeCount + 1;
      const lastDiscussionMessageId = message_id;
      const reactionEvents = [...(session.reactionEvents ?? []), thisEvent];

      if (strikeCount >= 2 && now - session.firstAt <= windowMs) {
        await executeReactionBan({
          api: ctx.api,
          user,
          userId: user.id,
          reasons: session.reasons && session.reasons.length > 0 ? session.reasons : risk.reasons,
          discussionMessageId: lastDiscussionMessageId,
          logTitle: "Автобан",
          reactionEvents,
          replaceModerationMessageId: session.moderationMessageId,
        });
        await deleteReactionModSession(user.id);
        return;
      }

      const next = {
        ...session,
        strikeCount,
        lastDiscussionMessageId,
        reactionEvents,
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
