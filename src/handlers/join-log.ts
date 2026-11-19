import type { Api, Bot, CallbackQueryContext, Context } from "grammy";
import { withCardLock } from "../card-lock.js";
import type { User } from "grammy/types";
import { config } from "../config.js";
import { parseWipeCallback, runBanFollowUp, runWipe } from "../ban-cleanup.js";
import { cleanupDeps, rememberJoinLog, rememberJoinMessage } from "../ban-cleanup-store.js";
import {
  applyJoinCardAction,
  buildJoinLogHtml,
  isBan,
  isJoin,
  joinLogKeyboard,
  parseJoinBanCallback,
  parseJoinCardCallback,
  sendProfileRefresh,
  type JoinCardDeps,
  type JoinCardPrefix,
  type JoinLogInfo,
  type PersonalChannelInfo,
} from "../join-log.js";
import { escapeHtml, logError } from "../logger.js";

const INSIDE = new Set(["creator", "administrator", "member"]);

export async function isInside(api: Api, chatId: number, userId: number): Promise<boolean | undefined> {
  try {
    const m = await api.getChatMember(chatId, userId);
    return INSIDE.has(m.status) || (m.status === "restricted" && m.is_member);
  } catch {
    return undefined;
  }
}

/** Reads bio + linked personal channel of a user. Never throws. */
export async function readProfile(
  api: Api,
  user: User,
): Promise<Pick<JoinLogInfo, "bio" | "profileReadable" | "personalChannel">> {
  const { current: _current, ...profile } = await readCurrentProfile(api, user.id);
  return profile;
}

/** Same, plus the name/username as they are now (for the 🔄 refresh). Never throws. */
export async function readCurrentProfile(
  api: Api,
  userId: number,
): Promise<Pick<JoinLogInfo, "bio" | "profileReadable" | "personalChannel"> & { current: User }> {
  const current: User = { id: userId, is_bot: false, first_name: "" };
  try {
    const full = await api.getChat(userId);
    if ("first_name" in full && full.first_name) current.first_name = full.first_name;
    if ("last_name" in full && full.last_name) current.last_name = full.last_name;
    if ("username" in full && full.username) current.username = full.username;
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
    return { bio, profileReadable: true, personalChannel, current };
  } catch (err) {
    console.error("[join-log] getChat(user) failed", { userId, err });
    return { profileReadable: false, current };
  }
}

/**
 * Shared handler of ✅ Свой / ↩️ Отменить / 🔄 Профиль for the discussion log (`j:`) and
 * the tournament chat (`t:`). ✅/↩️ run under the per-user card lock; `onDone` runs inside
 * it too (tournament: persist the confirmation). 🔄 only posts a reply.
 */
export async function handleJoinCardButton(
  ctx: CallbackQueryContext<Context>,
  opts: {
    prefix: JoinCardPrefix;
    getCard: JoinCardDeps["getCard"];
    setCard: JoinCardDeps["setCard"];
    onDone?: (action: "confirm" | "unconfirm", userId: number) => Promise<void>;
  },
): Promise<void> {
  const parsed = parseJoinCardCallback(ctx.callbackQuery.data ?? "");
  const msg = ctx.callbackQuery.message;
  if (!parsed || parsed.prefix !== opts.prefix || !msg) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const { action, userId } = parsed;
  try {
    if (action === "refresh") {
      await ctx.answerCallbackQuery({ text: "Читаю профиль…" }).catch(() => {});
      const { current, ...profile } = await readCurrentProfile(ctx.api, userId);
      await sendProfileRefresh(ctx.api as unknown as Parameters<typeof sendProfileRefresh>[0], {
        moderationChatId: config.moderationChatId,
        cardMessageId: msg.message_id,
        profile: { user: current, ...profile },
      });
      return;
    }
    const result = await withCardLock(opts.prefix, userId, async () => {
      const r = await applyJoinCardAction(
        {
          api: ctx.api as unknown as JoinCardDeps["api"],
          getCard: opts.getCard,
          setCard: opts.setCard,
          moderationChatId: config.moderationChatId,
        },
        {
          prefix: opts.prefix,
          action,
          userId,
          messageId: msg.message_id,
          fallbackHtml: escapeHtml("text" in msg && msg.text ? msg.text : `ID ${userId}`),
          by: ctx.from,
        },
      );
      if (r === "done") await opts.onDone?.(action, userId);
      return r;
    });
    const text =
      result === "state-changed"
        ? "Карточка уже изменилась (бан или ссылка) — ничего не трогаю"
        : action === "confirm"
          ? "Отмечено: свой"
          : "Кнопки возвращены";
    await ctx.answerCallbackQuery({ text }).catch(() => {});
  } catch (err) {
    await ctx.answerCallbackQuery().catch(() => {});
    await logError(ctx.api, `кнопка карточки ${opts.prefix}:${action} (${userId})`, err);
  }
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

  bot.on("chat_member", async (ctx, next) => {
    const upd = ctx.chatMember;
    const chatId = upd.chat.id;
    const place = chatId === config.chatId ? "chat" : chatId === config.channelId ? "channel" : null;
    if (!place) return next();
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
      await withCardLock("j", user.id, () => rememberJoinLog(user.id, sent.message_id, html)).catch((err) =>
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

  // "✅ Свой" / "↩️ Отменить" / "🔄 Профиль" under a join-log entry.
  bot.callbackQuery(/^j:[orp]:\d+$/, async (ctx) => {
    const store = cleanupDeps(ctx.api).store;
    await handleJoinCardButton(ctx, {
      prefix: "j",
      getCard: (id) => store.getJoinLog(id),
      setCard: (id, e) => store.setJoinLog(id, e),
    });
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
