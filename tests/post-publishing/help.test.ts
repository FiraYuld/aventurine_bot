import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP_TEXT } from "../../src/handlers/commands.js";

test("HELP_TEXT documents /post and /cancel for owner", () => {
  assert.match(HELP_TEXT, /\/post/);
  assert.match(HELP_TEXT, /\/cancel/);
});
