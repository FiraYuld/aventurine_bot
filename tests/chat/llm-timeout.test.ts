import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveLlmTimeoutMs, LLM_TIMEOUT_CAP_MS } from "../../src/chat/llm.js";

test("LLM timeout is capped below the webhook budget", () => {
  assert.equal(effectiveLlmTimeoutMs(15_000), LLM_TIMEOUT_CAP_MS);
  assert.equal(effectiveLlmTimeoutMs(3_000), 3_000);
  assert.ok(LLM_TIMEOUT_CAP_MS < 9_000, "must stay under the 9 s grammY webhook timeout");
});
