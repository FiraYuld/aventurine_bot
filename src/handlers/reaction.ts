import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import { config } from "../config.js";
import { escapeHtml, logError } from "../logger.js";
import {
  buildChannelCardHtml,
  CHANNEL_CARD_TTL_SEC,
  channelCardKeyboard,
  channelCardResultHtml,
  parseChannelCardCallback,
} from "../channel-reaction-card.js";
import { getRedis } from "../redis.js";
import {
  buildPendingModerationText,
  buildReactionWarningHtml,
  pendingModerationKeyboard,
} from "../moderation-card.js";
import { addIgnoredChannel, isChannelIgnored } from "../ignored-channels.js";
import { computeRisk, hasSpamNickname, isAdminAnywhere } from "../moderation.js";
import { executeReactionBan } from "../post-ban.js";
import {
  deleteReactionModSession,
  getReactionModSession,
  isReactionLeaveAlone,
  withReactionUserLock,
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

/** Reactions on behalf of these chats are never moderated or reported. */
export function isTrustedActorChat(
  actorChatId: number,
  own: { channelId: number; chatId: number },
): boolean {
  return actorChatId === own.channelId || actorChatId === own.chatId;
}

function errorText(err: unknown): string {
  if (err instanceof GrammyError) return err.description;
  return err instanceof Error ? err.message : String(err);
}

const channelCardKey = (channelId: number) => `anoncard:${channelId}`;

export function registerReactionHandler(bot: Bot): void {
  // Ban / Keep under a channel-reaction card (moderation chat only — scope middleware).
  // Registered before registerModerationCallbacks, whose catch-all would swallow it.
  bot.callbackQuery(/^ac:[bk]:-\d+$/, async (ctx) => {
    const parsed = parseChannelCardCallback(ctx.callbackQuery.data);
    const msg = ctx.callbackQuery.message;
    if (!parsed || !msg) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const { action, channelId } = parsed;
    await ctx.answerCallbackQuery({ text: action === "ban" ? "Баню канал…" : "Оставляю" }).catch(() => {});

    const errors: string[] = [];
    if (action === "ban") {
      try {
        // A channel acting in the group is a *sender chat*: banChatMember rejects it with
        // "invalid user_id specified"; banChatSenderChat is the right method.
        await ctx.api.banChatSenderChat(config.chatId, channelId);
      } catch (err) {
        errors.push(`бан не прошёл: ${errorText(err)}`);
      }
      try {
        await ctx.api.deleteAllMessageReactionsChat(config.chatId, channelId);
      } catch (err) {
        errors.push(`реакции не сняты: ${errorText(err)}`);
      }
    } else {
      try {
        await addIgnoredChannel(channelId);
      } catch (err) {
        errors.push(`не добавлен в ignore-list: ${errorText(err)}`);
      }
    }
    await getRedis().del(channelCardKey(channelId)).catch(() => {});

    const original = "text" in msg && msg.text ? escapeHtml(msg.text) : "";
    try {
      await ctx.api.editMessageText(
        msg.chat.id,
        msg.message_id,
        `${original ? original + "\n\n" : ""}${channelCardResultHtml(action, ctx.from, channelId, errors)}`,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        },
      );
    } catch (err) {
      console.error("[channel-card] edit failed", err);
    }
  });

  bot.on("message_reaction", async (ctx) => {
    const update = ctx.messageReaction;
    const { user, actor_chat, new_reaction, old_reaction, chat, message_id } = update;

    if (chat.id !== config.chatId) return;

    if (!shouldProcessReactionChange(new_reaction, old_reaction)) {
      return;
    }

    if (!user) {
      if (actor_chat) {
        // Our own channel, the chat itself (anonymous admins) and ignore-listed channels
        // may react freely: no action and no notice.
        const trusted = isTrustedActorChat(actor_chat.id, {
          channelId: config.channelId,
          chatId: config.chatId,
        });
        if (trusted || (await isChannelIgnored(actor_chat.id))) return;

        // Any other channel: no automatic action, moderators decide via a card.
        // One open card per channel, so a busy channel can't flood the moderation chat.
        try {
          const fresh = await getRedis().set(channelCardKey(actor_chat.id), "1", {
            nx: true,
            ex: CHANNEL_CARD_TTL_SEC,
          });
          if (fresh !== "OK") return;
          await ctx.api.sendMessage(
            config.moderationChatId,
            buildChannelCardHtml({
              actorChat: actor_chat,
              chatId: config.chatId,
              messageId: message_id,
              emojis: reactionEmojis(new_reaction),
            }),
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: channelCardKeyboard(actor_chat.id),
            },
          );
        } catch (err) {
          await logError(ctx.api, `карточка реакции канала ${actor_chat.id}`, err);
        }
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

    // One user at a time: parallel webhook deliveries must not race on the session.
    await withReactionUserLock(user.id, async () => {
      try {
        // Subscription first (1 API call): most reactors are subscribers and stop here.
        // The admin check (2 calls) only matters for unsubscribed chat admins.
        const risk = await computeRisk(ctx.api, user);
        if (!risk.shouldBan) return;

        if (await isAdminAnywhere(ctx.api, user.id)) return;

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
