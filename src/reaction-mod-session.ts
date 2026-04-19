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
  /** Все зафиксированные реакции в этой сессии (одно сообщение в чате обсуждения) */
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

function key(userId: number, discussionMessageId: number): string {
  return `reactmod:${userId}:${discussionMessageId}`;
}

export async function getReactionModSession(
  userId: number,
  discussionMessageId: number,
): Promise<ReactionModSession | null> {
  const raw: unknown = await getRedis().get(key(userId, discussionMessageId));
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
  discussionMessageId: number,
  session: ReactionModSession,
  ttlSec: number,
): Promise<void> {
  await getRedis().set(key(userId, discussionMessageId), JSON.stringify(session), { ex: ttlSec });
}

export async function deleteReactionModSession(
  userId: number,
  discussionMessageId: number,
): Promise<void> {
  await getRedis().del(key(userId, discussionMessageId));
}
