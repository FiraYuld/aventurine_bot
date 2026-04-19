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

/** Именованный GET — иначе Vercel трактует default как legacy (req, res) и падает. */
export function GET(): Response {
  const present: Record<string, boolean> = {};
  for (const k of KEYS) {
    const v = process.env[k];
    present[k] = Boolean(v && String(v).trim() !== "");
  }
  const allPresent = KEYS.every((k) => present[k]);

  return new Response(
    JSON.stringify(
      {
        ok: allPresent,
        env: present,
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
