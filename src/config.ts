function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Переменная окружения ${name} не задана. Проверь .env (локально) или vercel env (на проде).`,
    );
  }
  return value.trim();
}

function requiredInt(name: string): number {
  const raw = required(name);
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Переменная ${name} должна быть целым числом, получено: ${raw}`);
  }
  return num;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalInt(name: string, defaultValue: number): number {
  const raw = optional(name);
  if (raw === undefined) return defaultValue;
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Переменная ${name} должна быть целым числом, получено: ${raw}`);
  }
  return num;
}

function optionalIntValue(name: string): number | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Переменная ${name} должна быть целым числом, получено: ${raw}`);
  }
  return num;
}

function optionalFloat(name: string, defaultValue: number): number {
  const raw = optional(name);
  if (raw === undefined) return defaultValue;
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    throw new Error(`Переменная ${name} должна быть числом, получено: ${raw}`);
  }
  return num;
}

function optionalEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const raw = optional(name);
  if (raw === undefined) return defaultValue;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `Переменная ${name} должна быть одним из: ${allowed.join(", ")}; получено: ${raw}`,
    );
  }
  return raw as T;
}

/** Список положительных user id через запятую. */
function optionalUserIdList(name: string, defaultRaw: string): readonly number[] {
  const raw = optional(name) ?? defaultRaw;
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return [...ids];
}

const LLM_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const BOT_ENVS = ["prod", "staging"] as const;
export type BotEnv = (typeof BOT_ENVS)[number];

function defaultModelFor(provider: LlmProvider): string {
  switch (provider) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-3-5-haiku-latest";
    case "openrouter":
      return "openai/gpt-4o-mini";
  }
}

function loadConfig() {
  const llmProvider = optionalEnum("LLM_PROVIDER", LLM_PROVIDERS, "openai");
  const llmApiKey = optional("LLM_API_KEY");
  const llmModel = optional("LLM_MODEL") ?? defaultModelFor(llmProvider);

  return {
    botEnv: optionalEnum("BOT_ENV", BOT_ENVS, "prod"),
    botToken: required("TELEGRAM_BOT_TOKEN"),
    webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    channelId: requiredInt("CHANNEL_ID"),
    /**
     * Второй канал для мастера `/post` (кнопка выбора рядом с CHANNEL_ID).
     * Модерация реакций по-прежнему использует только CHANNEL_ID.
     */
    secondaryChannelId: optionalIntValue("SECONDARY_CHANNEL_ID"),
    chatId: requiredInt("CHAT_ID"),
    adminLogChatId: requiredInt("ADMIN_LOG_CHAT_ID"),
    moderationChatId: requiredInt("MODERATION_CHAT_ID"),
    upstashRedisRestUrl: required("UPSTASH_REDIS_REST_URL"),
    upstashRedisRestToken: required("UPSTASH_REDIS_REST_TOKEN"),
    /** Окно автобана: N+ подозрительных реакций за это время (мс) */
    reactionAutoBanWindowMs: 60_000,
    /** Кап страйков (реакций) в окне до автобана. */
    reactionAutoBanStrikes: 3,
    /** TTL ключа сессии в Redis (сек), чуть больше окна */
    reactionModSessionTtlSec: 120,
    /**
     * После кнопки «Оставить» не считать реакции этого пользователя под автомодерацию
     * (карточки и автобан по 2+ реакциям), пока ключ живёт в Redis.
     */
    reactionLeaveAloneTtlSec: 7 * 24 * 60 * 60,

    // ---- LLM-режим (Авантюрин общается в чате) ----
    /** Пустой ключ = LLM-режим выключен, остальные переменные не читаются строго. */
    llmApiKey,
    llmProvider,
    llmModel,
    llmMaxOutputTokens: optionalInt("LLM_MAX_OUTPUT_TOKENS", 360),
    llmTimeoutMs: optionalInt("LLM_TIMEOUT_MS", 15_000),
    llmContextMessages: optionalInt("LLM_CONTEXT_MESSAGES", 4),
    /** Таймзона для «календарных суток» лимитов. Упрощённо: поддерживается Europe/Moscow (UTC+3). */
    chatTz: optional("CHAT_TZ") ?? "Europe/Moscow",
    /** Шаг счётчика сообщений, на котором пробуем вставить «рандом» в стиле персонажа. */
    chatRandomEveryN: optionalInt("CHAT_RANDOM_EVERY_N", 15),
    /** Потолок «рандомных» ответов в сутки на весь чат. */
    chatDailyRandomCap: optionalInt("CHAT_DAILY_RANDOM_CAP", 50),
    /** Потолок ответов на одного пользователя в сутки (триггер «Авантюрин» + продолжение диалога). */
    chatUserDailyCap: optionalInt("CHAT_USER_DAILY_CAP", 5),
    /**
     * User id (через запятую) с доступом к LLM в личке без суточного лимита.
     * Только из env LLM_UNLIMITED_DM_USER_IDS; в коде дефолтов нет.
     */
    llmUnlimitedDmUserIds: optionalUserIdList("LLM_UNLIMITED_DM_USER_IDS", ""),
    /** Вероятность добить ответ фирменным стикером, 0..1. */
    chatStickerChance: optionalFloat("CHAT_STICKER_CHANCE", 0.25),
    /** Вероятность добить стикером в рандом-ремарке (она короче и живее). */
    chatRandomStickerChance: optionalFloat("CHAT_RANDOM_STICKER_CHANCE", 0.35),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;

let cache: Config | undefined;

export function getConfig(): Config {
  if (!cache) {
    cache = loadConfig();
  }
  return cache;
}

/** LLM-режим включён, если задан ключ. */
export function isLlmEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.llmApiKey);
}

export function isOwnerUserId(userId: number, cfg: Config = getConfig()): boolean {
  return userId === cfg.adminLogChatId;
}

/** Личка с ботом для LLM: владелец или пользователи из LLM_UNLIMITED_DM_USER_IDS. */
export function isLlmPrivateDmUser(userId: number, cfg: Config = getConfig()): boolean {
  return isOwnerUserId(userId, cfg) || cfg.llmUnlimitedDmUserIds.includes(userId);
}

/** Без суточного лимита chatUserDailyCap (только для привилегированных, не владелец). */
export function isLlmUnlimitedDmUser(userId: number, cfg: Config = getConfig()): boolean {
  return cfg.llmUnlimitedDmUserIds.includes(userId);
}

/** Доступ к конфигу; при первом обращении читает env (как и раньше). */
export const config: Config = new Proxy({} as Config, {
  get(_t, prop: keyof Config) {
    return getConfig()[prop];
  },
});
