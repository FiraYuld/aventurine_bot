import type { Api } from "grammy";
import {
  CLEANUP_DEDUPE_TTL_SEC,
  JOIN_LOG_TTL_SEC,
  JOIN_MESSAGE_TTL_SEC,
  type CleanupDeps,
  type CleanupStore,
} from "./ban-cleanup.js";
import { withCardLock } from "./card-lock.js";
import { config } from "./config.js";
import { getRedis } from "./redis.js";

/**
 * Redis side of the join log and the ban follow-up:
 *   joinmsg:<uid>    — ids of "… joined the group" service messages (48 h)
 *   joinlog:<uid>    — the moderation-chat message that carries the 🔨 / 🧹 buttons + its HTML
 *   bancleanup:<uid> — dedupe slot for the follow-up
 */

const joinMsgKey = (userId: number) => `joinmsg:${userId}`;
const joinLogKey = (userId: number) => `joinlog:${userId}`;
const cleanupKey = (userId: number) => `bancleanup:${userId}`;

export async function rememberJoinMessage(userId: number, messageId: number): Promise<void> {
  const r = getRedis();
  await r.sadd(joinMsgKey(userId), String(messageId));
  await r.expire(joinMsgKey(userId), JOIN_MESSAGE_TTL_SEC);
}

/** Points the 🧹 step at a moderation-chat message (join-log entry, ban log, card). */
export async function rememberJoinLog(userId: number, messageId: number, html: string): Promise<void> {
  await getRedis().set(joinLogKey(userId), JSON.stringify({ messageId, html }), {
    ex: JOIN_LOG_TTL_SEC,
  });
}

export function createCleanupStore(): CleanupStore {
  const r = getRedis();
  return {
    async claimCleanup(userId) {
      const ok = await r.set(cleanupKey(userId), "1", { nx: true, ex: CLEANUP_DEDUPE_TTL_SEC });
      return ok === "OK";
    },
    async getJoinMessageIds(userId) {
      const raw = (await r.smembers(joinMsgKey(userId))) as unknown as Array<string | number>;
      return (Array.isArray(raw) ? raw : [])
        .map((v) => Number(v))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
    },
    async clearJoinMessageIds(userId) {
      await r.del(joinMsgKey(userId));
    },
    async getJoinLog(userId) {
      const raw: unknown = await r.get(joinLogKey(userId));
      const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      if (
        obj &&
        typeof obj === "object" &&
        typeof (obj as { messageId?: unknown }).messageId === "number" &&
        typeof (obj as { html?: unknown }).html === "string"
      ) {
        return obj as { messageId: number; html: string };
      }
      return null;
    },
    async setJoinLog(userId, entry) {
      await rememberJoinLog(userId, entry.messageId, entry.html);
    },
  };
}

export function cleanupDeps(api: Api): CleanupDeps {
  return {
    api,
    store: createCleanupStore(),
    targets: {
      chatId: config.chatId,
      channelId: config.channelId,
      moderationChatId: config.moderationChatId,
    },
    lockCard: (userId, fn) => withCardLock("j", userId, fn),
  };
}
