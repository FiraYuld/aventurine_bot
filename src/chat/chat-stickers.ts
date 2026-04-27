import { Redis } from "@upstash/redis";
import { getConfig } from "../config.js";

/**
 * Реестр имён стикерпаков, замеченных в основном чате. Когда участник кидает
 * стикер из своего пака — мы запоминаем `set_name`. Потом Авантюрин может
 * «подсмотреть» в один из этих паков и кинуть оттуда рандомный стикер.
 *
 * Хранится как Redis Sorted Set: score = timestamp последнего появления,
 * member = `set_name`. Это даёт нам:
 *   - дедуп (один пак — одна запись),
 *   - самоочистку (отрезаем самые «старые» паки по rank, оставляя свежие),
 *   - возможность брать «свежий хвост» при выборе.
 */

const KEY = "chat:sticker-sets";
const MAX_SETS = 80;
const TTL_SEC = 30 * 24 * 60 * 60;

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

export async function recordStickerSetName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (trimmed.length > 100) return;
  const r = getRedis();
  await r.zadd(KEY, { score: Date.now(), member: trimmed });
  // Оставляем только последние MAX_SETS записей (по убыванию score).
  // zremrangebyrank с (0, -MAX_SETS - 1) удалит самые старые.
  await r.zremrangebyrank(KEY, 0, -MAX_SETS - 1);
  await r.expire(KEY, TTL_SEC);
}

export async function getKnownStickerSetNames(): Promise<string[]> {
  const r = getRedis();
  const raw = (await r.zrange(KEY, 0, -1)) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}
