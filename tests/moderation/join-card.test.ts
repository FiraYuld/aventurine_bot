import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "grammy/types";
import {
  applyJoinCardAction,
  findProfileHints,
  joinLogKeyboard,
  parseJoinCardCallback,
  joinCardCallbackData,
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

test("join card keyboard: ban, ✅ Свой, 🔄; callback data round-trips for j and t", () => {
  assert.deepEqual(buttons(joinLogKeyboard(5)), ["j:b:5", "j:o:5", "j:p:5"]);
  assert.deepEqual(buttons(joinLogKeyboard(5, "t")), ["t:b:5", "t:o:5", "t:p:5"]);
  for (const prefix of ["j", "t"] as const) {
    for (const action of ["confirm", "unconfirm", "refresh"] as const) {
      assert.deepEqual(parseJoinCardCallback(joinCardCallbackData(action, 5, prefix)), { prefix, action, userId: 5 });
    }
  }
  assert.equal(parseJoinCardCallback("j:b:5"), null, "ban is a separate handler");
});

test("✅ Свой hides the ban button; ↩️ brings it back and removes the footer", async () => {
  const { cards, edits, deps } = setup({ messageId: 9, html: CARD });
  const base = { prefix: "j" as const, userId: USER_ID, messageId: 9, fallbackHtml: "x", by: MODERATOR };

  await applyJoinCardAction(deps, { ...base, action: "confirm" });
  assert.match(edits[0]!.text, /✅ <b>Свой<\/b> — проверил\(а\) Модератор/);
  assert.deepEqual(buttons(edits[0]!.markup), [`j:r:${USER_ID}`, `j:p:${USER_ID}`]);
  assert.ok(!buttons(edits[0]!.markup).some((b) => b.startsWith("j:b:")), "no ban button after confirm");

  await applyJoinCardAction(deps, { ...base, action: "unconfirm" });
  assert.equal(edits[1]!.text, CARD);
  assert.deepEqual(buttons(edits[1]!.markup), [`j:b:${USER_ID}`, `j:o:${USER_ID}`, `j:p:${USER_ID}`]);
  assert.equal(cards.get(USER_ID)!.html, CARD);
});

test("🔄 appends the current profile with hints, replaces an older refresh, keeps buttons", async () => {
  const { edits, deps } = setup({ messageId: 9, html: CARD });
  const markup = { inline_keyboard: [[{ text: "x", callback_data: "j:b:1" }]] };
  let bio: string | undefined;
  const readProfile = async () => ({
    user: { id: USER_ID, is_bot: false as const, first_name: "Катюша" },
    profileReadable: true,
    bio,
  });
  const base = { prefix: "j" as const, action: "refresh" as const, userId: USER_ID, messageId: 9, fallbackHtml: "x", currentMarkup: markup, readProfile };

  await applyJoinCardAction(deps, { ...base, now: new Date("2026-11-19T10:00:00Z") });
  assert.match(edits[0]!.text, /🔄 <b>Профиль сейчас<\/b> \(10:00 UTC\)/);
  assert.match(edits[0]!.text, /новый аккаунт/);
  assert.match(edits[0]!.text, /похож на сеть «Кать»/);
  assert.equal(edits[0]!.markup, markup);

  bio = "Мой канал 👉 https://t.me/+abc";
  await applyJoinCardAction(deps, { ...base, now: new Date("2026-11-19T12:00:00Z") });
  const text = edits[1]!.text;
  assert.equal(text.match(/Профиль сейчас/g)?.length, 1, "older refresh replaced");
  assert.match(text, /12:00 UTC/);
  assert.match(text, /ссылка на Telegram в описании/);
  assert.ok(text.startsWith(CARD));
});

test("stored card of another message: falls back to the button's message text", async () => {
  const { edits, deps } = setup({ messageId: 1, html: "old card" });
  await applyJoinCardAction(deps, {
    prefix: "j",
    action: "confirm",
    userId: USER_ID,
    messageId: 9,
    fallbackHtml: "card text",
  });
  assert.ok(edits[0]!.text.startsWith("card text"));
});

test("'message is not modified' is not an error", async () => {
  const { deps } = setup({ messageId: 9, html: CARD });
  deps.api.editMessageText = async () => {
    throw Object.assign(new Error("400"), { description: "Bad Request: message is not modified" });
  };
  await applyJoinCardAction(deps, { prefix: "j", action: "unconfirm", userId: USER_ID, messageId: 9, fallbackHtml: "x" });
});

test("new-account hint by user ID", () => {
  const p = (id: number) => findProfileHints({ user: { id, is_bot: false, first_name: "A", username: "a" }, profileReadable: true, bio: "x" });
  assert.deepEqual(p(9_000_000_003), ["новый аккаунт"]);
  assert.deepEqual(p(900_000_001), []);
  assert.deepEqual(p(5_500_000_002), []);
});
