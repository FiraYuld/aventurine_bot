import assert from "node:assert/strict";
import { test } from "node:test";
import { isTrustedActorChat } from "../../src/handlers/reaction.js";

test("own channel and the chat itself are trusted actors", () => {
  const own = { channelId: -100200, chatId: -100300 };
  assert.equal(isTrustedActorChat(-100200, own), true);
  assert.equal(isTrustedActorChat(-100300, own), true);
  assert.equal(isTrustedActorChat(-1004344481986, own), false);
});
