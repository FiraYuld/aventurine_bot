import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatPermissions, Message, User } from "grammy/types";
import {
  findLinkReason,
  guardNewcomerLink,
  parseTournamentCallback,
  recordJoin,
  tournamentBan,
  tournamentCallbackData,
  tournamentUnmute,
  tournamentWipe,
  type TournamentApi,
  type TournamentCard,
  type TournamentStore,
} from "../../src/tournament.js";

const TOUR = -100500;
const MOD = -100400;
const SPAMMER: User = { id: 777, is_bot: false, first_name: "Скуп аккаунтов", username: "spam_seller" };
const NOW = 1_800_000_000;

class FakeApi implements TournamentApi {
  calls: string[] = [];
  fail = new Set<string>();
  status = "member";
  lastText = "";
  lastMarkup: unknown;
  lastPermissions: ChatPermissions | undefined;
  private nextId = 50;

  private hit(name: string) {
    this.calls.push(name);
    const key = name.split(":")[0]!;
    if (this.fail.has(key)) throw Object.assign(new Error(key), { description: `${key} failed` });
  }
  async deleteMessage(chatId: number, messageId: number) {
    this.hit(`delete:${chatId}:${messageId}`);
  }
  async restrictChatMember(chatId: number, userId: number, permissions: ChatPermissions) {
    this.hit(`restrict:${chatId}:${userId}`);
    this.lastPermissions = permissions;
  }
  async banChatMember(chatId: number, userId: number, other?: { revoke_messages?: boolean }) {
    this.hit(`ban:${chatId}:${userId}${other?.revoke_messages ? ":revoke" : ""}`);
  }
  async getChat(chatId: number) {
    this.hit(`getChat:${chatId}`);
    return { id: chatId, permissions: { can_send_messages: true, can_send_photos: true } };
  }
  async getChatMember(chatId: number, userId: number) {
    this.hit(`getChatMember:${chatId}:${userId}`);
    return { status: this.status };
  }
  async sendMessage(chatId: number, text: string, other?: Record<string, unknown>) {
    this.hit(`send:${chatId}`);
    this.lastText = text;
    this.lastMarkup = other?.reply_markup;
    return { message_id: this.nextId++ };
  }
  async editMessageText(chatId: number, messageId: number, text: string, other?: Record<string, unknown>) {
    this.hit(`edit:${chatId}:${messageId}`);
    this.lastText = text;
    this.lastMarkup = other?.reply_markup;
  }
}

class FakeStore implements TournamentStore {
  joined = new Map<number, number>();
  linkClaimed = new Set<number>();
  cards = new Map<number, TournamentCard>();
  joinMsgs = new Map<number, number[]>();

  async getJoinedAt(userId: number) {
    return this.joined.get(userId) ?? null;
  }
  async markJoined(userId: number, at: number) {
    if (!this.joined.has(userId)) this.joined.set(userId, at);
  }
  async clearJoined(userId: number) {
    this.joined.delete(userId);
    this.linkClaimed.delete(userId);
  }
  async hasLinkCard(userId: number) {
    return this.linkClaimed.has(userId);
  }
  async claimLinkCard(userId: number) {
    if (this.linkClaimed.has(userId)) return false;
    this.linkClaimed.add(userId);
    return true;
  }
  async getCard(userId: number) {
    return this.cards.get(userId) ?? null;
  }
  async setCard(userId: number, card: TournamentCard) {
    this.cards.set(userId, card);
  }
  async addJoinMessage(userId: number, messageId: number) {
    this.joinMsgs.set(userId, [...(this.joinMsgs.get(userId) ?? []), messageId]);
  }
  async takeJoinMessages(userId: number) {
    const ids = this.joinMsgs.get(userId) ?? [];
    this.joinMsgs.delete(userId);
    return ids;
  }
}

function setup() {
  const api = new FakeApi();
  const store = new FakeStore();
  const deps = { api, store, tournamentChatId: TOUR, moderationChatId: MOD, now: () => NOW };
  return { api, store, deps };
}

/** The spam from the screenshots: "ЖМИ" is a hidden link, plus a t.me/+ invite. */
function spamMessage(id = 10, from: User = SPAMMER): Message {
  const text = "Продать свой аккаунт в Геншине, ZZZ, Honkai\nМожно тут: ЖМИ\nhttps://t.me/+FakeInviteCode";
  return {
    message_id: id,
    date: NOW,
    chat: { id: TOUR, type: "supergroup", title: "Турниры" },
    from,
    text,
    entities: [{ type: "text_link", offset: 55, length: 3, url: "https://t.me/+abc" }],
  } as Message;
}

function plain(text: string, entities?: Message["entities"]): Message {
  return { message_id: 1, date: NOW, chat: { id: TOUR, type: "supergroup" }, from: SPAMMER, text, entities } as Message;
}

function buttons(markup: unknown): string[] {
  const rows = (markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> })?.inline_keyboard ?? [];
  return rows.flat().map((b) => b.callback_data ?? "");
}

test("findLinkReason: links, hidden links, t.me text, forwards, url buttons; not plain text or @mentions", () => {
  assert.equal(findLinkReason(spamMessage()), "скрытая ссылка");
  assert.equal(findLinkReason(plain("go https://x.com", [{ type: "url", offset: 3, length: 13 }])), "ссылка");
  assert.equal(findLinkReason(plain("сюда t.me/+abcdef")), "ссылка на Telegram");
  assert.equal(
    findLinkReason({ ...plain("hi"), forward_origin: { type: "channel", date: 0, chat: { id: -1, type: "channel", title: "x" }, message_id: 1 } } as Message),
    "пересылка из канала",
  );
  assert.equal(
    findLinkReason({ ...plain("hi"), reply_markup: { inline_keyboard: [[{ text: "go", url: "https://x" }]] } } as Message),
    "кнопка со ссылкой",
  );
  assert.equal(
    findLinkReason({ ...plain("смотри"), forward_origin: { type: "user", date: 0, sender_user: SPAMMER } } as Message),
    null,
    "a forward from a person is not a link",
  );
  assert.equal(findLinkReason(plain("привет, когда следующий турнир?")), null);
  assert.equal(findLinkReason(plain("@FiraYuld можно участвовать?", [{ type: "mention", offset: 0, length: 9 }])), null);
});

test("callback data round-trips", () => {
  for (const a of ["ban", "unmute", "wipe"] as const) {
    assert.deepEqual(parseTournamentCallback(tournamentCallbackData(a, 42)), { action: a, userId: 42 });
  }
  assert.equal(parseTournamentCallback("t:x:1"), null);
  assert.equal(parseTournamentCallback("j:b:1"), null);
});

test("newcomer link: delete, mute, one card with ban/unmute; copies only deleted", async () => {
  const { api, store, deps } = setup();
  store.joined.set(SPAMMER.id, NOW - 30);

  const r1 = await guardNewcomerLink(deps, spamMessage(10));
  assert.equal(r1.acted, true);
  assert.deepEqual(r1.errors, []);
  assert.ok(api.calls.includes(`delete:${TOUR}:10`));
  assert.ok(api.calls.includes(`restrict:${TOUR}:${SPAMMER.id}`));
  assert.equal(api.lastPermissions?.can_send_messages, false);
  assert.ok(!api.calls.some((c) => c.startsWith("ban:")), "no ban without a moderator");
  assert.equal(api.calls.filter((c) => c.startsWith("send:")).length, 1);
  assert.match(api.lastText, /Ссылка от новичка/);
  assert.match(api.lastText, /сообщение удалено, замучен/);
  assert.deepEqual(buttons(api.lastMarkup), [`t:b:${SPAMMER.id}`, `t:u:${SPAMMER.id}`, `t:p:${SPAMMER.id}`]);

  // Second copy (Telegram delivers in parallel): deleted, no second card.
  api.calls = [];
  await guardNewcomerLink(deps, spamMessage(11));
  assert.ok(api.calls.includes(`delete:${TOUR}:11`));
  assert.ok(!api.calls.some((c) => c.startsWith("send:") || c.startsWith("edit:")));
});

test("link from a non-newcomer, an admin, or plain text from a newcomer: untouched", async () => {
  const { api, store, deps } = setup();
  assert.equal((await guardNewcomerLink(deps, spamMessage())).acted, false);

  store.joined.set(SPAMMER.id, NOW);
  assert.equal((await guardNewcomerLink(deps, plain("всем привет"))).acted, false);

  api.status = "administrator";
  assert.equal((await guardNewcomerLink(deps, spamMessage())).acted, false);
  assert.ok(!api.calls.some((c) => c.startsWith("delete:") || c.startsWith("restrict:")));
});

test("link card is appended to the join-log card", async () => {
  const { api, store, deps } = setup();
  await store.markJoined(SPAMMER.id, NOW);
  await recordJoin(deps, SPAMMER, "👤 <b>Вход в чат турниров</b>");
  assert.deepEqual(buttons(api.lastMarkup), [`t:b:${SPAMMER.id}`, `t:o:${SPAMMER.id}`, `t:p:${SPAMMER.id}`]);
  const cardId = store.cards.get(SPAMMER.id)!.messageId;

  await guardNewcomerLink(deps, spamMessage());
  assert.ok(api.calls.includes(`edit:${MOD}:${cardId}`));
  assert.match(api.lastText, /Вход в чат турниров[\s\S]*Ссылка от новичка/);
  assert.deepEqual(buttons(api.lastMarkup), [`t:b:${SPAMMER.id}`, `t:u:${SPAMMER.id}`, `t:p:${SPAMMER.id}`]);
});

test("link beats the join log: join details go under the link card, buttons kept", async () => {
  const { api, store, deps } = setup();
  await store.markJoined(SPAMMER.id, NOW);
  await guardNewcomerLink(deps, spamMessage());
  const cardId = store.cards.get(SPAMMER.id)!.messageId;

  await recordJoin(deps, SPAMMER, "👤 <b>Вход в чат турниров</b>");
  assert.equal(api.calls.filter((c) => c.startsWith("send:")).length, 1);
  assert.ok(api.calls.includes(`edit:${MOD}:${cardId}`));
  assert.deepEqual(buttons(api.lastMarkup), [`t:b:${SPAMMER.id}`, `t:u:${SPAMMER.id}`, `t:p:${SPAMMER.id}`]);
});

test("quick re-join without a link: plain join card, no unmute button", async () => {
  const { api, store, deps } = setup();
  await store.markJoined(SPAMMER.id, NOW);
  await recordJoin(deps, SPAMMER, "👤 вход 1");
  await recordJoin(deps, SPAMMER, "👤 вход 2");
  assert.equal(api.calls.filter((c) => c.startsWith("send:")).length, 2);
  assert.deepEqual(buttons(api.lastMarkup), [`t:b:${SPAMMER.id}`, `t:o:${SPAMMER.id}`, `t:p:${SPAMMER.id}`]);
});

test("after an unmute a new link from the same person gets a fresh card", async () => {
  const { api, store, deps } = setup();
  await store.markJoined(SPAMMER.id, NOW);
  await guardNewcomerLink(deps, spamMessage(10));
  await tournamentUnmute(deps, SPAMMER.id);
  await store.markJoined(SPAMMER.id, NOW); // re-joined
  api.calls = [];
  await guardNewcomerLink(deps, spamMessage(12));
  assert.ok(api.calls.some((c) => c.startsWith("edit:") || c.startsWith("send:")));
});

test("ban button: ban only in the tournament chat, delete join message, offer 🧹", async () => {
  const { api, store, deps } = setup();
  store.joined.set(SPAMMER.id, NOW);
  store.joinMsgs.set(SPAMMER.id, [5]);
  store.cards.set(SPAMMER.id, { messageId: 9, html: "card", at: NOW });

  const errors = await tournamentBan(deps, SPAMMER.id, { by: { id: 1, is_bot: false, first_name: "Модератор" } });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    api.calls.filter((c) => c.startsWith("ban:")),
    [`ban:${TOUR}:${SPAMMER.id}`],
    "never the channel or the discussion chat; no revoke",
  );
  assert.ok(api.calls.includes(`delete:${TOUR}:5`));
  assert.match(api.lastText, /Забанен в чате турниров<\/b> \(Модератор\)/);
  assert.deepEqual(buttons(api.lastMarkup), [`t:w:${SPAMMER.id}`]);
  assert.equal(store.joined.has(SPAMMER.id), false);
});

test("manual ban by someone else: no second ban call, card marked", async () => {
  const { api, deps } = setup();
  await tournamentBan(deps, SPAMMER.id, { user: SPAMMER, alreadyBanned: true });
  assert.ok(!api.calls.some((c) => c.startsWith("ban:")));
  assert.ok(api.calls.includes(`send:${MOD}`));
});

test("unmute: chat default permissions, newcomer marker cleared, buttons removed", async () => {
  const { api, store, deps } = setup();
  store.joined.set(SPAMMER.id, NOW);
  store.cards.set(SPAMMER.id, { messageId: 9, html: "card", at: NOW });
  assert.deepEqual(await tournamentUnmute(deps, SPAMMER.id), []);
  assert.equal(api.lastPermissions?.can_send_messages, true);
  assert.equal(store.joined.has(SPAMMER.id), false);
  assert.match(api.lastText, /Размучен/);
  assert.equal(api.lastMarkup, undefined);
});

test("wipe: only on the button, revoke messages in the tournament chat", async () => {
  const { api, store, deps } = setup();
  store.cards.set(SPAMMER.id, { messageId: 9, html: "card", at: NOW });
  assert.deepEqual(await tournamentWipe(deps, SPAMMER.id), []);
  assert.deepEqual(api.calls.filter((c) => c.startsWith("ban:")), [`ban:${TOUR}:${SPAMMER.id}:revoke`]);
});

test("failed delete/mute is reported on the card and as errors", async () => {
  const { api, store, deps } = setup();
  store.joined.set(SPAMMER.id, NOW);
  api.fail.add("delete");
  api.fail.add("restrict");
  const r = await guardNewcomerLink(deps, spamMessage());
  assert.equal(r.errors.length, 2);
  assert.match(api.lastText, /удалить не вышло/);
  assert.match(api.lastText, /замутить не вышло/);
});
