import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import { config } from "../config.js";
import {
  discussionPostPublicLink,
  escapeHtml,
  formatActorChatHtml,
  logError,
  logInfo,
} from "../logger.js";
import {
  buildPendingModerationText,
  buildReactionWarningHtml,
  pendingModerationKeyboard,
} from "../moderation-card.js";
import { computeRisk, hasSpamNickname, isAdminAnywhere } from "../moderation.js";
import { executeReactionBan } from "../post-ban.js";
import {
  deleteReactionModSession,
  getReactionModSession,
  isReactionLeaveAlone,
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
        const msgUrl = discussionPostPublicLink(config.chatId, message_id);
        const em = reactionEmojis(new_reaction).map(escapeHtml).join(" ");
        const actorLine = formatActorChatHtml(actor_chat);
        const msgLink = `<a href="${escapeHtml(msgUrl)}">сообщение ${message_id}</a>`;

        let banLine: string;
        if (actor_chat.id === config.channelId) {
          banLine =
            "\n\n<b>Исключение из обсуждения:</b> не выполнялось — это привязанный канал (реакция от его имени).";
        } else if (actor_chat.id === config.chatId) {
          banLine =
            "\n\n<b>Исключение из обсуждения:</b> не выполнялось — источник совпадает с чатом обсуждения.";
        } else {
          try {
            await ctx.api.banChatMember(config.chatId, actor_chat.id, { revoke_messages: true });
            banLine = "\n\n<b>Исключение из обсуждения:</b> выполнено (<code>banChatMember</code>).";
          } catch (err) {
            const desc =
              err instanceof GrammyError
                ? err.description
                : err instanceof Error
                  ? err.message
                  : String(err);
            banLine =
              `\n\n<b>Исключение из обсуждения:</b> API не дал — <code>${escapeHtml(desc)}</code>. ` +
              "Можно вручную ограничить участника по ссылке на чат выше (если это канал в группе — через список участников).";
          }
        }

        await logInfo(
          ctx.api,
          `ℹ️ <b>Анонимная реакция</b> ${em ? `(${em}) ` : ""}на ${msgLink}\n\n` +
            `<b>От чьего имени:</b> ${actorLine}.${banLine}`,
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

      if (await isReactionLeaveAlone(user.id)) {
        return;
      }

      // Спам-маркер в нике («НЕ НАЖИМАЙ СЮДА!» и тп) — характерная приманка
      // спам-ботов. Не ждём второго страйка, валим сразу после первой реакции.
      if (hasSpamNickname(user)) {
        const reasons = [...risk.reasons, "спам-маркер в нике"];
        const existing = await getReactionModSession(user.id);
        await executeReactionBan({
          api: ctx.api,
          user,
          userId: user.id,
          reasons,
          discussionMessageId: message_id,
          logTitle: "Автобан (спам-ник)",
          reactionEvents: [
            ...(existing?.reactionEvents ?? []),
            { messageId: message_id, emojis: reactionEmojis(new_reaction) },
          ],
          replaceModerationMessageId: existing?.moderationMessageId,
        });
        await deleteReactionModSession(user.id);
        return;
      }

      const now = Date.now();
      const windowMs = config.reactionAutoBanWindowMs;
      const windowSec = Math.round(windowMs / 1000);
      const ttlSec = config.reactionModSessionTtlSec;
      const cap = config.reactionAutoBanStrikes;

      let session = await getReactionModSession(user.id);
      if (session && now - session.firstAt > windowMs) {
        await deleteReactionModSession(user.id);
        session = null;
      }

      const thisEvent = { messageId: message_id, emojis: reactionEmojis(new_reaction) };

      if (!session) {
        const text = buildPendingModerationText(user, risk.reasons, 1, windowSec, cap);
        const keyboard = pendingModerationKeyboard(user.id, message_id);
        const sent = await ctx.api.sendMessage(config.moderationChatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });

        // Публичный варн в основном чате — пинг + счётчик.
        const warningChatMessageId = await sendPublicWarning(ctx.api, {
          user,
          strikeCount: 1,
          cap,
        });

        await setReactionModSession(user.id, {
          moderationMessageId: sent.message_id,
          warningChatMessageId,
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

      if (strikeCount >= cap && now - session.firstAt <= windowMs) {
        // Сначала «закрываем» публичный варн в чате — морфим в «заблокирован».
        await editPublicWarning(ctx.api, session.warningChatMessageId, {
          user,
          strikeCount: cap,
          cap,
        });

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

      const editText = buildPendingModerationText(user, risk.reasons, strikeCount, windowSec, cap);
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

      // И обновляем счётчик в публичном варне (1/3 → 2/3).
      await editPublicWarning(ctx.api, session.warningChatMessageId, {
        user,
        strikeCount,
        cap,
      });
    } catch (err) {
      console.error("reaction handler failed:", err);
      await logError(ctx.api, `обработка реакции от ${user.id}`, err);
    }
  });
}

async function sendPublicWarning(
  api: Bot["api"],
  params: {
    user: Parameters<typeof buildReactionWarningHtml>[0];
    strikeCount: number;
    cap: number;
  },
): Promise<number | undefined> {
  try {
    const text = buildReactionWarningHtml(params.user, params.strikeCount, params.cap);
    const sent = await api.sendMessage(config.chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return sent.message_id;
  } catch (err) {
    console.error("[reaction] sendPublicWarning failed", err);
    return undefined;
  }
}

async function editPublicWarning(
  api: Bot["api"],
  messageId: number | undefined,
  params: {
    user: Parameters<typeof buildReactionWarningHtml>[0];
    strikeCount: number;
    cap: number;
  },
): Promise<void> {
  if (messageId === undefined) return;
  try {
    const text = buildReactionWarningHtml(params.user, params.strikeCount, params.cap);
    await api.editMessageText(config.chatId, messageId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    // Если сообщение удалили или текст не изменился — не страшно.
    console.error("[reaction] editPublicWarning failed", err);
  }
}
