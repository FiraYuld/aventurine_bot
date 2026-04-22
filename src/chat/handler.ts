import type { Bot } from "grammy";
import type { Message, User } from "grammy/types";
import { config, isLlmEnabled } from "../config.js";
import {
  ADDRESSED_MODE_HINT,
  AVENTURINE_SYSTEM_PROMPT,
  RANDOM_MODE_HINT,
} from "./persona.js";
import { getLlmClient, type LlmMessage } from "./llm.js";
import {
  incGlobalMessageCounter,
  tryConsumeRandomQuota,
  tryConsumeUserQuota,
} from "./limits.js";
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

    // LLM-режим: личка владельца (без лимитов) и основной чат обсуждения (с лимитами).
    const inOwnerDm = chat.type === "private" && from.id === config.adminLogChatId;
    const inMainChat = chat.id === config.chatId;
    if (!inOwnerDm && !inMainChat) return;

    const client = getLlmClient();
    if (!client) return;

    try {
      const botId = await getBotId(ctx.api);
      const botUsername = await getBotUsername(ctx.api);

      // Сохраняем сообщение в буфер (контекст обязателен и для чата, и для owner-DM).
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

      // Рандом-ветка: только в основном чате, раз в N сообщений, в пределах
      // суточной квоты. Личку владельца здесь не трогаем — там всё только
      // адресно, для отладки персонажа.
      if (inMainChat) {
        await maybeHandleRandom(ctx.api, { chatId: chat.id }).catch((err) =>
          console.error("[chat] maybeHandleRandom failed", err),
        );
      }
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
  }

  // Контекст обязателен: всегда даём последние реплики (даже если это owner-DM),
  // и требуем подхватить 1–2 слова/фразы из него в ответ.
  const transcript = params.recent
    .slice(-Math.max(0, config.llmContextMessages))
    .map((m) => `${m.fromBot ? "Авантюрин" : m.author}: ${m.text}`)
    .join("\n");
  if (transcript.length > 0) {
    out.push({
      role: "user",
      content:
        "Контекст последних сообщений чата (для понимания ситуации):\n" +
        transcript +
        "\n\nИспользуй этот контекст, чтобы понять, о чём вообще разговор, какая тема и тон. Не отвечай на эти сообщения напрямую - отвечай собеседнику ниже. Ключевое слово из контекста подхватывай только если это уместно по смыслу; механически вставлять слова не надо.",
    });
  }

  out.push({
    role: "user",
    content: `${displayName(params.user)}: ${params.userText}`,
  });

  return out;
}

// ---------- Рандом-ветка ----------

async function maybeHandleRandom(
  api: Parameters<typeof sendLimitNoticeOncePerDay>[0]["api"],
  params: { chatId: number },
): Promise<void> {
  const everyN = Math.max(1, config.chatRandomEveryN);
  const counter = await incGlobalMessageCounter().catch(() => 0);
  if (counter <= 0) return;
  if (counter % everyN !== 0) return;

  const quota = await tryConsumeRandomQuota();
  if (!quota.allowed) return;

  const recent = await getRecentMessages(config.llmContextMessages).catch(() => []);
  if (recent.length === 0) return;

  const transcript = recent
    .map((m) => `${m.fromBot ? "Авантюрин" : m.author}: ${m.text}`)
    .join("\n");

  const messages: LlmMessage[] = [
    {
      role: "user",
      content:
        "Контекст последних сообщений чата:\n" +
        transcript +
        "\n\nВникни в тему разговора и кинь короткую реплику «от себя» в стиле персонажа - как будто проходил мимо и бросил комментарий по теме. Не обращайся ни к кому лично. Реагируй по смыслу происходящего, а не просто повторяй слова из чата.",
    },
  ];

  await callLlmAndReply(api, {
    chatId: params.chatId,
    system: `${AVENTURINE_SYSTEM_PROMPT}\n\n${RANDOM_MODE_HINT}`,
    messages,
    stickerChance: config.chatRandomStickerChance,
  });
}

// ---------- Общий вызов LLM и отправка ----------

async function callLlmAndReply(
  api: Parameters<typeof sendLimitNoticeOncePerDay>[0]["api"],
  params: {
    chatId: number;
    replyToMessageId?: number;
    system: string;
    messages: LlmMessage[];
    /** Переопределение шанса добить стикером. По умолчанию — config.chatStickerChance. */
    stickerChance?: number;
  },
): Promise<void> {
  const client = getLlmClient();
  if (!client) return;

  let parts: string[];
  try {
    const out = await client.chat({
      system: params.system,
      messages: params.messages,
    });
    parts = postProcessReply(out.text);
  } catch (err) {
    console.error("[chat] LLM error", err);
    return;
  }

  if (parts.length === 0) return;

  try {
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i]!;
      // reply_parameters используем только на первом сообщении — чтобы визуально
      // был якорь к исходной реплике; второе идёт обычным сообщением.
      await api.sendMessage(params.chatId, text, {
        reply_parameters:
          i === 0 && params.replyToMessageId !== undefined
            ? { message_id: params.replyToMessageId }
            : undefined,
      });
      await appendRecentMessage({ author: "Авантюрин", text, fromBot: true }).catch(
        (err) => console.error("[chat] save bot reply", err),
      );
    }

    // Иногда добиваем фирменным стикером — работает и в основном чате, и в личке.
    const chance = params.stickerChance ?? config.chatStickerChance;
    if (chance > 0 && Math.random() < chance) {
      const sticker = await pickBrandStickerId(api);
      if (sticker) {
        await api.sendSticker(params.chatId, sticker).catch((err) => {
          console.error("[chat] sendSticker failed", err);
        });
      }
    }
  } catch (err) {
    console.error("[chat] sendMessage failed", err);
  }
}

/**
 * Обрабатывает сырой ответ LLM и возвращает 1–2 отдельных сообщения.
 * Маркер `|||` — способ для модели разбить ответ на два коротких сообщения.
 */
function postProcessReply(raw: string): string[] {
  const initial = raw.trim();
  if (!initial) return [];

  // Разбиваем на максимум 2 части по маркеру |||.
  const rawParts = initial
    .split("|||")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const limited = rawParts.slice(0, 2);

  const cleaned: string[] = [];
  for (const part of limited) {
    const s = cleanOnePart(part);
    if (s.length > 0) cleaned.push(s);
  }
  return cleaned;
}

function cleanOnePart(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  // Иногда модель повторяет префикс «Авантюрин:» — убираем.
  s = s.replace(/^\s*(?:авантюрин|aventurine)\s*[:\-—]\s*/i, "");
  // Убираем длинные тире.
  s = s.replace(/[—–]/g, "-");
  // Чуть менее «идеальная» пунктуация: убираем часть запятых.
  s = s.replace(/,\s+/g, " ");
  // Жёстко режем многословие: максимум 3 предложения.
  s = s
    .split(/(?<=[.!?])\s+/)
    .filter((p) => p.trim().length > 0)
    .slice(0, 3)
    .join(" ")
    .trim();
  // Понижаем регистр первой буквы.
  if (s.length > 0) s = s[0]!.toLowerCase() + s.slice(1);
  // Почти полностью режем пунктуацию.
  const isQuestion =
    /\?\s*$/.test(s) ||
    /^\s*(почему|зачем|как|что|кто|где|когда|сколько|какой|какая|какие|чё|че)\b/i.test(s);
  s = s.replace(/[!.,;:()"«»'”“]/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  // Вопросительный знак ставим только если это похоже на вопрос.
  s = s.replace(/\?+$/g, "");
  if (isQuestion) s = s + "?";
  // Жёсткий потолок длины — Telegram и так ограничивает ~4096, но лучше короче.
  if (s.length > 360) s = s.slice(0, 360).trimEnd() + "…";
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
