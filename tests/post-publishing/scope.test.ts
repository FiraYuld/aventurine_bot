process.env.TELEGRAM_BOT_TOKEN = "1:test";
process.env.TELEGRAM_WEBHOOK_SECRET = "secret";
process.env.CHANNEL_ID = "-100200";
process.env.CHAT_ID = "-100300";
process.env.ADMIN_LOG_CHAT_ID = "1001";
process.env.MODERATION_CHAT_ID = "-100400";
process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "token";

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Context, NextFunction } from "grammy";
import { scopeMiddleware } from "../../src/middleware/scope.js";
import { config } from "../../src/config.js";

const OWNER_ID = config.adminLogChatId;
const MOD_CHAT_ID = config.moderationChatId;

function makeCallbackCtx(opts: {
  data: string;
  userId: number;
  chatId: number;
  chatType?: "private" | "supergroup";
}): Context & { answerCallbackQuery: ReturnType<typeof mock.fn> } {
  const answerCallbackQuery = mock.fn(async () => {});
  const chat = { id: opts.chatId, type: opts.chatType ?? "private" } as const;
  const from = { id: opts.userId, is_bot: false as const, first_name: "User" };
  const message = {
    message_id: 1,
    date: 0,
    chat,
  };
  const callbackQuery = {
    id: "cq1",
    data: opts.data,
    from,
    message,
  };

  return {
    update: {
      update_id: 1,
      callback_query: callbackQuery,
    },
    callbackQuery,
    from,
    chat,
    answerCallbackQuery,
  } as unknown as Context & { answerCallbackQuery: ReturnType<typeof mock.fn> };
}

test("post:* callback from owner private chat calls next", async () => {
  const next = mock.fn(async () => {});
  const ctx = makeCallbackCtx({
    data: "post:channel",
    userId: OWNER_ID,
    chatId: OWNER_ID,
    chatType: "private",
  });

  await scopeMiddleware(ctx, next as NextFunction);

  assert.equal(next.mock.callCount(), 1);
  assert.equal(ctx.answerCallbackQuery.mock.callCount(), 0);
});

test("post:* callback from stranger private chat is rejected", async () => {
  const next = mock.fn(async () => {});
  const ctx = makeCallbackCtx({
    data: "post:channel",
    userId: 9999,
    chatId: 9999,
    chatType: "private",
  });

  await scopeMiddleware(ctx, next as NextFunction);

  assert.equal(next.mock.callCount(), 0);
  assert.equal(ctx.answerCallbackQuery.mock.callCount(), 1);
});

test("moderation callback allowed only from moderation chat", async () => {
  const next = mock.fn(async () => {});

  const allowed = makeCallbackCtx({
    data: "react:ban:123",
    userId: OWNER_ID,
    chatId: MOD_CHAT_ID,
    chatType: "supergroup",
  });
  await scopeMiddleware(allowed, next as NextFunction);
  assert.equal(next.mock.callCount(), 1);

  const rejected = makeCallbackCtx({
    data: "react:ban:123",
    userId: OWNER_ID,
    chatId: OWNER_ID,
    chatType: "private",
  });
  await scopeMiddleware(rejected, next as NextFunction);
  assert.equal(next.mock.callCount(), 1);
  assert.equal(rejected.answerCallbackQuery.mock.callCount(), 1);
});

test("chat_member updates pass only for the discussion chat and the channel", async () => {
  const makeCtx = (chatId: number, type: "channel" | "supergroup") => {
    const chat = { id: chatId, type, title: "x" };
    const chatMember = { chat, from: { id: 5, is_bot: false, first_name: "U" } };
    return { update: { update_id: 1, chat_member: chatMember }, chatMember, chat } as unknown as Context;
  };

  for (const [chatId, type, expected] of [
    [config.channelId, "channel", 1],
    [config.chatId, "supergroup", 1],
    [-100999, "channel", 0],
  ] as const) {
    const next = mock.fn(async () => {});
    await scopeMiddleware(makeCtx(chatId, type), next as NextFunction);
    assert.equal(next.mock.callCount(), expected, String(chatId));
  }
});
