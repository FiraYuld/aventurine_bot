import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP_TEXT } from "../../src/handlers/commands.js";
import { REACTION_AUTOBAN_STRIKES, REACTION_AUTOBAN_WINDOW_MS } from "../../src/config.js";

test("HELP_TEXT documents /post and /cancel for owner", () => {
  assert.match(HELP_TEXT, /\/post/);
  assert.match(HELP_TEXT, /\/cancel/);
});

test("HELP_TEXT states the real autoban threshold", () => {
  assert.ok(
    HELP_TEXT.includes(
      `При ${REACTION_AUTOBAN_STRIKES} таких реакциях за ${REACTION_AUTOBAN_WINDOW_MS / 1000} с`,
    ),
  );
  assert.equal(REACTION_AUTOBAN_STRIKES, 3);
});
