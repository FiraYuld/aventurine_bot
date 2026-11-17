process.env.TELEGRAM_BOT_TOKEN = "1:test";
process.env.TELEGRAM_WEBHOOK_SECRET = "secret";
process.env.CHANNEL_ID = "-100200";
process.env.CHAT_ID = "-100300";
process.env.ADMIN_LOG_CHAT_ID = "1001";
process.env.MODERATION_CHAT_ID = "-100400";
process.env.TOURNAMENT_CHAT_ID = "-100500";
process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "token";
delete process.env.LLM_API_KEY;

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Update } from "grammy/types";
import { getBot } from "../../src/bot.js";
import { setTournamentStoreForTests } from "../../src/handlers/tournament.js";
import type { TournamentCard, TournamentStore } from "../../src/tournament.js";

const TOUR = -100500;
const MOD = -100400;
const USER = { id: 777, is_bot: false as const, first_name: "Скуп аккаунтов" };

// In-memory store shared across the whole file (one bot instance).
const joined = new Map<number, number>();
const cards = new Map<number, TournamentCard>();
const linkClaimed = new Set<number>();
const store: TournamentStore = {
  async getJoinedAt(id) {
    return joined.get(id) ?? null;
  },
  async markJoined(id, at) {
    if (!joined.has(id)) joined.set(id, at);
  },
  async clearJoined(id) {
    joined.delete(id);
    linkClaimed.delete(id);
  },
  async claimLinkCard(id) {
    if (linkClaimed.has(id)) return false;
    linkClaimed.add(id);
    return true;
  },
  async hasLinkCard(id) {
    return linkClaimed.has(id);
  },
  async getCard(id) {
    return cards.get(id) ?? null;
  },
  async setCard(id, c) {
    cards.set(id, c);
  },
  async addJoinMessage() {},
  async takeJoinMessages() {
    return [];
  },
};
setTournamentStoreForTests(() => store);

const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
const bot = getBot();
bot.botInfo = {
  id: 42,
  is_bot: true,
  first_name: "Авантюрин",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as typeof bot.botInfo;
// Every Telegram call is intercepted: nothing leaves the process.
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload: payload as Record<string, unknown> });
  const result: unknown =
    method === "sendMessage"
      ? { message_id: 900, date: 0, chat: { id: MOD, type: "supergroup" } }
      : method === "getChatMember"
        ? { status: "member", user: USER }
        : method === "getChat"
          ? { id: (payload as { chat_id: number }).chat_id, type: "private" }
          : true;
  return { ok: true, result } as never;
});

const member = (status: "left" | "member") => ({ status, user: USER });

test("tournament join reaches the tournament handler (not swallowed by the discussion join log)", async () => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 1,
    chat_member: {
      chat: { id: TOUR, type: "supergroup", title: "Турниры" },
      from: USER,
      date: 0,
      old_chat_member: member("left"),
      new_chat_member: member("member"),
    },
  } as unknown as Update);
  assert.ok(joined.has(USER.id), "newcomer marked");
  const send = calls.find((c) => c.method === "sendMessage");
  assert.equal(send?.payload.chat_id, MOD);
  assert.match(String(send?.payload.text), /Вход в чат турниров/);
});

test("link from the newcomer: deleted and muted in the tournament chat only", async () => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: TOUR, type: "supergroup" },
      from: USER,
      text: "Продать аккаунт тут: t.me/+FakeInviteCode",
    },
  } as unknown as Update);
  const methods = calls.map((c) => `${c.method}:${c.payload.chat_id}`);
  assert.ok(methods.includes(`deleteMessage:${TOUR}`));
  assert.ok(methods.includes(`restrictChatMember:${TOUR}`));
  assert.ok(!calls.some((c) => c.method === "banChatMember"), "no automatic ban");
  assert.ok(!calls.some((c) => c.payload.chat_id === -100300 || c.payload.chat_id === -100200));
});

test("ordinary message in the tournament chat: no action", async () => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: TOUR, type: "supergroup" },
      from: { id: 888, is_bot: false, first_name: "Игрок" },
      text: "когда следующий турнир?",
    },
  } as unknown as Update);
  assert.deepEqual(calls, []);
});
