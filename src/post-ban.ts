import type { Api } from "grammy";
import type { User } from "grammy/types";
import { NOT_WIPED_LINE, wipeKeyboard } from "./ban-cleanup.js";
import { rememberJoinLog } from "./ban-cleanup-store.js";
import { config } from "./config.js";
import { buildBanLogHtml, logError, type ReactionEventLog } from "./logger.js";
import { banEverywhere } from "./moderation.js";

export const BAN_CATCHPHRASE = "Схватил бота за жёпу!";

export type BanLogTitle =
  | "Бан по реакции"
  | "Бан по кнопке"
  | "Автобан"
  | "Автобан (спам-ник)";

export async function sendBanCatchphraseReply(
  api: Api,
  discussionMessageId: number,
): Promise<void> {
  await api.sendMessage(config.chatId, BAN_CATCHPHRASE, {
    reply_parameters: { message_id: discussionMessageId },
  });
}

/**
 * Ban log in the moderation chat, with the "🧹 Удалить сообщения и реакции" button.
 * Returns the id of the message carrying the button (new or edited card).
 */
async function sendOrEditBanLog(
  api: Api,
  userId: number,
  html: string,
  replaceModerationMessageId?: number,
): Promise<number> {
  const other = {
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
    reply_markup: wipeKeyboard(userId),
  };
  if (replaceModerationMessageId !== undefined) {
    await api.editMessageText(config.moderationChatId, replaceModerationMessageId, html, other);
    return replaceModerationMessageId;
  }
  const sent = await api.sendMessage(config.moderationChatId, html, other);
  return sent.message_id;
}

/**
 * Ban after reactions (autoban, spam nickname, or the Ban button on a reaction card).
 * Bans in the chat and the channel but does NOT delete the user's messages or
 * reactions: real people were banned by mistake and lost everything. Deleting is the
 * separate "🧹" step under the ban log.
 */
export async function executeReactionBan(params: {
  api: Api;
  user: User;
  userId: number;
  reasons: string[];
  discussionMessageId: number;
  logTitle: BanLogTitle;
  reactionEmojis?: string[];
  reactionEvents?: ReactionEventLog[];
  /** Если задано — правим карточку очереди вместо нового сообщения */
  replaceModerationMessageId?: number;
}): Promise<{ errors: string[] }> {
  const outcome = await banEverywhere(params.api, params.userId);

  const html =
    buildBanLogHtml(params.user, params.reasons, {
      messageId: params.discussionMessageId,
      reactionEmojis: params.reactionEmojis,
      reactionEvents: params.reactionEvents,
      title: params.logTitle,
    }) + `\n\n${NOT_WIPED_LINE}`;

  try {
    const logMessageId = await sendOrEditBanLog(
      params.api,
      params.userId,
      html,
      params.replaceModerationMessageId,
    );
    await rememberJoinLog(params.userId, logMessageId, html);
  } catch (err) {
    console.error("Не удалось отправить лог бана в чат модерации:", err);
  }

  try {
    await sendBanCatchphraseReply(params.api, params.discussionMessageId);
  } catch (err) {
    await logError(params.api, "ответ с фразой после бана", err);
  }
  if (outcome.errors.length > 0) {
    await logError(params.api, `бан пользователя ${params.userId}`, outcome.errors.join("; "));
  }
  return outcome;
}
