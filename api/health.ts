const KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "CHANNEL_ID",
  "CHAT_ID",
  "ADMIN_LOG_CHAT_ID",
  "MODERATION_CHAT_ID",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

const OPTIONAL_KEYS = [
  "BOT_ENV",
  "SECONDARY_CHANNEL_ID",
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_MAX_OUTPUT_TOKENS",
  "LLM_TIMEOUT_MS",
  "LLM_CONTEXT_MESSAGES",
  "CHAT_TZ",
  "CHAT_RANDOM_EVERY_N",
  "CHAT_DAILY_RANDOM_CAP",
  "CHAT_USER_DAILY_CAP",
] as const;

/** Именованный GET — иначе Vercel трактует default как legacy (req, res) и падает. */
export function GET(): Response {
  const present: Record<string, boolean> = {};
  for (const k of KEYS) {
    const v = process.env[k];
    present[k] = Boolean(v && String(v).trim() !== "");
  }
  const allPresent = KEYS.every((k) => present[k]);

  const optional: Record<string, boolean> = {};
  for (const k of OPTIONAL_KEYS) {
    const v = process.env[k];
    optional[k] = Boolean(v && String(v).trim() !== "");
  }

  const botEnv = (process.env["BOT_ENV"] ?? "prod").trim() || "prod";
  const llmEnabled = optional["LLM_API_KEY"] === true;

  return new Response(
    JSON.stringify(
      {
        ok: allPresent,
        bot_env: botEnv,
        llm_enabled: llmEnabled,
        env: present,
        optional,
        hint: allPresent
          ? "Все ключи заданы. Если /api/setup всё ещё падает — проверьте значения (ID целые, токен верный) и сделайте Redeploy после изменения env."
          : "Добавьте недостающие переменные в Vercel для среды Production и нажмите Redeploy.",
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
