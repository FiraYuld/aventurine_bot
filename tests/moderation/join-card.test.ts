import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "grammy/types";
import {
  applyJoinCardAction,
  findHints,
  findProfileHints,
  hasModerationResult,
  joinCardCallbackData,
  joinLogKeyboard,
  parseJoinCardCallback,
  profileRefreshHtml,
  sendProfileRefresh,
  type JoinCardEntry,
} from "../../src/join-log.js";

const MOD = -100400;
const USER_ID = 9_100_000_001;
const MODERATOR: User = { id: 1, is_bot: false, first_name: "Модератор" };

function buttons(markup: unknown): string[] {
  const rows = (markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> })?.inline_keyboard ?? [];
  return rows.flat().map((b) => b.callback_data ?? "");
}

function setup(initial?: JoinCardEntry) {
  const cards = new Map<number, JoinCardEntry>();
  if (initial) cards.set(USER_ID, initial);
  const edits: Array<{ messageId: number; text: string; markup: unknown }> = [];
  const deps = {
    api: {
      async editMessageText(_chat: number, messageId: number, text: string, other?: Record<string, unknown>) {
        edits.push({ messageId, text, markup: other?.reply_markup });
      },
    },
    getCard: async (id: number) => cards.get(id) ?? null,
    setCard: async (id: number, e: JoinCardEntry) => void cards.set(id, e),
    moderationChatId: MOD,
  };
  return { cards, edits, deps };
}

const CARD = "👤 <b>Вход в канал</b> «Сонный Уголок»\n\nИмя: Катюша";
const base = { prefix: "j" as const, userId: USER_ID, messageId: 9, fallbackHtml: "x", by: MODERATOR };

test("join card keyboard: ban, ✅ Свой, 🔄; callback data round-trips for j and t", () => {
  assert.deepEqual(buttons(joinLogKeyboard(5)), ["j:b:5", "j:o:5", "j:p:5"]);
  assert.deepEqual(buttons(joinLogKeyboard(5, "t")), ["t:b:5", "t:o:5", "t:p:5"]);
  for (const prefix of ["j", "t"] as const) {
    for (const action of ["confirm", "unconfirm", "refresh"] as const) {
      assert.deepEqual(parseJoinCardCallback(joinCardCallbackData(action, 5, prefix)), { prefix, action, userId: 5 });
    }
  }
  assert.equal(parseJoinCardCallback("j:b:5"), null, "ban is a separate handler");
  assert.ok(Buffer.byteLength(joinCardCallbackData("unconfirm", 9_999_999_999_999, "t")) <= 64);
});

test("✅ Свой hides the ban button; ↩️ brings it back and removes the footer", async () => {
  const { cards, edits, deps } = setup({ messageId: 9, html: CARD });

  assert.equal(await applyJoinCardAction(deps, { ...base, action: "confirm" }), "done");
  assert.match(edits[0]!.text, /✅ <b>Свой<\/b> — проверил\(а\) Модератор/);
  assert.deepEqual(buttons(edits[0]!.markup), [`j:r:${USER_ID}`, `j:p:${USER_ID}`]);

  await applyJoinCardAction(deps, { ...base, action: "unconfirm" });
  assert.equal(edits[1]!.text, CARD);
  assert.deepEqual(buttons(edits[1]!.markup), [`j:b:${USER_ID}`, `j:o:${USER_ID}`, `j:p:${USER_ID}`]);
  assert.equal(cards.get(USER_ID)!.html, CARD);
});

test("card that already shows a moderation result is never touched by ✅/↩️", async () => {
  const results = [
    "🔨 <b>Забанен</b> (Модератор): удалён из чата и канала.",
    "🔨 <b>Забанен в чате турниров</b>.",
    "🧹 <b>Сообщения и реакции удалены</b>.",
    "🚫 <b>Ссылка от новичка</b> (ссылка): сообщение удалено, замучен.",
    "✅ <b>Размучен</b>.",
  ];
  for (const r of results) {
    const { edits, deps } = setup({ messageId: 9, html: `${CARD}\n\n${r}` });
    assert.equal(await applyJoinCardAction(deps, { ...base, action: "confirm" }), "state-changed", r);
    assert.equal(edits.length, 0, r);
  }
  // Same marks in plain text (fallback from the message text).
  const { deps } = setup();
  assert.equal(
    await applyJoinCardAction(deps, { ...base, action: "confirm", fallbackHtml: "Вход\n\n🔨 Забанен (fira)" }),
    "state-changed",
  );
});

test("profile text can't fake a moderation mark (it is never at a paragraph start)", () => {
  const html = `${CARD}\nОписание: hello 🔨 Забанен world · 🧹 Сообщения`;
  assert.equal(hasModerationResult(html), false);
});

test("button on an old card doesn't steal the pointer to the latest card", async () => {
  const { cards, deps } = setup({ messageId: 50, html: "latest card" });
  await applyJoinCardAction(deps, { ...base, action: "confirm", fallbackHtml: "old card" });
  assert.deepEqual(cards.get(USER_ID), { messageId: 50, html: "latest card" });
});

test("plain-text fallback: undo removes the footer", async () => {
  const { edits, deps } = setup();
  const plainConfirmed = "Вход в канал\n\n✅ Свой — проверил(а) Модератор.";
  await applyJoinCardAction(deps, { ...base, action: "unconfirm", fallbackHtml: plainConfirmed });
  assert.equal(edits[0]!.text, "Вход в канал");
});

test("beforeEdit failure (e.g. Redis) leaves the card unchanged: never 'Свой' without protection", async () => {
  const { cards, edits, deps } = setup({ messageId: 9, html: CARD });
  await assert.rejects(
    applyJoinCardAction(deps, {
      ...base,
      prefix: "t",
      action: "confirm",
      beforeEdit: async () => {
        throw new Error("redis down");
      },
    }),
  );
  assert.equal(edits.length, 0);
  assert.equal(cards.get(USER_ID)!.html, CARD);
});

test("card read error stops the action (not treated as 'no card')", async () => {
  const { edits, deps } = setup({ messageId: 50, html: "latest" });
  deps.getCard = async () => {
    throw new Error("redis down");
  };
  await assert.rejects(applyJoinCardAction(deps, { ...base, action: "confirm", fallbackHtml: "old" }));
  assert.equal(edits.length, 0);
});

test("'message is not modified' is not an error", async () => {
  const { deps } = setup({ messageId: 9, html: CARD });
  deps.api.editMessageText = async () => {
    throw Object.assign(new Error("400"), { description: "Bad Request: message is not modified" });
  };
  assert.equal(await applyJoinCardAction(deps, { ...base, action: "unconfirm" }), "done");
});

test("🔄 posts the current profile as a reply under the card, with hints", async () => {
  const sent: Array<{ chatId: number; text: string; other?: Record<string, unknown> }> = [];
  const api = { sendMessage: async (chatId: number, text: string, other?: Record<string, unknown>) => void sent.push({ chatId, text, other }) };
  await sendProfileRefresh(api, {
    moderationChatId: MOD,
    cardMessageId: 9,
    now: new Date("2026-11-19T10:00:00Z"),
    profile: {
      user: { id: USER_ID, is_bot: false, first_name: "Катюша" },
      profileReadable: true,
      bio: "Мой канал 👉 https://t.me/+abc",
    },
  });
  assert.equal(sent[0]!.chatId, MOD);
  assert.deepEqual((sent[0]!.other?.reply_parameters as { message_id: number }).message_id, 9);
  assert.match(sent[0]!.text, /🔄 <b>Профиль сейчас<\/b> \(10:00 UTC\)/);
  assert.match(sent[0]!.text, /новый аккаунт/);
  assert.match(sent[0]!.text, /ссылка на Telegram в описании/);
  assert.ok(profileRefreshHtml({ user: { id: 1, is_bot: false, first_name: "<b>x</b>" }, profileReadable: false }).includes("&lt;b&gt;"));
});

test("hint regexes: no false positives on ordinary words", () => {
  assert.deepEqual(findHints(["Искупаться в море"]), []);
  assert.deepEqual(findHints(["Скупой рыцарь"]), []);
  assert.deepEqual(findHints(["Скупка аккаунтов"]), ["скуп аккаунтов"]);
  assert.deepEqual(findHints(["Продаю аккумуляторы"]), []);
  assert.deepEqual(findHints(["Продам акки HSR"]), ["скуп аккаунтов"]);
  const u = (first_name: string): User => ({ id: 1, is_bot: false, first_name });
  assert.deepEqual(findProfileHints({ user: u("A"), profileReadable: true, bio: "about.me/alice" }), []);
  assert.deepEqual(findProfileHints({ user: u("Категорически против"), profileReadable: true }), []);
  assert.deepEqual(findProfileHints({ user: u("Катя"), profileReadable: true }), ["похож на сеть «Кать» (пустой профиль)"]);
});

test("new-account hint by user ID", () => {
  const p = (id: number) => findProfileHints({ user: { id, is_bot: false, first_name: "A", username: "a" }, profileReadable: true, bio: "x" });
  assert.deepEqual(p(9_000_000_003), ["новый аккаунт"]);
  assert.deepEqual(p(900_000_001), []);
  assert.deepEqual(p(5_500_000_002), []);
});
