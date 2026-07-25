import type { Bot, CommandContext, Context } from "grammy";
import { config, isLlmUnlimitedDmUser, isOwnerUserId } from "../config.js";
import {
  addIgnoredChannel,
  listIgnoredChannels,
  removeIgnoredChannel,
} from "../ignored-channels.js";
import { escapeHtml } from "../logger.js";
import { isAdminAnywhere } from "../moderation.js";
import { clearReactionLeaveAlone } from "../reaction-mod-session.js";
import {
  currentDateKey,
  getGlobalMessageCounter,
  getLlmDmUsed,
  getRandomUsed,
  getUserUsed,
  resetAllUserQuotasForToday,
  resetLlmDmUsageForToday,
  resetGlobalMessageCounterForToday,
  resetRandomQuotaForToday,
  resetUserLimitNoticeForToday,
  resetUserQuotaForToday,
  ttlUntilMidnightSec,
} from "../chat/limits.js";

function isOwner(userId: number): boolean {
  return isOwnerUserId(userId);
}

export const HELP_TEXT = `
<b>Авантюрин</b> — модератор реакций.

Что я делаю:
• Слежу за реакциями в привязанном чате обсуждения.
• Если кто-то ставит реакцию, но не подписан на канал — карточка в чат модерации с кнопками «Забанить» / «Оставить»; бот-аккаунты баню сразу.
• При 2+ таких реакциях за 60 с (в т.ч. на разных постах) без решения админов — автобан.
• После бана отвечаю в чате обсуждения фразой «Схватил бота за жёпу!».
• Логи банов и очередь — в MODERATION_CHAT_ID; ошибки — владельцу в ЛС.

Команды:
/ping, /status, /start, /help — только владелец (ADMIN_LOG_CHAT_ID).
/limits [@username] — только владелец: суточные LLM-лимиты и счётчик лички (без лимита).
/limits_reset [@username] — только владелец: сбросить суточные LLM-лимиты (сегодня).
/limits_reset_all — только владелец: сбросить лимиты всем пользователям (сегодня).
/clear_react_leave user_id — только владелец: снять иммунитет после кнопки «Оставить».
/ignore_channel &lt;id|@username&gt; — только владелец: добавить канал в ignore-list (его реакции не считаются спамом).
/ignore_channel_remove &lt;id|@username&gt; — только владелец: убрать канал из ignore-list.
/ignore_channel_list — только владелец: показать ignore-list.
/post — только владелец: мастер публикации фото-поста с URL-кнопками в CHANNEL_ID.
/cancel — только владелец: отменить активный черновик публикации.
/unban — владелец или администраторы канала/чата обсуждения.
`.trim();

export function registerCommands(bot: Bot): void {
  bot.command("start", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  bot.command("ping", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await ctx.reply("pong");
  });

  bot.command("limits", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const arg = ctx.match?.toString().trim();
    const userId = await resolveUserId(ctx, arg);
    if (!userId) {
      await ctx.reply("Использование: /limits [@username]");
      return;
    }

    const [usedUser, usedRandom, msgcnt, llmDmUsed] = await Promise.all([
      getUserUsed(userId),
      getRandomUsed(),
      getGlobalMessageCounter(),
      isLlmUnlimitedDmUser(userId) ? getLlmDmUsed(userId) : Promise.resolve(null),
    ]);

    const date = currentDateKey();
    const ttl = ttlUntilMidnightSec();
    let text =
      `<b>LLM лимиты (сегодня)</b>\n` +
      `дата: <code>${date}</code>, ttl до полуночи: <code>${ttl}</code> сек\n\n` +
      `<b>Пользователь</b> <code>${userId}</code>\n` +
      `used: <code>${usedUser}</code> / cap: <code>${config.chatUserDailyCap}</code>\n\n` +
      `<b>Чат</b>\n` +
      `random used: <code>${usedRandom}</code> / cap: <code>${config.chatDailyRandomCap}</code>\n` +
      `msg counter: <code>${msgcnt}</code> (для шага N)\n`;

    if (llmDmUsed !== null) {
      text +=
        `\n<b>LLM в личке (без лимита)</b>\n` +
        `ответов бота сегодня: <code>${llmDmUsed}</code>`;
    }

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("limits_reset", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const arg = ctx.match?.toString().trim();
    const userId = await resolveUserId(ctx, arg);
    if (!userId) {
      await ctx.reply("Использование: /limits_reset [@username]");
      return;
    }

    await Promise.all([
      resetUserQuotaForToday(userId),
      resetUserLimitNoticeForToday(userId),
      isLlmUnlimitedDmUser(userId) ? resetLlmDmUsageForToday(userId) : Promise.resolve(),
    ]);

    const dmNote = isLlmUnlimitedDmUser(userId)
      ? " (включая счётчик LLM в личке)"
      : "";
    await ctx.reply(
      `Сбросил LLM-лимиты на сегодня${dmNote}.\nuser <code>${userId}</code> очищен.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("limits_reset_all", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const { users } = await resetAllUserQuotasForToday().catch(() => ({ users: 0 }));
    await Promise.all([resetRandomQuotaForToday(), resetGlobalMessageCounterForToday()]);

    await ctx.reply(
      `Сбросил лимиты на сегодня для всех.\nusers очищено: <code>${users}</code>`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const checks: string[] = [];

    try {
      const me = await ctx.api.getMe();
      checks.push(`Бот: @${me.username} (<code>${me.id}</code>)`);
    } catch (err) {
      checks.push(`Не удалось получить getMe: ${(err as Error).message}`);
    }

    for (const [label, id] of [
      ["Канал", config.channelId],
      ["Чат обсуждения", config.chatId],
      ["Чат модерации", config.moderationChatId],
    ] as const) {
      try {
        const chat = await ctx.api.getChat(id);
        const title = "title" in chat ? chat.title : "(?)";
        const me = await ctx.api.getChatMember(id, (await ctx.api.getMe()).id);
        const status = me.status;
        const canRestrict =
          (me.status === "administrator" && me.can_restrict_members) ||
          me.status === "creator";
        checks.push(
          `${label} <code>${id}</code> «${title}»: статус <code>${status}</code>, ` +
            `банить может: ${canRestrict ? "да" : "<b>нет</b>"}`,
        );
      } catch (err) {
        checks.push(`${label} <code>${id}</code>: ошибка — ${(err as Error).message}`);
      }
    }

    await ctx.reply(checks.join("\n\n"), { parse_mode: "HTML" });
  });

  bot.command("clear_react_leave", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const arg = ctx.match?.toString().trim();
    const userId = Number(arg);
    if (!arg || !Number.isInteger(userId) || userId <= 0) {
      await ctx.reply("Использование: /clear_react_leave user_id (положительное число)");
      return;
    }

    const had = await clearReactionLeaveAlone(userId);
    await ctx.reply(
      had
        ? `Иммунитет после «Оставить» снят для <code>${userId}</code>.`
        : `Для <code>${userId}</code> не было активного иммунитета.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("ignore_channel", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply("Использование: /ignore_channel <id|@username>");
      return;
    }

    const channelId = await resolveChannelId(ctx, arg);
    if (channelId === null) {
      await ctx.reply(
        "Не смог распознать канал. Жду отрицательный id (например, <code>-1001234567890</code>) или <code>@username</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    if (channelId === config.channelId) {
      await ctx.reply(
        "Это привязанный канал — он и так исключён по умолчанию, добавлять в список не нужно.",
      );
      return;
    }
    if (channelId === config.chatId) {
      await ctx.reply(
        "Это сам чат обсуждения — он и так исключён по умолчанию, добавлять в список не нужно.",
      );
      return;
    }

    const added = await addIgnoredChannel(channelId);
    await ctx.reply(
      added
        ? `Канал <code>${channelId}</code> добавлен в ignore-list. Реакции от его имени больше не будут считаться спамом.`
        : `Канал <code>${channelId}</code> уже был в ignore-list.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("ignore_channel_remove", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply("Использование: /ignore_channel_remove <id|@username>");
      return;
    }

    const channelId = await resolveChannelId(ctx, arg);
    if (channelId === null) {
      await ctx.reply(
        "Не смог распознать канал. Жду отрицательный id или <code>@username</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const removed = await removeIgnoredChannel(channelId);
    await ctx.reply(
      removed
        ? `Канал <code>${channelId}</code> убран из ignore-list.`
        : `Канал <code>${channelId}</code> не был в ignore-list.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("ignore_channel_list", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;

    const ids = await listIgnoredChannels();
    if (ids.length === 0) {
      await ctx.reply("Ignore-list пуст.");
      return;
    }

    const lines: string[] = [];
    for (const id of ids) {
      try {
        const chat = await ctx.api.getChat(id);
        const title = "title" in chat && chat.title ? chat.title : "(без названия)";
        const username = "username" in chat && chat.username ? chat.username : "";
        const userPart = username ? ` @${escapeHtml(username)}` : "";
        lines.push(`• <code>${id}</code> — ${escapeHtml(title)}${userPart}`);
      } catch {
        lines.push(`• <code>${id}</code> — (не удалось получить getChat)`);
      }
    }

    await ctx.reply(
      `<b>Ignore-list каналов</b> (${ids.length}):\n${lines.join("\n")}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("unban", async (ctx) => {
    if (!ctx.from) return;
    const allowed =
      isOwner(ctx.from.id) || (await isAdminAnywhere(ctx.api, ctx.from.id));
    if (!allowed) return;

    const arg = ctx.match?.toString().trim();
    const userId = Number(arg);
    if (!arg || !Number.isInteger(userId)) {
      await ctx.reply("Использование: /unban <user_id>");
      return;
    }

    const results: string[] = [];
    for (const [label, chatId] of [
      ["чат", config.chatId],
      ["канал", config.channelId],
    ] as const) {
      try {
        await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true });
        results.push(`✓ ${label}`);
      } catch (err) {
        results.push(`✗ ${label}: ${(err as Error).message}`);
      }
    }
    await ctx.reply(`Разбан <code>${userId}</code>:\n${results.join("\n")}`, {
      parse_mode: "HTML",
    });
  });
}

async function resolveUserId(
  ctx: CommandContext<Context>,
  arg: string | undefined,
): Promise<number | null> {
  const raw = (arg ?? "").trim();
  if (!raw) return ctx.from?.id ?? null;

  // Требуем @username (но оставим число как fallback).
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  if (!raw.startsWith("@")) return null;

  try {
    const chat = await ctx.api.getChat(raw);
    // Для пользователя это будет private-чат с положительным id.
    if (chat && "id" in chat && typeof chat.id === "number" && chat.id > 0) return chat.id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Резолвит произвольный аргумент в ID канала (отрицательное число).
 * Принимает: отрицательное целое (как в supergroup/channel id, например
 * <code>-1001234567890</code>) или <code>@username</code>. Положительные id
 * не принимаются — они адресуют пользователей, а не каналы.
 */
async function resolveChannelId(
  ctx: CommandContext<Context>,
  arg: string,
): Promise<number | null> {
  const raw = arg.trim();
  if (!raw) return null;

  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n >= 0) return null;
    return n;
  }

  const username = raw.startsWith("@") ? raw : `@${raw}`;
  try {
    const chat = await ctx.api.getChat(username);
    if (chat && "id" in chat && typeof chat.id === "number" && chat.id < 0) {
      return chat.id;
    }
    return null;
  } catch {
    return null;
  }
}
