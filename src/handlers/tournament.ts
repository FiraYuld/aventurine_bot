import type { Api, Bot } from "grammy";
import { config } from "../config.js";
import {
  applyJoinCardAction,
  buildJoinLogHtml,
  isBan,
  isJoin,
  parseJoinCardCallback,
  type JoinCardDeps,
} from "../join-log.js";
import { escapeHtml, logError } from "../logger.js";
import { getRedis } from "../redis.js";
import {
  guardNewcomerLink,
  LINK_CARD_TTL_SEC,
  markNewcomer,
  NEWCOMER_WINDOW_SEC,
  parseTournamentCallback,
  recordJoin,
  TOURNAMENT_CARD_TTL_SEC,
  TOURNAMENT_JOIN_MSG_TTL_SEC,
  tournamentBan,
  tournamentUnmute,
  tournamentWipe,
  type TournamentCard,
  type TournamentDeps,
  type TournamentStore,
} from "../tournament.js";
import { isInside, readCurrentProfile, readProfile } from "./join-log.js";

/**
 * Redis keys (separate from the discussion chat's joinmsg:/joinlog:):
 *   tnew:<uid>     — newcomer marker, value = join time (15 min)
 *   tlink:<uid>    — one link card per user (24 h)
 *   tcard:<uid>    — moderation-chat card + its HTML (14 days)
 *   tjoinmsg:<uid> — "… joined the group" service message ids (48 h)
 */
function createStore(): TournamentStore {
  const r = getRedis();
  return {
    async getJoinedAt(userId) {
      const v: unknown = await r.get(`tnew:${userId}`);
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    },
    async markJoined(userId, at) {
      await r.set(`tnew:${userId}`, String(at), { nx: true, ex: NEWCOMER_WINDOW_SEC });
    },
    async clearJoined(userId) {
      await r.del(`tnew:${userId}`, `tlink:${userId}`);
    },
    async claimLinkCard(userId) {
      return (await r.set(`tlink:${userId}`, "1", { nx: true, ex: LINK_CARD_TTL_SEC })) === "OK";
    },
    async hasLinkCard(userId) {
      return (await r.exists(`tlink:${userId}`)) > 0;
    },
    async getCard(userId) {
      const raw: unknown = await r.get(`tcard:${userId}`);
      const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      if (
        obj &&
        typeof obj === "object" &&
        typeof (obj as TournamentCard).messageId === "number" &&
        typeof (obj as TournamentCard).html === "string"
      ) {
        return obj as TournamentCard;
      }
      return null;
    },
    async setCard(userId, card) {
      await r.set(`tcard:${userId}`, JSON.stringify(card), { ex: TOURNAMENT_CARD_TTL_SEC });
    },
    async addJoinMessage(userId, messageId) {
      await r.sadd(`tjoinmsg:${userId}`, String(messageId));
      await r.expire(`tjoinmsg:${userId}`, TOURNAMENT_JOIN_MSG_TTL_SEC);
    },
    async takeJoinMessages(userId) {
      const raw = (await r.smembers(`tjoinmsg:${userId}`)) as unknown as Array<string | number>;
      await r.del(`tjoinmsg:${userId}`);
      return (Array.isArray(raw) ? raw : [])
        .map((v) => Number(v))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
    },
  };
}

let storeFactory: () => TournamentStore = createStore;

/** Tests only: replace the Redis store with a fake. */
export function setTournamentStoreForTests(factory: (() => TournamentStore) | undefined): void {
  storeFactory = factory ?? createStore;
}

function makeDeps(api: Api, tournamentChatId: number): TournamentDeps {
  return {
    api: api as unknown as TournamentDeps["api"],
    store: storeFactory(),
    tournamentChatId,
    moderationChatId: config.moderationChatId,
  };
}

/**
 * Tournament chat moderation. No-op when TOURNAMENT_CHAT_ID is not set.
 * Registered right after the scope middleware: it owns every update from the tournament
 * chat (so a "/command" can't slip a link past it) and passes everything else on.
 */
export function registerTournament(bot: Bot): void {
  const chatId = config.tournamentChatId;
  if (chatId === undefined) return;

  bot.on("message", async (ctx, next) => {
    if (ctx.chat.id !== chatId) return next();
    const msg = ctx.message;

    if (msg.new_chat_members) {
      const d = makeDeps(ctx.api, chatId);
      for (const u of msg.new_chat_members) {
        if (u.is_bot) continue;
        await Promise.all([
          d.store.addJoinMessage(u.id, msg.message_id),
          markNewcomer(d, u.id),
        ]).catch((err) => console.error("[tournament] remember join failed", err));
      }
      return;
    }

    try {
      const res = await guardNewcomerLink(makeDeps(ctx.api, chatId), msg);
      if (res.errors.length > 0) {
        await logError(ctx.api, `чат турниров: ссылка от ${msg.from?.id}`, res.errors.join("; "));
      }
    } catch (err) {
      await logError(ctx.api, `чат турниров: проверка сообщения ${msg.message_id}`, err);
    }
    // Nothing else handles the tournament chat: no next().
  });

  bot.on("chat_member", async (ctx, next) => {
    const upd = ctx.chatMember;
    if (upd.chat.id !== chatId) return next();
    const user = upd.new_chat_member.user;

    if (isBan(upd.old_chat_member, upd.new_chat_member)) {
      // Our own bans are handled by the button; a manual ban (a moderator, Iris…) is cleaned up here.
      if (upd.from.id === ctx.me.id) return;
      const errors = await tournamentBan(makeDeps(ctx.api, chatId), user.id, {
        by: upd.from,
        user,
        alreadyBanned: true,
      });
      if (errors.length > 0) {
        await logError(ctx.api, `чат турниров: после бана ${user.id}`, errors.join("; "));
      }
      return;
    }

    if (!isJoin(upd.old_chat_member, upd.new_chat_member)) return;
    const d = makeDeps(ctx.api, chatId);
    if (!user.is_bot) {
      await markNewcomer(d, user.id).catch((err) =>
        console.error("[tournament] mark newcomer failed", { userId: user.id, err }),
      );
    }
    try {
      const [profile, inChannel] = await Promise.all([
        readProfile(ctx.api, user),
        isInside(ctx.api, config.channelId, user.id),
      ]);
      const html = buildJoinLogHtml({
        user,
        place: "tournament",
        placeTitle: "title" in upd.chat && upd.chat.title ? upd.chat.title : String(chatId),
        alsoInOther: inChannel,
        viaInviteLinkName: upd.invite_link?.name ?? (upd.invite_link ? "без названия" : undefined),
        viaJoinRequest: upd.via_join_request,
        viaFolder: upd.via_chat_folder_invite_link,
        ...profile,
      });
      await recordJoin(d, user, html);
    } catch (err) {
      console.error("[tournament] join log failed", { userId: user.id, err });
    }
  });

  // "✅ Свой" / "↩️ Отменить" / "🔄 Профиль" on tournament cards.
  bot.callbackQuery(/^t:[orp]:\d+$/, async (ctx) => {
    const parsed = parseJoinCardCallback(ctx.callbackQuery.data);
    const msg = ctx.callbackQuery.message;
    if (!parsed || !msg) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const { action, userId } = parsed;
    const label = { confirm: "Отмечаю как своего", unconfirm: "Возвращаю кнопки", refresh: "Читаю профиль…" }[action];
    await ctx.answerCallbackQuery({ text: label }).catch(() => {});
    const store = storeFactory();
    try {
      // A confirmed person is no longer a newcomer: their links are not deleted.
      if (action === "confirm") await store.clearJoined(userId);
      await applyJoinCardAction(
        {
          api: ctx.api as unknown as JoinCardDeps["api"],
          getCard: (id) => store.getCard(id),
          setCard: async (id, e) => {
            const old = await store.getCard(id).catch(() => null);
            await store.setCard(id, { ...old, ...e });
          },
          moderationChatId: config.moderationChatId,
        },
        {
          prefix: "t",
          action,
          userId,
          messageId: msg.message_id,
          fallbackHtml: escapeHtml("text" in msg && msg.text ? msg.text : `ID ${userId}`),
          by: ctx.from,
          currentMarkup: "reply_markup" in msg ? msg.reply_markup : undefined,
          readProfile: async () => {
            const { current, ...profile } = await readCurrentProfile(ctx.api, userId);
            return { user: current, ...profile };
          },
        },
      );
    } catch (err) {
      await logError(ctx.api, `чат турниров: кнопка ${action} (${userId})`, err);
    }
  });

  // Buttons on tournament cards (moderation chat only — enforced by scope middleware).
  bot.callbackQuery(/^t:[buw]:\d+$/, async (ctx) => {
    const parsed = parseTournamentCallback(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const { action, userId } = parsed;
    const label = { ban: "Баню…", unmute: "Размучиваю…", wipe: "Удаляю сообщения…" }[action];
    await ctx.answerCallbackQuery({ text: label }).catch(() => {});
    const d = makeDeps(ctx.api, chatId);
    try {
      const errors =
        action === "ban"
          ? await tournamentBan(d, userId, { by: ctx.from })
          : action === "unmute"
            ? await tournamentUnmute(d, userId, ctx.from)
            : await tournamentWipe(d, userId, ctx.from);
      if (errors.length > 0) {
        await logError(ctx.api, `чат турниров: кнопка ${action} (${userId})`, errors.join("; "));
      }
    } catch (err) {
      await logError(ctx.api, `чат турниров: кнопка ${action} (${userId})`, err);
    }
  });
}
