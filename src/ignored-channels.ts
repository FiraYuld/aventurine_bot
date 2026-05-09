import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";

const KEY = "ignored-channels";

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

/**
 * Добавить канал в ignore-list. Реакции от его имени не считаются спамом
 * и не приводят к бану в ветке actor_chat.
 *
 * @returns true, если канал был добавлен впервые; false — если уже был.
 */
export async function addIgnoredChannel(channelId: number): Promise<boolean> {
  const added = await getRedis().sadd(KEY, String(channelId));
  return added === 1;
}

/**
 * Убрать канал из ignore-list.
 *
 * @returns true, если запись была удалена; false — если её и не было.
 */
export async function removeIgnoredChannel(channelId: number): Promise<boolean> {
  const removed = await getRedis().srem(KEY, String(channelId));
  return removed === 1;
}

export async function isChannelIgnored(channelId: number): Promise<boolean> {
  const has = await getRedis().sismember(KEY, String(channelId));
  return has === 1;
}

export async function listIgnoredChannels(): Promise<number[]> {
  const raw = (await getRedis().smembers(KEY)) as unknown as Array<string | number>;
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && Number.isInteger(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}
