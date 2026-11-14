import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "grammy/types";
import {
  parseWipeCallback,
  runBanFollowUp,
  runWipe,
  wipeCallbackData,
  type CleanupApi,
  type CleanupStore,
  type JoinLogEntry,
} from "../../src/ban-cleanup.js";

const CHAT = -100300;
const CHANNEL = -100200;
const MOD = -100400;
const USER = 777;
const targets = { chatId: CHAT, channelId: CHANNEL, moderationChatId: MOD };

class FakeApi implements CleanupApi {
  calls: string[] = [];
  fail = new Set<string>();
  lastText = "";
  lastMarkup: unknown;

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
    this.lastText = text;
    this.lastMarkup = other?.reply_markup;
  }
  async sendMessage(chatId: number, text: string, other?: Record<string, unknown>) {
    this.hit(`send:${chatId}`);
    this.lastText = text;
    this.lastMarkup = other?.reply_markup;
    return { message_id: 31 };
  }
}

class FakeStore implements CleanupStore {
  claimed = new Set<number>();
  joinIds = new Map<number, number[]>([[USER, [55]]]);
  log = new Map<number, JoinLogEntry>([[USER, { messageId: 9, html: "👤 Вход" }]]);

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
  async setJoinLog(userId: number, entry: JoinLogEntry) {
    this.log.set(userId, entry);
  }
}

const moderator: User = { id: 1, is_bot: false, first_name: "fira" };
const markupData = (m: unknown) =>
  (m as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data);

test("follow-up bans in both places WITHOUT deleting messages or reactions", async () => {
  const api = new FakeApi();
  const store = new FakeStore();

  const res = await runBanFollowUp({ api, store, targets }, USER, { by: moderator });

  assert.deepEqual(res, { ran: true, errors: [] });
  assert.deepEqual(api.calls, [`ban:${CHAT}:${USER}`, `ban:${CHANNEL}:${USER}`, `delete:${CHAT}:55`, `edit:${MOD}:9`]);
  assert.equal(api.calls.some((c) => c.includes("revoke") || c.startsWith("reactions")), false);
  assert.match(api.lastText, /🔨 <b>Забанен<\/b> \(fira\)/);
  assert.match(api.lastText, /Сообщения и реакции не тронуты/);
  assert.deepEqual(markupData(api.lastMarkup), [wipeCallbackData(USER)]);
});

test("without a join-log entry the follow-up posts a card with the wipe button", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  store.log.clear();
  store.joinIds.clear();
  const user: User = { id: USER, is_bot: false, first_name: "Paris", username: "spam" };

  await runBanFollowUp({ api, store, targets }, USER, { by: moderator, user });

  assert.deepEqual(api.calls, [`ban:${CHAT}:${USER}`, `ban:${CHANNEL}:${USER}`, `send:${MOD}`]);
  assert.match(api.lastText, /tg:\/\/user\?id=777">Paris<\/a> · @spam/);
  assert.deepEqual(markupData(api.lastMarkup), [wipeCallbackData(USER)]);
  assert.equal(store.log.get(USER)?.messageId, 31, "card remembered for the wipe step");
});

test("follow-up runs once per burst", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  await runBanFollowUp({ api, store, targets }, USER);
  assert.deepEqual(await runBanFollowUp({ api, store, targets }, USER), { ran: false, errors: [] });
});

test("wipe deletes messages and reactions only when called, then marks the entry", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  await runBanFollowUp({ api, store, targets }, USER, { by: moderator });
  api.calls = [];

  const res = await runWipe({ api, store, targets }, USER, moderator);

  assert.deepEqual(res.errors, []);
  assert.deepEqual(api.calls, [`ban:${CHAT}:${USER}:revoke`, `reactions:${CHAT}:${USER}`, `edit:${MOD}:9`]);
  assert.match(api.lastText, /Забанен[\s\S]*🧹 <b>Сообщения и реакции удалены<\/b> \(fira\)/);
  assert.doesNotMatch(api.lastText, /не тронуты/);
  assert.deepEqual(api.lastMarkup, { inline_keyboard: [] });
});

test("a failing step does not stop the others; errors are reported", async () => {
  const api = new FakeApi();
  api.fail.add(`ban:${CHANNEL}:${USER}`);
  const store = new FakeStore();

  const res = await runBanFollowUp({ api, store, targets }, USER);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0]!, /бан в канале/);
  assert.ok(api.calls.includes(`edit:${MOD}:9`));

  api.fail.add(`reactions:${CHAT}:${USER}`);
  const wipe = await runWipe({ api, store, targets }, USER);
  assert.match(wipe.errors.join(" "), /удаление реакций/);
  assert.match(api.lastText, /⚠️ удаление реакций/);
});

test("wipe callback data round-trips", () => {
  assert.equal(parseWipeCallback(wipeCallbackData(777)), 777);
  assert.equal(parseWipeCallback("j:b:777"), null);
});
