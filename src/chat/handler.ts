import type { Bot } from "grammy";
import type { Message, User } from "grammy/types";
import { config, isLlmEnabled } from "../config.js";
import { ADDRESSED_MODE_HINT, AVENTURINE_SYSTEM_PROMPT } from "./persona.js";
import { getLlmClient, type LlmMessage } from "./llm.js";
import { tryConsumeUserQuota } from "./limits.js";
import { sendLimitNoticeOncePerDay } from "./limit-notice.js";
import { appendRecentMessage, getRecentMessages } from "./context.js";

/** Регистрирует LLM-режим «Авантюрин общается в чате». */
export function registerChatHandler(bot: Bot): void {
  if (!isLlmEnabled()) {
    console.info("[chat] LLM-режим выключен (LLM_API_KEY пуст) — хендлер не регистрируется");
    return;
  }

  bot.on("message:text", async (ctx) => {
    const msg = ctx.message;
    const from = ctx.from;
    const chat = ctx.chat;
    if (!msg || !from || !chat) return;

    // Команды пропускаем вверх по цепочке (на них отработали regisCommands).
    if (isCommandText(msg.text)) return;
    // Сам бот — игнор.
    if (from.is_bot) return;

    // LLM-режим пока включаем только в личке владельца (ADMIN_LOG_CHAT_ID).
    // В основном чате (CHAT_ID) бот остаётся только модератором.
    const inOwnerDm = chat.type === "private" && from.id === config.adminLogChatId;
    if (!inOwnerDm) return;

    const client = getLlmClient();
    if (!client) return;

    try {
      const botId = await getBotId(ctx.api);
      const botUsername = await getBotUsername(ctx.api);

      // Сохраняем сообщение в буфер (для ambient-контекста).
      await appendRecentMessage({
        author: displayName(from),
        text: msg.text,
        fromBot: false,
      }).catch((err) => console.error("[chat] appendRecentMessage", err));

      const addressed = isAddressed({
        text: msg.text,
        entities: msg.entities ?? [],
        replyTo: msg.reply_to_message,
        botId,
        botUsername,
      });

      if (addressed) {
        await handleAddressed(ctx.api, {
          chatId: chat.id,
          messageId: msg.message_id,
          user: from,
          userText: msg.text,
          repliedToBotText: getRepliedBotText(msg, botId),
        });
        return;
      }

      // Рандом-вставки отключены: LLM работает только в личке владельца.
    } catch (err) {
      console.error("[chat] handler failed", err);
    }
  });
}

function isCommandText(text: string): boolean {
  return /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?\b/.test(text);
}

// ---------- Триггеры ----------

interface AddressedArgs {
  text: string;
  entities: NonNullable<Message["entities"]>;
  replyTo: Message | undefined;
  botId: number;
  botUsername: string | undefined;
}

/** Триггер: упоминание бота / слово «Авантюрин» / реплай на сообщение бота. */
function isAddressed(a: AddressedArgs): boolean {
  if (a.replyTo && a.replyTo.from?.id === a.botId) return true;

  if (a.botUsername) {
    const needle = "@" + a.botUsername.toLowerCase();
    if (a.text.toLowerCase().includes(needle)) return true;
  }

  for (const ent of a.entities) {
    if (ent.type === "mention" || ent.type === "text_mention") {
      if (ent.type === "text_mention" && ent.user?.id === a.botId) return true;
      if (ent.type === "mention" && a.botUsername) {
        const at = a.text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
        if (at === "@" + a.botUsername.toLowerCase()) return true;
      }
    }
  }

  if (NAME_REGEX.test(a.text)) return true;

  return false;
}

// Регистронезависимо, Unicode-aware, с границами «не буква/цифра» с обеих сторон.
// Покрываем основные словоформы: Авантюрин/Авантюрина/Авантюрину/Авантюрином/Авантюрине.
const NAME_REGEX = /(?:^|[^\p{L}\p{N}])авантюрин(?:а|у|ом|е)?(?=$|[^\p{L}\p{N}])/iu;

function getRepliedBotText(msg: Message, botId: number): string | undefined {
  const r = msg.reply_to_message;
  if (!r || r.from?.id !== botId) return undefined;
  return typeof r.text === "string" ? r.text : undefined;
}

// ---------- Адресная ветка ----------

async function handleAddressed(
  api: Parameters<typeof sendLimitNoticeOncePerDay>[0]["api"],
  params: {
    chatId: number;
    messageId: number;
    user: User;
    userText: string;
    repliedToBotText?: string;
  },
): Promise<void> {
  // В личке владельца отвечаем без лимитов (для отладки и настройки персонажа).
  // Для остальных чатов/пользователей лимит остаётся, но сейчас хендлер
  // зарегистрирован только для owner-DM.
  const isOwner = params.chatId === params.user.id && params.user.id === config.adminLogChatId;
  if (!isOwner) {
    const quota = await tryConsumeUserQuota(params.user.id);
    if (!quota.allowed) {
      await sendLimitNoticeOncePerDay({
        api,
        chatId: params.chatId,
        userId: params.user.id,
        replyToMessageId: params.messageId,
      });
      return;
    }
  }

  const recent = await getRecentMessages(config.llmContextMessages).catch(() => []);
  const messages = buildAddressedMessages({
    recent,
    user: params.user,
    userText: params.userText,
    repliedToBotText: params.repliedToBotText,
  });

  await callLlmAndReply(api, {
    chatId: params.chatId,
    replyToMessageId: params.messageId,
    system: `${AVENTURINE_SYSTEM_PROMPT}\n\n${ADDRESSED_MODE_HINT}`,
    messages,
  });
}

function buildAddressedMessages(params: {
  recent: Array<{ author: string; text: string; fromBot: boolean }>;
  user: User;
  userText: string;
  repliedToBotText?: string;
}): LlmMessage[] {
  const out: LlmMessage[] = [];

  // Если это реплай на предыдущее сообщение бота — кладём его как assistant,
  // чтобы LLM понимал склейку.
  if (params.repliedToBotText) {
    out.push({ role: "assistant", content: params.repliedToBotText });
  } else {
    // Несколько последних реплик чата как контекст (если нет явной склейки).
    const transcript = params.recent
      .slice(-Math.max(0, config.llmContextMessages))
      .map((m) => `${m.fromBot ? "Авантюрин" : m.author}: ${m.text}`)
      .join("\n");
    if (transcript.length > 0) {
      out.push({
        role: "user",
        content:
          "Контекст недавних сообщений в чате (для справки, НЕ отвечай на них напрямую):\n" +
          transcript,
      });
    }
  }

  out.push({
    role: "user",
    content: `${displayName(params.user)}: ${params.userText}`,
  });

  return out;
}

// ---------- Рандом-ветка ----------

// ---------- Общий вызов LLM и отправка ----------

async function callLlmAndReply(
  api: Parameters<typeof sendLimitNoticeOncePerDay>[0]["api"],
  params: {
    chatId: number;
    replyToMessageId?: number;
    system: string;
    messages: LlmMessage[];
  },
): Promise<void> {
  const client = getLlmClient();
  if (!client) return;

  let text: string;
  try {
    const out = await client.chat({
      system: params.system,
      messages: params.messages,
    });
    text = postProcessReply(out.text);
  } catch (err) {
    console.error("[chat] LLM error", err);
    return;
  }

  if (!text) return;

  try {
    await api.sendMessage(params.chatId, text, {
      reply_parameters:
        params.replyToMessageId !== undefined
          ? { message_id: params.replyToMessageId }
          : undefined,
    });

    // В личке владельца можно иногда добивать фирменным стикером.
    if (params.chatId === config.adminLogChatId && Math.random() < 0.35) {
      const sticker = await pickBrandStickerId(api);
      if (sticker) {
        await api.sendSticker(params.chatId, sticker).catch((err) => {
          console.error("[chat] sendSticker failed", err);
        });
      }
    }
    // Сохраняем свою реплику в буфер контекста.
    await appendRecentMessage({ author: "Авантюрин", text, fromBot: true }).catch(
      (err) => console.error("[chat] save bot reply", err),
    );
  } catch (err) {
    console.error("[chat] sendMessage failed", err);
  }
}

function postProcessReply(raw: string): string {
  let s = raw.trim();
  // Иногда модель повторяет префикс «Авантюрин:» — убираем.
  s = s.replace(/^\s*(?:авантюрин|aventurine)\s*[:\-—]\s*/i, "");
  // Убираем длинные тире.
  s = s.replace(/[—–]/g, "-");
  // Чуть менее «идеальная» пунктуация: убираем часть запятых.
  s = s.replace(/,\s+/g, " ");
  // Понижаем регистр первой буквы.
  if (s.length > 0) s = s[0]!.toLowerCase() + s.slice(1);
  // Не заканчиваем «канцелярской» точкой.
  s = s.replace(/\.\s*$/g, "");
  // Жёстко режем многословие: максимум 2 предложения.
  s = s
    .split(/(?<=[.!?])\s+/)
    .filter((p) => p.trim().length > 0)
    .slice(0, 2)
    .join(" ")
    .trim();
  // Жёсткий потолок длины — Telegram и так ограничивает ~4096, но лучше короче.
  if (s.length > 240) s = s.slice(0, 240).trimEnd() + "…";
  return s;
}

let cachedBrandStickerIds: string[] | undefined;
async function pickBrandStickerId(
  api: Parameters<typeof sendLimitNoticeOncePerDay>[0]["api"],
): Promise<string | null> {
  if (!cachedBrandStickerIds) {
    try {
      // По ссылке: https://t.me/addstickers/Avantyurak
      const set = await api.getStickerSet("Avantyurak");
      cachedBrandStickerIds = (set.stickers ?? [])
        .map((s) => s.file_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch (err) {
      console.error("[chat] getStickerSet failed", err);
      cachedBrandStickerIds = [];
    }
  }
  if (cachedBrandStickerIds.length === 0) return null;
  const idx = Math.floor(Math.random() * cachedBrandStickerIds.length);
  return cachedBrandStickerIds[idx] ?? null;
}

// ---------- Вспомогательные ----------

function displayName(user: User): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (user.username) return "@" + user.username;
  return "участник";
}

let cachedBotId: number | undefined;
let cachedBotUsername: string | undefined;

async function getBotId(api: { getMe: () => Promise<User> }): Promise<number> {
  if (cachedBotId !== undefined) return cachedBotId;
  const me = await api.getMe();
  cachedBotId = me.id;
  if (me.username) cachedBotUsername = me.username;
  return cachedBotId;
}

async function getBotUsername(
  api: { getMe: () => Promise<User> },
): Promise<string | undefined> {
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  const me = await api.getMe();
  cachedBotId = me.id;
  cachedBotUsername = me.username;
  return cachedBotUsername;
}
