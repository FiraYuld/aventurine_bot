import type { Bot, Context } from "grammy";
import { GrammyError } from "grammy";
import type { User } from "grammy/types";
import { config } from "../config.js";
import { formatUserLine, logError, logInfo } from "../logger.js";
import { computeRisk } from "../moderation.js";
import {
  buildReactionWarningHtml,
  buildReactionWarningResolvedHtml,
  buildReactionWarningSubscribedHtml,
  parseReactionModCallback,
} from "../moderation-card.js";
import { executeReactionBan } from "../post-ban.js";
import {
  deleteReactionModSession,
  getReactionModSession,
  type ReactionModSession,
  setReactionLeaveAlone,
  withReactionUserLock,
} from "../reaction-mod-session.js";

async function safeAnswer(
  ctx: Context,
  other?: Parameters<Context["answerCallbackQuery"]>[0],
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(other);
  } catch (e) {
    // Через ~минуту Telegram возвращает «query is too old» — это ок, само
    // действие к этому моменту уже выполнилось.
    const msg = e instanceof GrammyError ? e.description : String(e);
    console.error("[mod-callback] answerCallbackQuery failed", msg);
  }
}

/**
 * Пробует достать User из чата обсуждения, при неудаче — из канала.
 * Возвращает null, если оба варианта не сработали (например, юзер удалил
 * аккаунт или Telegram его не находит).
 */
async function fetchUser(
  api: Context["api"],
  userId: number,
): Promise<User | null> {
  for (const chatId of [config.chatId, config.channelId]) {
    try {
      const member = await api.getChatMember(chatId, userId);
      return member.user;
    } catch {
      // пробуем следующий
    }
  }
  return null;
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

    const { kind, userId, discussionMessageId } = parsed;
    const msg = ctx.callbackQuery.message;
    if (!msg || !("message_id" in msg)) {
      await safeAnswer(ctx, { text: "Нет сообщения" });
      return;
    }

    const modMessageId = msg.message_id;
    // Same per-user lock as the reaction handler: a button press must not race a new reaction.
    await withReactionUserLock(userId, async () => {
      const session = await getReactionModSession(userId);

      // Если есть АКТУАЛЬНАЯ сессия для другой (более свежей) карточки —
      // не даём действовать со старой, чтобы поведение не размазывалось.
      // А вот «нет сессии» = всё ок, идём в stale-path: решение модератора важнее.
      if (session && session.moderationMessageId !== modMessageId) {
        await safeAnswer(ctx, {
          text: "Есть свежая карточка для этого юзера — действуй там.",
        });
        return;
      }

      if (kind === "k") {
        if (session) {
          await handleKeepFresh(ctx, { session, userId, modMessageId });
        } else {
          await handleKeepStale(ctx, { userId, modMessageId });
        }
        return;
      }

      if (session) {
        await handleBanFresh(ctx, { session, userId, modMessageId });
      } else {
        await handleBanStale(ctx, {
          userId,
          modMessageId,
          discussionMessageId,
        });
      }
    });
  });
}

// ---- Fresh-path: сессия есть, всё как было ----

async function handleKeepFresh(
  ctx: Context,
  params: { session: ReactionModSession; userId: number; modMessageId: number },
): Promise<void> {
  const { session, userId, modMessageId } = params;

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

    if (session.warningChatMessageId !== undefined) {
      try {
        const member = await ctx.api.getChatMember(config.chatId, userId);
        await ctx.api.editMessageText(
          config.chatId,
          session.warningChatMessageId,
          buildReactionWarningResolvedHtml(member.user),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
      } catch (err) {
        console.error("[mod-callback] edit public warning (keep) failed", err);
      }
    }

    await deleteReactionModSession(userId);
    await setReactionLeaveAlone(userId, config.reactionLeaveAloneTtlSec);
  } catch (err) {
    await logError(ctx.api, "правка сообщения «оставили»", err);
  }
}

async function handleBanFresh(
  ctx: Context,
  params: { session: ReactionModSession; userId: number; modMessageId: number },
): Promise<void> {
  const { session, userId, modMessageId } = params;
  const replyToMessageId = session.lastDiscussionMessageId;

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
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
        );

        if (session.warningChatMessageId !== undefined) {
          try {
            await ctx.api.editMessageText(
              config.chatId,
              session.warningChatMessageId,
              buildReactionWarningSubscribedHtml(member.user),
              { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
            );
          } catch (err) {
            console.error(
              "[mod-callback] edit public warning (subscribed) failed",
              err,
            );
          }
        }

        await deleteReactionModSession(userId);
      } catch (err) {
        await logError(ctx.api, "правка сообщения «не баним»", err);
      }
      return;
    }

    const reasonsForLog =
      session.reasons && session.reasons.length > 0 ? session.reasons : risk.reasons;

    if (session.warningChatMessageId !== undefined) {
      try {
        const cap = config.reactionAutoBanStrikes;
        await ctx.api.editMessageText(
          config.chatId,
          session.warningChatMessageId,
          buildReactionWarningHtml(member.user, cap, cap),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
      } catch (err) {
        console.error("[mod-callback] edit public warning (ban) failed", err);
      }
    }

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
}

// ---- Stale-path: сессия истекла, действуем по callback_data ----

async function handleKeepStale(
  ctx: Context,
  params: { userId: number; modMessageId: number },
): Promise<void> {
  const { userId, modMessageId } = params;

  await safeAnswer(ctx, { text: "Ок (после истечения)" });

  // Идемпотентный разбан в обоих местах: only_if_banned гарантирует, что
  // мы не «разбаним» юзера, который и не был забанен.
  const unbanned: { chat: boolean; channel: boolean; errors: string[] } = {
    chat: false,
    channel: false,
    errors: [],
  };

  for (const [label, key, chatId] of [
    ["чат", "chat" as const, config.chatId],
    ["канал", "channel" as const, config.channelId],
  ] as const) {
    try {
      // Сначала проверим, был ли реально kicked, чтобы корректно отчитаться.
      let wasBanned = false;
      try {
        const m = await ctx.api.getChatMember(chatId, userId);
        wasBanned = m.status === "kicked";
      } catch {
        // не удалось получить — спишем, но всё равно попробуем unban
      }
      await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true });
      unbanned[key] = wasBanned;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unbanned.errors.push(`${label}: ${msg}`);
    }
  }

  await setReactionLeaveAlone(userId, config.reactionLeaveAloneTtlSec);

  const wasUnbanned = unbanned.chat || unbanned.channel;
  const userTail = `<code>${userId}</code>`;
  const unbanTail = wasUnbanned
    ? `\n\n♻️ Разбанили: ${[
        unbanned.chat ? "чат" : null,
        unbanned.channel ? "канал" : null,
      ]
        .filter(Boolean)
        .join(", ")}.`
    : "";
  const errTail =
    unbanned.errors.length > 0
      ? `\n\n⚠️ Ошибки разбана: ${unbanned.errors.join("; ")}`
      : "";

  try {
    await ctx.api.editMessageText(
      config.moderationChatId,
      modMessageId,
      `✅ <b>Оставили</b> (сессия истекла)\n\nПользователь ${userTail} — без бана. Иммунитет от автомодерации продлён.${unbanTail}${errTail}`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    );
  } catch (err) {
    console.error("[mod-callback] edit moderation card (stale keep) failed", err);
  }

  // Если действительно сняли бан, имеет смысл засветить это в админ-логе:
  // ситуация неординарная (модератор откатывает автобан).
  if (wasUnbanned) {
    try {
      const user = await fetchUser(ctx.api, userId);
      const userLine = user
        ? formatUserLine(user)
        : `<code>${userId}</code> (getChatMember не дал)`;
      await logInfo(
        ctx.api,
        `♻️ <b>Разбан после кнопки «Оставить»</b> (сессия истекла)\n\n` +
          `Пользователь: ${userLine}\n` +
          `Где: ${[
            unbanned.chat ? "чат" : null,
            unbanned.channel ? "канал" : null,
          ]
            .filter(Boolean)
            .join(", ")}`,
      );
    } catch (err) {
      console.error("[mod-callback] info log (stale unban) failed", err);
    }
  }
}

async function handleBanStale(
  ctx: Context,
  params: { userId: number; modMessageId: number; discussionMessageId: number },
): Promise<void> {
  const { userId, modMessageId, discussionMessageId } = params;

  await safeAnswer(ctx, { text: "Бан (после истечения)" });

  const user = await fetchUser(ctx.api, userId);
  if (!user) {
    try {
      await ctx.api.editMessageText(
        config.moderationChatId,
        modMessageId,
        `⚠️ <b>Не смог взять юзера</b>\n\n<code>${userId}</code> — getChatMember не дал данных ни в чате, ни в канале. Бан не выполнен.`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      );
    } catch (err) {
      console.error("[mod-callback] edit card (stale ban, no user) failed", err);
    }
    return;
  }

  // Стараемся подобрать актуальные причины для лога; если computeRisk
  // упал — не критично, отправим базовую формулировку.
  let reasons: string[];
  try {
    const risk = await computeRisk(ctx.api, user);
    reasons =
      risk.reasons.length > 0
        ? risk.reasons
        : ["ручной бан по кнопке (сессия истекла)"];
  } catch {
    reasons = ["ручной бан по кнопке (сессия истекла)"];
  }

  try {
    await executeReactionBan({
      api: ctx.api,
      user,
      userId,
      reasons,
      discussionMessageId,
      logTitle: "Бан по кнопке",
      // reactionEvents здесь нет: история по сообщениям ушла вместе с сессией.
      replaceModerationMessageId: modMessageId,
    });
  } catch (err) {
    await logError(ctx.api, "callback «забанить» (stale)", err);
  }
}
