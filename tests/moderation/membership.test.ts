import assert from "node:assert/strict";
import { test } from "node:test";
import { GrammyError } from "grammy";
import { isChannelMember } from "../../src/moderation.js";

const CHANNEL = -100200;

function apiReturning(status: string) {
  return {
    getChatMember: async () => ({ status }) as never,
  };
}

function apiFailing(error_code: number, description: string) {
  return {
    getChatMember: async () => {
      throw new GrammyError(
        `Call to 'getChatMember' failed! (${error_code}: ${description})`,
        { ok: false, error_code, description },
        "getChatMember",
        {},
      );
    },
  };
}

test("member statuses count as subscribed", async () => {
  for (const status of ["creator", "administrator", "member"]) {
    assert.equal(await isChannelMember(apiReturning(status), 1, CHANNEL), true, status);
  }
  for (const status of ["left", "kicked", "restricted"]) {
    assert.equal(await isChannelMember(apiReturning(status), 1, CHANNEL), false, status);
  }
});

test("'user not found' style errors mean not subscribed", async () => {
  for (const description of [
    "Bad Request: user not found",
    "Bad Request: PARTICIPANT_ID_INVALID",
    "Bad Request: USER_NOT_PARTICIPANT",
  ]) {
    assert.equal(await isChannelMember(apiFailing(400, description), 1, CHANNEL), false, description);
  }
});

test("other errors are rethrown instead of being read as 'not subscribed'", async () => {
  for (const [code, description] of [
    [400, "Bad Request: chat not found"],
    [400, "Bad Request: member list is inaccessible"],
    [403, "Forbidden: bot is not a member of the channel chat"],
    [429, "Too Many Requests: retry after 5"],
  ] as const) {
    await assert.rejects(isChannelMember(apiFailing(code, description), 1, CHANNEL), GrammyError);
  }
});
