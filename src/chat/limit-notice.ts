import type { Api } from "grammy";
import { pickLimitLine } from "./persona.js";
import { tryMarkLimitNoticeSent } from "./limits.js";

/**
 * Отправить пользователю ровно одно сообщение о лимите за сутки (в стиле
 * персонажа) и далее молчать до следующих суток. Реплай на исходное сообщение
 * пользователя, чтобы в групповом чате было понятно, к кому относится.
 *
 * Если уже отправляли сегодня — ничего не делаем.
 */
export async function sendLimitNoticeOncePerDay(params: {
  api: Api;
  chatId: number;
  userId: number;
  replyToMessageId: number;
}): Promise<void> {
  const fresh = await tryMarkLimitNoticeSent(params.userId);
  if (!fresh) return;

  const text = pickLimitLine(params.userId);

  try {
    await params.api.sendMessage(params.chatId, text, {
      reply_parameters: { message_id: params.replyToMessageId },
    });
  } catch (err) {
    console.error("[limit-notice] send failed", err);
  }
}
