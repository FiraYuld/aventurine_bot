/**
 * Dry-run harness: drives real Telegram updates through the real webhook
 * (`api/telegram.ts`) with every outside service faked in-process.
 * The sandbox import must stay first: it fakes env, network and Redis before
 * any bot code is evaluated.
 */
import { FAKE } from "./sandbox.js";

export { FAKE, redisData, redisLog } from "./sandbox.js";
import type { Update } from "grammy/types";
import { getBot } from "../../src/bot.js";
import webhook from "../../api/telegram.js";

export interface TgCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Every Telegram API call the bot made, in order. */
export const tgCalls: TgCall[] = [];

/** Membership answers for getChatMember: `${chatId}:${userId}` → status or an API error. */
export const members = new Map<string, string | { error: string }>();

export function setMember(chatId: number, userId: number, status: string | { error: string }): void {
  members.set(`${chatId}:${userId}`, status);
}

let nextMessageId = 5000;

const bot = getBot();
if (bot.token !== FAKE.token) {
  throw new Error("[verify] bot was created with a non-fake token; refusing to run");
}
bot.api.config.use(async (_prev, method, payload) => {
  const p = (payload ?? {}) as Record<string, unknown>;
  tgCalls.push({ method, payload: p });
  const ok = (result: unknown) => ({ ok: true, result }) as never;
  switch (method) {
    case "getMe":
      return ok({
        id: 42,
        is_bot: true,
        first_name: "Авантюрин",
        username: "verify_bot",
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      });
    case "getChatMember": {
      const answer = members.get(`${p.chat_id}:${p.user_id}`) ?? { error: "Bad Request: user not found" };
      if (typeof answer === "object") {
        return { ok: false, error_code: 400, description: answer.error } as never;
      }
      return ok({ status: answer, user: { id: p.user_id, is_bot: false, first_name: "U" } });
    }
    case "getChat":
      return ok({ id: p.chat_id, type: Number(p.chat_id) < 0 ? "supergroup" : "private", title: "Чат" });
    case "sendMessage":
      return ok({
        message_id: nextMessageId++,
        date: 0,
        chat: { id: p.chat_id, type: "supergroup" },
        text: p.text,
      });
    case "editMessageText":
      return ok({ message_id: p.message_id, date: 0, chat: { id: p.chat_id, type: "supergroup" }, text: p.text });
    default:
      return ok(true);
  }
});

let nextUpdateId = 1;

/**
 * Sends one update through the real webhook entry point, as Telegram would.
 * Returns the HTTP status and the Telegram calls made while handling it.
 */
export async function deliver(
  update: Omit<Update, "update_id"> & { update_id?: number },
  opts: { secret?: string } = {},
): Promise<{ status: number; calls: TgCall[]; ms: number }> {
  const before = tgCalls.length;
  const started = Date.now();
  const res = await webhook.fetch(
    new Request("https://bot.verify.test/api/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": opts.secret ?? FAKE.secret,
      },
      body: JSON.stringify({ update_id: nextUpdateId++, ...update }),
    }),
  );
  return { status: res.status, calls: tgCalls.slice(before), ms: Date.now() - started };
}

/** Human-readable call trace for assertion messages. */
export function trace(calls: TgCall[]): string {
  if (calls.length === 0) return "  (no Telegram calls)";
  return calls
    .map((c) => {
      const text = typeof c.payload.text === "string" ? ` "${c.payload.text.slice(0, 60).replace(/\n/g, " ")}"` : "";
      const target = c.payload.chat_id !== undefined ? ` chat=${c.payload.chat_id}` : "";
      const user = c.payload.user_id !== undefined ? ` user=${c.payload.user_id}` : "";
      return `  ${c.method}${target}${user}${text}`;
    })
    .join("\n");
}

/** Telegram methods that write anything (everything except reads). */
export function writes(calls: TgCall[]): TgCall[] {
  return calls.filter((c) => !/^get/.test(c.method));
}

/** Calls that destroy a person's content. These must never happen automatically. */
export const DESTRUCTIVE = new Set([
  "deleteMessage",
  "deleteMessages",
  "deleteAllMessageReactionsChat",
  "deleteChatHistory",
]);
