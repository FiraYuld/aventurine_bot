import { getBot, ALLOWED_UPDATES } from "../src/bot.js";
import { getConfig } from "../src/config.js";

interface SetupResult {
  ok: boolean;
  message: string;
  details?: unknown;
  /** Типы из ALLOWED_UPDATES, которых нет в getWebhookInfo — тогда Telegram не шлёт такие апдейты */
  missing_allowed_updates?: string[];
}

/** Именованный GET — иначе Vercel трактует default как legacy (req, res), Web Request не собирается. */
export async function GET(request: Request): Promise<Response> {
  let cfg: ReturnType<typeof getConfig>;
  try {
    cfg = getConfig();
  } catch (err) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          message:
            "Не удалось загрузить конфиг. Проверьте Vercel → Settings → Environment Variables: все переменные из /api/health для среды Production, затем Redeploy. Либо откройте /api/health для диагностики.",
          details: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (key !== cfg.webhookSecret) {
    return new Response(JSON.stringify({ ok: false, message: "Forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const action = url.searchParams.get("action") ?? "set";
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const webhookUrl = `${proto}://${host}/api/telegram`;

  let result: SetupResult;

  try {
    const bot = getBot();
    if (action === "delete") {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      result = { ok: true, message: "Webhook удалён" };
    } else if (action === "info") {
      const info = await bot.api.getWebhookInfo();
      const allowed = new Set(info.allowed_updates ?? []);
      const missing = [...ALLOWED_UPDATES].filter((t) => !allowed.has(t));
      result = {
        ok: true,
        message: "Webhook info",
        details: info,
        missing_allowed_updates: missing,
      };
    } else {
      await bot.api.setWebhook(webhookUrl, {
        secret_token: cfg.webhookSecret,
        allowed_updates: [...ALLOWED_UPDATES],
        drop_pending_updates: true,
      });
      const info = await bot.api.getWebhookInfo();
      const allowed = new Set(info.allowed_updates ?? []);
      const missing = [...ALLOWED_UPDATES].filter((t) => !allowed.has(t));
      result = {
        ok: true,
        message: `Webhook установлен на ${webhookUrl}`,
        details: info,
        missing_allowed_updates: missing,
      };
    }
  } catch (err) {
    result = {
      ok: false,
      message: "Ошибка при настройке webhook",
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
