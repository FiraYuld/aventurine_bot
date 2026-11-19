// End-to-end dry run: real webhook → real bot → fake Telegram + fake Redis.
// Run alone with `npm run verify` (also part of `npm test`). See tests/e2e/harness.ts.
import { FAKE, DESTRUCTIVE, deliver, setMember, tgCalls, trace, writes } from "./harness.js";

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { chatId: CHAT, channelId: CHANNEL, moderationChatId: MOD, tournamentChatId: TOUR } = FAKE;

const user = (id: number, first_name: string, username?: string) => ({
  id,
  is_bot: false as const,
  first_name,
  ...(username ? { username } : {}),
});

let reactedMessageId = 100;
const reaction = (from: ReturnType<typeof user> | null, actorChat?: { id: number; title: string }) => ({
  message_reaction: {
    chat: { id: CHAT, type: "supergroup" as const, title: "Обсуждение" },
    message_id: reactedMessageId++,
    date: 0,
    ...(from ? { user: from } : {}),
    ...(actorChat ? { actor_chat: { ...actorChat, type: "channel" as const } } : {}),
    old_reaction: [],
    new_reaction: [{ type: "emoji" as const, emoji: "👍" as const }],
  },
});

const methods = (calls: { method: string; payload: Record<string, unknown> }[]) =>
  calls.map((c) => `${c.method}:${c.payload.chat_id ?? ""}`);

test("webhook rejects a request without the right secret", async () => {
  const r = await deliver(reaction(user(1, "Кто-то")), { secret: "wrong" });
  assert.equal(r.status, 401);
  // getMe (bot init) may run first; nothing else may.
  assert.deepEqual(r.calls.filter((c) => c.method !== "getMe"), [], trace(r.calls));
});

test("subscriber reacting: nothing is written to Telegram", async () => {
  const u = user(10, "Подписчик", "fan");
  setMember(CHANNEL, u.id, "member");
  const r = await deliver(reaction(u));
  assert.equal(r.status, 200);
  assert.deepEqual(writes(r.calls), [], trace(r.calls));
});

test("non-subscriber: card + warning, then edits, then ban on the 3rd reaction (no deletions)", async () => {
  const u = user(20, "Ivan12345");
  setMember(CHANNEL, u.id, "left");
  setMember(CHAT, u.id, "member");

  const first = await deliver(reaction(u));
  const m1 = methods(writes(first.calls));
  assert.deepEqual(m1, [`sendMessage:${MOD}`, `sendMessage:${CHAT}`], trace(first.calls));
  assert.match(String(first.calls.find((c) => c.method === "sendMessage")?.payload.text), /Подозрительная реакция/);

  const second = await deliver(reaction(u));
  const m2 = methods(writes(second.calls));
  assert.deepEqual(m2, [`editMessageText:${MOD}`, `editMessageText:${CHAT}`], trace(second.calls));

  const third = await deliver(reaction(u));
  const m3 = methods(writes(third.calls));
  assert.ok(m3.includes(`banChatMember:${CHAT}`), trace(third.calls));
  assert.ok(m3.includes(`banChatMember:${CHANNEL}`), trace(third.calls));
  assert.ok(!third.calls.some((c) => DESTRUCTIVE.has(c.method)), `deleted content on autoban:\n${trace(third.calls)}`);

  // Session is gone: a 4th reaction starts over with a fresh card instead of a second ban.
  const fourth = await deliver(reaction(u));
  assert.ok(!fourth.calls.some((c) => c.method === "banChatMember"), trace(fourth.calls));
});

test("spam nickname: immediate ban, still no deletions", async () => {
  const u = user(30, "НЕ НАЖИМАЙ СЮДА!");
  setMember(CHANNEL, u.id, "left");
  const r = await deliver(reaction(u));
  const m = methods(writes(r.calls));
  assert.ok(m.includes(`banChatMember:${CHAT}`), trace(r.calls));
  assert.ok(!r.calls.some((c) => DESTRUCTIVE.has(c.method)), trace(r.calls));
});

test("subscription check fails for another reason: never treated as 'not subscribed'", async () => {
  const u = user(40, "Ivan99999");
  setMember(CHANNEL, u.id, { error: "Bad Request: chat not found" });
  const r = await deliver(reaction(u));
  assert.equal(r.status, 200);
  assert.ok(!r.calls.some((c) => c.method.startsWith("ban") || c.method === "restrictChatMember"), trace(r.calls));
  assert.ok(!r.calls.some((c) => c.method === "sendMessage" && c.payload.chat_id === CHAT), trace(r.calls));
});

test("chat admin who is not subscribed: left alone", async () => {
  const u = user(50, "Админ");
  setMember(CHANNEL, u.id, "left");
  setMember(CHAT, u.id, "administrator");
  const r = await deliver(reaction(u));
  assert.deepEqual(writes(r.calls), [], trace(r.calls));
});

test("own channel / the chat itself as actor: no action", async () => {
  const a = await deliver(reaction(null, { id: CHANNEL, title: "Наш канал" }));
  const b = await deliver(reaction(null, { id: CHAT, title: "Обсуждение" }));
  assert.deepEqual(writes([...a.calls, ...b.calls]), [], trace([...a.calls, ...b.calls]));
});

test("foreign channel: one card for moderators, no automatic ban, no repeat card", async () => {
  const foreign = { id: -1009990001, title: "Чужой канал" };
  const first = await deliver(reaction(null, foreign));
  assert.deepEqual(methods(writes(first.calls)), [`sendMessage:${MOD}`], trace(first.calls));
  const again = await deliver(reaction(null, foreign));
  assert.deepEqual(writes(again.calls), [], trace(again.calls));
});

test("tournament chat: newcomer's link is deleted and muted there only", async () => {
  const u = user(60, "Скуп аккаунтов");
  const join = await deliver({
    chat_member: {
      chat: { id: TOUR, type: "supergroup", title: "Турниры" },
      from: u,
      date: 0,
      old_chat_member: { status: "left", user: u },
      new_chat_member: { status: "member", user: u },
    },
  });
  assert.ok(methods(writes(join.calls)).includes(`sendMessage:${MOD}`), trace(join.calls));

  const link = await deliver({
    message: {
      message_id: 10,
      date: 0,
      chat: { id: TOUR, type: "supergroup", title: "Турниры" },
      from: u,
      text: "Продать аккаунт тут: t.me/+FakeInviteCode",
    },
  });
  const m = methods(writes(link.calls));
  assert.ok(m.includes(`deleteMessage:${TOUR}`), trace(link.calls));
  assert.ok(m.includes(`restrictChatMember:${TOUR}`), trace(link.calls));
  assert.ok(!link.calls.some((c) => c.method === "banChatMember"), trace(link.calls));
});

after(() => {
  // Global invariants over the whole run.
  const auto = tgCalls.filter((c) => DESTRUCTIVE.has(c.method));
  const outsideTournament = auto.filter((c) => c.payload.chat_id !== TOUR);
  assert.deepEqual(outsideTournament, [], `content deleted outside the tournament chat:\n${trace(outsideTournament)}`);
});
