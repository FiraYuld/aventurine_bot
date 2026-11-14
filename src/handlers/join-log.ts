import type { Api, Bot } from "grammy";
import type { User } from "grammy/types";
import { config } from "../config.js";
import {
  CLEANUP_DEDUPE_TTL_SEC,
  JOIN_LOG_TTL_SEC,
  JOIN_MESSAGE_TTL_SEC,
  parseWipeCallback,
  runBanFollowUp,
  runWipe,
  type CleanupStore,
} from "../ban-cleanup.js";
import {
  buildJoinLogHtml,
  isBan,
  isJoin,
  joinLogKeyboard,
  parseJoinBanCallback,
  type JoinLogInfo,
  type PersonalChannelInfo,
} from "../join-log.js";
import { logError } from "../logger.js";
import { getRedis } from "../redis.js";

const INSIDE = new Set(["creator", "administrator", "member"]);

async function isInside(api: Api, chatId: number, userId: number): Promise<boolean | undefined> {
  try {
    const m = await api.getChatMember(chatId, userId);
    return INSIDE.has(m.status) || (m.status === "restricted" && m.is_member);
  } catch {
    return undefined;
  }
}

/** Reads bio + linked personal channel of a user. Never throws. */
async function readProfile(
  api: Api,
  user: User,
): Promise<Pick<JoinLogInfo, "bio" | "profileReadable" | "personalChannel">> {
  try {
    const full = await api.getChat(user.id);
    const bio = "bio" in full ? full.bio : undefined;
    const pcChat = "personal_chat" in full ? full.personal_chat : undefined;
    let personalChannel: PersonalChannelInfo | undefined;
    if (pcChat) {
      personalChannel = {
        id: pcChat.id,
        title: "title" in pcChat ? pcChat.title : undefined,
        username: "username" in pcChat ? pcChat.username : undefined,
      };
      try {
        const pcFull = await api.getChat(pcChat.id);
        if ("description" in pcFull && pcFull.description) {
          personalChannel.description = pcFull.description;
        }
      } catch {
        // private or inaccessible channel: title from personal_chat is enough
      }
    }
    return { bio, profileReadable: true, personalChannel };
  } catch (err) {
    console.error("[join-log] getChat(user) failed", { userId: user.id, err });
    return { profileReadable: false };
  }
}

const joinMsgKey = (userId: number) => `joinmsg:${userId}`;
const joinLogKey = (userId: number) => `joinlog:${userId}`;
const cleanupKey = (userId: number) => `bancleanup:${userId}`;

export function createCleanupStore(): CleanupStore {
  const r = getRedis();
  return {
    async claimCleanup(userId) {
      const ok = await r.set(cleanupKey(userId), "1", { nx: true, ex: CLEANUP_DEDUPE_TTL_SEC });
      return ok === "OK";
    },
    async getJoinMessageIds(userId) {
      const raw = (await r.smembers(joinMsgKey(userId))) as unknown as Array<string | number>;
      return (Array.isArray(raw) ? raw : [])
        .map((v) => Number(v))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
    },
    async clearJoinMessageIds(userId) {
      await r.del(joinMsgKey(userId));
    },
    async getJoinLog(userId) {
      const raw: unknown = await r.get(joinLogKey(userId));
      const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      if (
        obj &&
        typeof obj === "object" &&
        typeof (obj as { messageId?: unknown }).messageId === "number" &&
        typeof (obj as { html?: unknown }).html === "string"
      ) {
        return obj as { messageId: number; html: string };
      }
      return null;
    },
    async setJoinLog(userId, entry) {
      await rememberJoinLog(userId, entry.messageId, entry.html);
    },
  };
}

function cleanupDeps(api: Api) {
  return {
    api,
    store: createCleanupStore(),
    targets: {
      chatId: config.chatId,
      channelId: config.channelId,
      moderationChatId: config.moderationChatId,
    },
  };
}

async function rememberJoinMessage(userId: number, messageId: number): Promise<void> {
  const r = getRedis();
  await r.sadd(joinMsgKey(userId), String(messageId));
  await r.expire(joinMsgKey(userId), JOIN_MESSAGE_TTL_SEC);
}

async function rememberJoinLog(userId: number, messageId: number, html: string): Promise<void> {
  await getRedis().set(joinLogKey(userId), JSON.stringify({ messageId, html }), {
    ex: JOIN_LOG_TTL_SEC,
  });
}

/** Step 1 after a ban: reversible (ban in both places, join message, mark + wipe button). */
async function followUpAfterBan(api: Api, userId: number, opts: { by?: User; user?: User }): Promise<void> {
  const result = await runBanFollowUp(cleanupDeps(api), userId, opts);
  if (result.ran && result.errors.length > 0) {
    await logError(api, `действия после бана ${userId}`, result.errors.join("; "));
  }
}

/**
 * Must be registered BEFORE registerModerationCallbacks: that one is a catch-all
 * `callback_query:data` handler that answers and swallows unknown callbacks.
 */
export function registerJoinLog(bot: Bot): void {
  // "… joined the group" service messages: remember their ids to delete them on ban.
  bot.on("message:new_chat_members", async (ctx, next) => {
    if (ctx.chat.id === config.chatId) {
      for (const u of ctx.message.new_chat_members) {
        await rememberJoinMessage(u.id, ctx.message.message_id).catch((err) =>
          console.error("[join-log] remember join message failed", err),
        );
      }
    }
    await next();
  });

  bot.on("chat_member", async (ctx) => {
    const upd = ctx.chatMember;
    const chatId = upd.chat.id;
    const place = chatId === config.chatId ? "chat" : chatId === config.channelId ? "channel" : null;
    if (!place) return;
    const user = upd.new_chat_member.user;

    // Banned by someone else (Iris, a moderator by hand): ban in both places, offer the wipe.
    // Bans made by this bot are skipped: the reaction flow logs its own bans, and the
    // join-log button runs the follow-up itself.
    if (isBan(upd.old_chat_member, upd.new_chat_member)) {
      if (upd.from.id === ctx.me.id) return;
      try {
        await followUpAfterBan(ctx.api, user.id, { by: upd.from, user });
      } catch (err) {
        console.error("[join-log] follow-up failed", { userId: user.id, err });
      }
      return;
    }

    if (!isJoin(upd.old_chat_member, upd.new_chat_member)) return;

    try {
      const otherId = place === "chat" ? config.channelId : config.chatId;
      const [profile, alsoInOther] = await Promise.all([
        readProfile(ctx.api, user),
        isInside(ctx.api, otherId, user.id),
      ]);

      const html = buildJoinLogHtml({
        user,
        place,
        placeTitle: "title" in upd.chat && upd.chat.title ? upd.chat.title : String(chatId),
        alsoInOther,
        viaInviteLinkName: upd.invite_link?.name ?? (upd.invite_link ? "без названия" : undefined),
        viaJoinRequest: upd.via_join_request,
        viaFolder: upd.via_chat_folder_invite_link,
        ...profile,
      });

      const sent = await ctx.api.sendMessage(config.moderationChatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        disable_notification: true,
        reply_markup: user.is_bot ? undefined : joinLogKeyboard(user.id),
      });
      await rememberJoinLog(user.id, sent.message_id, html).catch((err) =>
        console.error("[join-log] remember log entry failed", err),
      );
    } catch (err) {
      console.error("[join-log] failed", { chatId, userId: user.id, err });
    }
  });

  // "🔨 Забанить" under a join-log entry (moderation chat only — enforced by scope middleware).
  bot.callbackQuery(/^j:b:\d+$/, async (ctx) => {
    const userId = parseJoinBanCallback(ctx.callbackQuery.data);
    if (userId === null) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Баню…" }).catch(() => {});
    try {
      await followUpAfterBan(ctx.api, userId, { by: ctx.from });
    } catch (err) {
      await logError(ctx.api, `кнопка бана из журнала входов (${userId})`, err);
    }
  });

  // "🧹 Удалить сообщения и реакции": the only place where a user's content is wiped.
  bot.callbackQuery(/^j:w:\d+$/, async (ctx) => {
    const userId = parseWipeCallback(ctx.callbackQuery.data);
    if (userId === null) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Удаляю сообщения и реакции…" }).catch(() => {});
    try {
      const result = await runWipe(cleanupDeps(ctx.api), userId, ctx.from);
      if (result.errors.length > 0) {
        await logError(ctx.api, `удаление сообщений/реакций ${userId}`, result.errors.join("; "));
      }
    } catch (err) {
      await logError(ctx.api, `кнопка удаления (${userId})`, err);
    }
  });
}
