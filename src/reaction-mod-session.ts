import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";

export interface ReactionModEvent {
  messageId: number;
  emojis: string[];
}

export interface ReactionModSession {
  moderationMessageId: number;
  strikeCount: number;
  firstAt: number;
  lastDiscussionMessageId: number;
  /** Все зафиксированные реакции в этой сессии (в т.ч. по разным сообщениям) */
  reactionEvents?: ReactionModEvent[];
  /** Причины риска на момент первой реакции в сессии */
  reasons?: string[];
}

let redis: Redis | undefined;

function getRedis(): Redis {
  if (!redis) {
    const c = getConfig();
    redis = new Redis({
      url: c.upstashRedisRestUrl,
      token: c.upstashRedisRestToken,
    });
  }
  return redis;
}

function key(userId: number): string {
  return `reactmod:${userId}`;
}

function leaveAloneKey(userId: number): string {
  return `reactleave:${userId}`;
}

/** Модератор нажал «Оставить» — не эскалировать по реакциям, пока не истечёт TTL. */
export async function setReactionLeaveAlone(userId: number, ttlSec: number): Promise<void> {
  await getRedis().set(leaveAloneKey(userId), "1", { ex: ttlSec });
}

export async function isReactionLeaveAlone(userId: number): Promise<boolean> {
  const v: unknown = await getRedis().get(leaveAloneKey(userId));
  return v != null && v !== "";
}

/** Снять иммунитет после «Оставить» (для тестов / ручного сброса). @returns был ли ключ */
export async function clearReactionLeaveAlone(userId: number): Promise<boolean> {
  const had = await isReactionLeaveAlone(userId);
  if (!had) return false;
  await getRedis().del(leaveAloneKey(userId));
  return true;
}

export async function getReactionModSession(userId: number): Promise<ReactionModSession | null> {
  const raw: unknown = await getRedis().get(key(userId));
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && raw !== null && "moderationMessageId" in raw) {
    return raw as ReactionModSession;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ReactionModSession;
    } catch {
      return null;
    }
  }
  return null;
}

export async function setReactionModSession(
  userId: number,
  session: ReactionModSession,
  ttlSec: number,
): Promise<void> {
  await getRedis().set(key(userId), JSON.stringify(session), { ex: ttlSec });
}

export async function deleteReactionModSession(userId: number): Promise<void> {
  await getRedis().del(key(userId));
}
