import { webhookCallback } from "grammy";
import { getBot } from "../src/bot.js";
import { getConfig } from "../src/config.js";

type WebhookFn = (req: Request) => Promise<Response | undefined>;

let webhookImpl: WebhookFn | undefined;

async function handleWebhook(req: Request): Promise<Response> {
  try {
    if (!webhookImpl) {
      webhookImpl = webhookCallback(getBot(), "std/http", {
        secretToken: getConfig().webhookSecret,
        timeoutMilliseconds: 9_000,
      }) as WebhookFn;
    }
    const out = await webhookImpl(req);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ ok: false, message: "Пустой ответ webhook" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: "Ошибка инициализации webhook (проверьте env и /api/health)",
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
}

/** Объект с fetch — Telegram шлёт POST; так Vercel включает Web Request API. */
export default { fetch: handleWebhook };
