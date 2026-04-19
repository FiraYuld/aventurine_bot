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

function loadConfig() {
  return {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    channelId: requiredInt("CHANNEL_ID"),
    chatId: requiredInt("CHAT_ID"),
    adminLogChatId: requiredInt("ADMIN_LOG_CHAT_ID"),
    moderationChatId: requiredInt("MODERATION_CHAT_ID"),
    upstashRedisRestUrl: required("UPSTASH_REDIS_REST_URL"),
    upstashRedisRestToken: required("UPSTASH_REDIS_REST_TOKEN"),
    /** Окно автобана: 2+ подозрительные реакции за это время (мс) */
    reactionAutoBanWindowMs: 60_000,
    /** TTL ключа сессии в Redis (сек), чуть больше окна */
    reactionModSessionTtlSec: 120,
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

/** Доступ к конфигу; при первом обращении читает env (как и раньше). */
export const config: Config = new Proxy({} as Config, {
  get(_t, prop: keyof Config) {
    return getConfig()[prop];
  },
});
