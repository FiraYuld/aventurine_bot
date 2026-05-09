import type { Api } from "grammy";
import type { User } from "grammy/types";
import { config } from "./config.js";
import { buildBanLogHtml, logBan, logError, type ReactionEventLog } from "./logger.js";
import { banEverywhere, deleteAllReactionsOf } from "./moderation.js";

export const BAN_CATCHPHRASE = "Схватил бота за жёпу!";

export type BanLogTitle =
  | "Бан по реакции"
  | "Бан по кнопке"
  | "Автобан"
  | "Автобан (спам-ник)"
  | "Бан бот-аккаунт";

export async function sendBanCatchphraseReply(
  api: Api,
  discussionMessageId: number,
): Promise<void> {
  await api.sendMessage(config.chatId, BAN_CATCHPHRASE, {
    reply_parameters: { message_id: discussionMessageId },
  });
}

async function sendOrEditBanLog(
  api: Api,
  user: User,
  reasons: string[],
  extra: {
    messageId?: number;
    reactionEmojis?: string[];
    reactionEvents?: ReactionEventLog[];
    title?: string;
  },
  replaceInModeration?: { messageId: number },
): Promise<void> {
  const text = buildBanLogHtml(user, reasons, extra);
  if (replaceInModeration) {
    await api.editMessageText(
      config.moderationChatId,
      replaceInModeration.messageId,
      text,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      },
    );
  } else {
    await logBan(api, user, reasons, extra);
  }
}

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
  await sendOrEditBanLog(
    params.api,
    params.user,
    params.reasons,
    {
      messageId: params.discussionMessageId,
      reactionEmojis: params.reactionEmojis,
      reactionEvents: params.reactionEvents,
      title: params.logTitle,
    },
    params.replaceModerationMessageId !== undefined
      ? { messageId: params.replaceModerationMessageId }
      : undefined,
  );
  // Bot API 10.0: чистим оставленные забаненным пользователем реакции.
  // Если бан в чате не прошёл — звать метод бессмысленно (всё равно прав не
  // хватит / реакции не наши). Ошибки самой чистки не аффектят бан-флоу.
  if (outcome.bannedInChat) {
    const wipe = await deleteAllReactionsOf(params.api, params.userId);
    if (!wipe.ok) {
      await logError(
        params.api,
        `снятие реакций после бана у ${params.userId}`,
        wipe.error ?? "unknown error",
      );
    }
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
