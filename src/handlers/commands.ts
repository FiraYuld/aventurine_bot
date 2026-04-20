import type { Bot } from "grammy";
import { config } from "../config.js";
import { isAdminAnywhere } from "../moderation.js";
import { clearReactionLeaveAlone } from "../reaction-mod-session.js";
import {
  currentDateKey,
  getGlobalMessageCounter,
  getRandomUsed,
  getUserUsed,
  resetAllUserQuotasForToday,
  resetGlobalMessageCounterForToday,
  resetRandomQuotaForToday,
  resetUserLimitNoticeForToday,
  resetUserQuotaForToday,
  ttlUntilMidnightSec,
} from "../chat/limits.js";

function isOwner(userId: number): boolean {
  return userId === config.adminLogChatId;
}

const HELP_TEXT = `
<b>Авантюрин</b> — модератор реакций.

Что я делаю:
• Слежу за реакциями в привязанном чате обсуждения.
• Если кто-то ставит реакцию, но не подписан на канал — карточка в чат модерации с кнопками «Забанить» / «Оставить»; бот-аккаунты баню сразу.
• При 2+ таких реакциях за 60 с (в т.ч. на разных постах) без решения админов — автобан.
• После бана отвечаю в чате обсуждения фразой «Схватил бота за жёпу!».
• Логи банов и очередь — в MODERATION_CHAT_ID; ошибки — владельцу в ЛС.

Команды:
/ping, /status, /start, /help — только владелец (ADMIN_LOG_CHAT_ID).
/limits [@username] — только владелец: показать суточные LLM-лимиты (сегодня).
/limits_reset [@username] — только владелец: сбросить суточные LLM-лимиты (сегодня).
/limits_reset_all — только владелец: сбросить лимиты всем пользователям (сегодня).
/clear_react_leave user_id — только владелец: снять иммунитет после кнопки «Оставить».
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

    const [usedUser, usedRandom, msgcnt] = await Promise.all([
      getUserUsed(userId),
      getRandomUsed(),
      getGlobalMessageCounter(),
    ]);

    const date = currentDateKey();
    const ttl = ttlUntilMidnightSec();
    const text =
      `<b>LLM лимиты (сегодня)</b>\n` +
      `дата: <code>${date}</code>, ttl до полуночи: <code>${ttl}</code> сек\n\n` +
      `<b>Пользователь</b> <code>${userId}</code>\n` +
      `used: <code>${usedUser}</code> / cap: <code>${config.chatUserDailyCap}</code>\n\n` +
      `<b>Чат</b>\n` +
      `random used: <code>${usedRandom}</code> / cap: <code>${config.chatDailyRandomCap}</code>\n` +
      `msg counter: <code>${msgcnt}</code> (для шага N)\n`;

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
    ]);

    await ctx.reply(
      `Сбросил LLM-лимиты на сегодня.\nuser <code>${userId}</code> очищен.`,
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
  ctx: Parameters<Parameters<typeof registerCommands>[0]["command"]>[1],
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
