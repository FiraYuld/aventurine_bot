import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chat } from "grammy/types";
import {
  buildChannelCardHtml,
  channelCardCallbackData,
  channelCardKeyboard,
  channelCardResultHtml,
  parseChannelCardCallback,
} from "../../src/channel-reaction-card.js";

const CHANNEL = -1004344481986;

test("callback data round-trips and stays under 64 bytes", () => {
  for (const action of ["ban", "keep"] as const) {
    const data = channelCardCallbackData(action, CHANNEL);
    assert.ok(Buffer.byteLength(data) <= 64);
    assert.deepEqual(parseChannelCardCallback(data), { action, channelId: CHANNEL });
  }
  assert.equal(parseChannelCardCallback("ac:b:123"), null, "channel ids are negative");
  assert.equal(parseChannelCardCallback("b:1:2"), null);
});

test("card offers Ban and Keep and names the channel", () => {
  const kb = channelCardKeyboard(CHANNEL);
  assert.deepEqual(
    kb.inline_keyboard[0]!.map((b) => ("callback_data" in b ? b.callback_data : "")),
    [`ac:b:${CHANNEL}`, `ac:k:${CHANNEL}`],
  );

  const html = buildChannelCardHtml({
    actorChat: { id: CHANNEL, type: "channel", title: "Анон <x>", username: "Monaloveranon" } as Chat,
    chatId: -1001897444038,
    messageId: 1994325,
    emojis: ["🍓"],
  });
  assert.match(html, /Реакция от имени канала<\/b> \(🍓\)/);
  assert.match(html, /Анон &lt;x&gt;/);
  assert.match(html, /t\.me\/c\/1897444038\/1994325/);
});

test("result line says who decided and lists errors", () => {
  const by = { id: 1, is_bot: false, first_name: "fira" };
  assert.match(channelCardResultHtml("ban", by, CHANNEL), /Канал забанен<\/b> \(fira\)/);
  assert.match(channelCardResultHtml("keep", by, CHANNEL), /ignore-list/);
  assert.match(channelCardResultHtml("ban", by, CHANNEL, ["бан не прошёл: x"]), /⚠️ бан не прошёл: x/);
});
