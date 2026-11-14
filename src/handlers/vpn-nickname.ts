import type { Bot } from "grammy";
import { runBanFollowUp } from "../ban-cleanup.js";
import { cleanupDeps, rememberJoinLog } from "../ban-cleanup-store.js";
import { config } from "../config.js";
import { escapeHtml, logError } from "../logger.js";
import { isAdminAnywhere } from "../moderation.js";
import { getRedis } from "../redis.js";
import {
  buildVpnCardHtml,
  hasVpnNickname,
  parseVpnCallback,
  VPN_BAN_CATCHPHRASE,
  VPN_CARD_TTL_SEC,
  VPN_LEAVE_ALONE_TTL_SEC,
  vpnCardKeyboard,
  vpnKeptFooterHtml,
} from "../vpn-nickname.js";

const cardKey = (userId: number) => `vpncard:${userId}`;
const leaveAloneKey = (userId: number) => `vpnleave:${userId}`;

/**
 * Must be registered BEFORE registerModerationCallbacks (catch-all callback handler).
 */
export function registerVpnNickname(bot: Bot): void {
  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    const user = msg.from;
    if (msg.chat.id !== config.chatId || !user || user.is_bot || !hasVpnNickname(user)) {
      await next();
      return;
    }

    try {
      const r = getRedis();
      if (await r.get(leaveAloneKey(user.id))) return void (await next());
      // One open card per user; the slot is taken atomically.
      const fresh = await r.set(cardKey(user.id), "1", { nx: true, ex: VPN_CARD_TTL_SEC });
      if (fresh !== "OK") return void (await next());
      if (await isAdminAnywhere(ctx.api, user.id)) {
        await r.del(cardKey(user.id));
        return void (await next());
      }

      const html = buildVpnCardHtml(user, config.chatId, msg.message_id);
      const sent = await ctx.api.sendMessage(config.moderationChatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: vpnCardKeyboard(user.id, msg.message_id),
      });
      await r.set(cardKey(user.id), JSON.stringify({ messageId: sent.message_id, html }), {
        ex: VPN_CARD_TTL_SEC,
      });
    } catch (err) {
      await logError(ctx.api, `VPN-ник: карточка для ${user.id}`, err);
    }
    await next();
  });

  bot.callbackQuery(/^v[bk]:\d+:\d+$/, async (ctx) => {
    const parsed = parseVpnCallback(ctx.callbackQuery.data);
    const msg = ctx.callbackQuery.message;
    if (!parsed || !msg) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const { action, userId, messageId } = parsed;
    await ctx.answerCallbackQuery({ text: action === "ban" ? "Баню…" : "Оставляю" }).catch(() => {});

    const r = getRedis();
    const stored: unknown = await r.get(cardKey(userId)).catch(() => null);
    const card =
      stored && typeof stored === "object"
        ? (stored as { html?: string })
        : typeof stored === "string" && stored.startsWith("{")
          ? (JSON.parse(stored) as { html?: string })
          : {};
    const html = card.html ?? ("text" in msg && msg.text ? escapeHtml(msg.text) : "⚠️ VPN / ВПН в нике");
    await r.del(cardKey(userId)).catch(() => {});

    try {
      if (action === "keep") {
        await r.set(leaveAloneKey(userId), "1", { ex: VPN_LEAVE_ALONE_TTL_SEC });
        await ctx.api.editMessageText(msg.chat.id, msg.message_id, `${html}\n\n${vpnKeptFooterHtml(ctx.from)}`, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        });
        return;
      }

      // Ban: same reversible follow-up as everywhere else; the card gets the 🧹 button.
      await rememberJoinLog(userId, msg.message_id, html);
      const result = await runBanFollowUp(cleanupDeps(ctx.api), userId, { by: ctx.from });
      if (result.errors.length > 0) {
        await logError(ctx.api, `VPN-ник: бан ${userId}`, result.errors.join("; "));
      }
      await ctx.api
        .sendMessage(config.chatId, VPN_BAN_CATCHPHRASE, {
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        })
        .catch((err) => console.error("[vpn] catchphrase failed", err));
    } catch (err) {
      await logError(ctx.api, `VPN-ник: кнопка ${action} для ${userId}`, err);
    }
  });
}
