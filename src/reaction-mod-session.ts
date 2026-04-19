import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";

export interface ReactionModSession {
  moderationMessageId: number;
  strikeCount: number;
  firstAt: number;
  lastDiscussionMessageId: number;
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

export async function getReactionModSession(userId: number): Promise<ReactionModSession | null> {
  const raw: unknown = await getRedis().get(key(userId));
  if (raw == null || raw === "") return null;
  // Upstash по умолчанию парсит JSON — приходит объект, а не строка
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
