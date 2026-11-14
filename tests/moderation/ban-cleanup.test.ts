import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "grammy/types";
import { runBanCleanup, type CleanupApi, type CleanupStore } from "../../src/ban-cleanup.js";

const CHAT = -100300;
const CHANNEL = -100200;
const MOD = -100400;
const USER = 777;
const targets = { chatId: CHAT, channelId: CHANNEL, moderationChatId: MOD };

class FakeApi implements CleanupApi {
  calls: string[] = [];
  fail = new Set<string>();
  edited: { text: string; other?: Record<string, unknown> } | null = null;

  private hit(name: string) {
    this.calls.push(name);
    if (this.fail.has(name)) throw Object.assign(new Error(name), { description: `${name} failed` });
  }
  async banChatMember(chatId: number, userId: number, other?: { revoke_messages?: boolean }) {
    this.hit(`ban:${chatId}:${userId}${other?.revoke_messages ? ":revoke" : ""}`);
  }
  async deleteAllMessageReactionsUser(chatId: number, userId: number) {
    this.hit(`reactions:${chatId}:${userId}`);
  }
  async deleteMessage(chatId: number, messageId: number) {
    this.hit(`delete:${chatId}:${messageId}`);
  }
  async editMessageText(chatId: number, messageId: number, text: string, other?: Record<string, unknown>) {
    this.hit(`edit:${chatId}:${messageId}`);
    this.edited = { text, other };
  }
}

class FakeStore implements CleanupStore {
  claimed = new Set<number>();
  joinIds = new Map<number, number[]>([[USER, [55]]]);
  log = new Map<number, { messageId: number; html: string }>([[USER, { messageId: 9, html: "👤 Вход" }]]);

  async claimCleanup(userId: number) {
    if (this.claimed.has(userId)) return false;
    this.claimed.add(userId);
    return true;
  }
  async getJoinMessageIds(userId: number) {
    return this.joinIds.get(userId) ?? [];
  }
  async clearJoinMessageIds(userId: number) {
    this.joinIds.delete(userId);
  }
  async getJoinLog(userId: number) {
    return this.log.get(userId) ?? null;
  }
}

const moderator: User = { id: 1, is_bot: false, first_name: "fira" };

test("bans everywhere, wipes messages/reactions, deletes join message, marks the log entry", async () => {
  const api = new FakeApi();
  const store = new FakeStore();

  const res = await runBanCleanup({ api, store, targets }, USER, moderator);

  assert.deepEqual(res, { ran: true, errors: [] });
  assert.deepEqual(api.calls, [
    `ban:${CHAT}:${USER}:revoke`,
    `ban:${CHANNEL}:${USER}`,
    `reactions:${CHAT}:${USER}`,
    `delete:${CHAT}:55`,
    `edit:${MOD}:9`,
  ]);
  assert.match(api.edited!.text, /^👤 Вход\n\n🔨 <b>Забанен<\/b> \(fira\)/);
  assert.deepEqual(api.edited!.other?.reply_markup, { inline_keyboard: [] });
  assert.equal(store.joinIds.has(USER), false);
});

test("runs once per burst (our own bans fire chat_member updates again)", async () => {
  const api = new FakeApi();
  const store = new FakeStore();

  await runBanCleanup({ api, store, targets }, USER);
  const second = await runBanCleanup({ api, store, targets }, USER);

  assert.deepEqual(second, { ran: false, errors: [] });
  assert.equal(api.calls.filter((c) => c.startsWith("ban:")).length, 2);
});

test("a failing step does not stop the others; errors are reported", async () => {
  const api = new FakeApi();
  api.fail.add(`ban:${CHANNEL}:${USER}`);
  api.fail.add(`delete:${CHAT}:55`);
  const store = new FakeStore();

  const res = await runBanCleanup({ api, store, targets }, USER);

  assert.equal(res.ran, true);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors.join(" "), /бан в канале/);
  assert.match(res.errors.join(" "), /сообщение о входе 55/);
  assert.ok(api.calls.includes(`reactions:${CHAT}:${USER}`));
  assert.ok(api.calls.includes(`edit:${MOD}:9`));
});

test("without a join message or log entry it still bans and cleans", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  store.joinIds.clear();
  store.log.clear();

  const res = await runBanCleanup({ api, store, targets }, USER);

  assert.deepEqual(res.errors, []);
  assert.deepEqual(api.calls, [
    `ban:${CHAT}:${USER}:revoke`,
    `ban:${CHANNEL}:${USER}`,
    `reactions:${CHAT}:${USER}`,
  ]);
});
