import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Redis } from "@upstash/redis";
import {
  DRAFT_TTL_SECONDS,
  buildPostKeyboard,
  isHttpUrl,
  type PostDraft,
} from "../../src/post-publishing/draft.js";
import { RedisPostDraftStore } from "../../src/post-publishing/store.js";

const draft: PostDraft = {
  step: "await_post",
  channelId: -100123,
  buttons: [{ text: "Сайт", url: "https://example.com" }],
};

test("accepts only absolute http and https URLs", () => {
  assert.equal(isHttpUrl("https://example.com/path"), true);
  assert.equal(isHttpUrl("http://example.com"), true);
  assert.equal(isHttpUrl("tg://resolve?domain=test"), false);
  assert.equal(isHttpUrl("example.com"), false);
});

test("puts every URL button on a separate row", () => {
  const keyboard = buildPostKeyboard([
    { text: "Первая", url: "https://example.com/1" },
    { text: "Вторая", url: "https://example.com/2" },
  ]);
  const built = keyboard.build();
  assert.equal(built.inline_keyboard.length, 2);
  assert.deepEqual(built.inline_keyboard.map((row) => row.length), [1, 1]);
  assert.deepEqual(keyboard.inline_keyboard.map((row) => row.length), [1, 1]);
});

test("stores a JSON draft under the user key with a 24-hour TTL", async () => {
  const set = mock.fn(async () => "OK");
  const redis = { set } as unknown as Redis;
  const store = new RedisPostDraftStore(redis);

  await store.set(42, draft);

  assert.deepEqual(set.mock.calls[0]?.arguments, [
    "postdraft:42",
    JSON.stringify(draft),
    { ex: DRAFT_TTL_SECONDS },
  ]);
});

test("reads drafts returned by Upstash as objects or JSON strings", async () => {
  const get = mock.fn(async () => draft as unknown);
  const redis = { get } as unknown as Redis;
  const store = new RedisPostDraftStore(redis);

  assert.deepEqual(await store.get(7), draft);
  get.mock.mockImplementationOnce(async () => JSON.stringify(draft));
  assert.deepEqual(await store.get(7), draft);
  assert.deepEqual(get.mock.calls.map((call) => call.arguments), [
    ["postdraft:7"],
    ["postdraft:7"],
  ]);
});

test("treats missing and malformed Redis values as no draft", async () => {
  const get = mock.fn(async () => null as unknown);
  const redis = { get } as unknown as Redis;
  const store = new RedisPostDraftStore(redis);

  assert.equal(await store.get(9), null);
  get.mock.mockImplementationOnce(async () => "not-json");
  assert.equal(await store.get(9), null);
  get.mock.mockImplementationOnce(async () => 123);
  assert.equal(await store.get(9), null);
});

test("deletes the draft by user key", async () => {
  const del = mock.fn(async () => 1);
  const redis = { del } as unknown as Redis;
  const store = new RedisPostDraftStore(redis);

  await store.delete(11);

  assert.deepEqual(del.mock.calls[0]?.arguments, ["postdraft:11"]);
});
