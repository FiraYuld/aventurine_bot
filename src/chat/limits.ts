import { Redis } from "@upstash/redis";
import { getConfig } from "../config.js";

/**
 * Суточные лимиты для LLM-режима:
 *   - `chat:user:{userId}:{date}` — счётчик ответов конкретному пользователю.
 *   - `chat:random:{date}` — счётчик «рандомных» ответов в чате.
 *   - `chat:msgcnt:{date}` — глобальный счётчик сообщений в чате (для шага рандома).
 *
 * Все ключи TTL-ятся до ближайшей полуночи в таймзоне `CHAT_TZ`
 * (поддерживаем Europe/Moscow, UTC+3 без DST).
 */

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

const MSK_OFFSET_HOURS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function mskShiftedMs(now: Date = new Date()): number {
  return now.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000;
}

/** YYYY-MM-DD в текущей локальной таймзоне (сейчас всегда Europe/Moscow). */
export function currentDateKey(now: Date = new Date()): string {
  const shifted = new Date(mskShiftedMs(now));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Сколько секунд до ближайшей полуночи в таймзоне чата. */
export function ttlUntilMidnightSec(now: Date = new Date()): number {
  const shifted = mskShiftedMs(now);
  const msIntoDay = shifted % DAY_MS;
  const msToMidnight = DAY_MS - msIntoDay;
  return Math.max(1, Math.ceil(msToMidnight / 1000));
}

function userKey(userId: number, date: string): string {
  return `chat:user:${userId}:${date}`;
}

function randomKey(date: string): string {
  return `chat:random:${date}`;
}

function msgCounterKey(date: string): string {
  return `chat:msgcnt:${date}`;
}

function userLimitNoticeKey(userId: number, date: string): string {
  return `chat:user:${userId}:limitnoticed:${date}`;
}

function usersSeenKey(date: string): string {
  return `chat:users:${date}`;
}

async function incrWithTtl(key: string, ttlSec: number): Promise<number> {
  const r = getRedis();
  const next = (await r.incr(key)) as number;
  if (next === 1) {
    await r.expire(key, ttlSec);
  }
  return next;
}

/**
 * Попытаться потратить квоту ответа для пользователя.
 * Возвращает { allowed, used, cap }.
 * - allowed=true: квота потрачена, можно отвечать.
 * - allowed=false: потолок уже достигнут; used >= cap.
 */
export async function tryConsumeUserQuota(userId: number): Promise<{
  allowed: boolean;
  used: number;
  cap: number;
}> {
  const c = getConfig();
  const cap = c.chatUserDailyCap;
  if (cap <= 0) return { allowed: false, used: 0, cap };
  const date = currentDateKey();
  const ttl = ttlUntilMidnightSec();
  // Трекаем, какие пользователи участвовали сегодня — нужно для admin reset all.
  await trackUserSeen(userId, date, ttl).catch(() => {});
  const key = userKey(userId, date);
  const used = await incrWithTtl(key, ttl);
  if (used > cap) {
    return { allowed: false, used, cap };
  }
  return { allowed: true, used, cap };
}

/** Сколько ответов уже потрачено пользователем сегодня (без инкремента). */
export async function getUserUsed(userId: number): Promise<number> {
  const date = currentDateKey();
  const v = await getRedis().get(userKey(userId, date));
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Сколько «рандомных» ответов уже потрачено сегодня (без инкремента). */
export async function getRandomUsed(): Promise<number> {
  const date = currentDateKey();
  const v = await getRedis().get(randomKey(date));
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Текущее значение счётчика сообщений сегодня (без инкремента). */
export async function getGlobalMessageCounter(): Promise<number> {
  const date = currentDateKey();
  const v = await getRedis().get(msgCounterKey(date));
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Попытаться потратить «рандомную» квоту чата.
 * Возвращает allowed и счётчик после инкремента.
 */
export async function tryConsumeRandomQuota(): Promise<{
  allowed: boolean;
  used: number;
  cap: number;
}> {
  const c = getConfig();
  const cap = c.chatDailyRandomCap;
  if (cap <= 0) return { allowed: false, used: 0, cap };
  const date = currentDateKey();
  const key = randomKey(date);
  const ttl = ttlUntilMidnightSec();
  const used = await incrWithTtl(key, ttl);
  if (used > cap) {
    return { allowed: false, used, cap };
  }
  return { allowed: true, used, cap };
}

/**
 * Инкремент глобального счётчика сообщений чата. Возвращает новое значение.
 * Используется только для шага рандом-вставок (`counter % N === 0`).
 */
export async function incGlobalMessageCounter(): Promise<number> {
  const date = currentDateKey();
  const key = msgCounterKey(date);
  const ttl = ttlUntilMidnightSec();
  return await incrWithTtl(key, ttl);
}

/**
 * Попытаться «пометить» уведомление о лимите как уже отправленное сегодня
 * этому пользователю. Возвращает true, если пометили только что (надо отправить),
 * и false, если уже было помечено ранее (молчим).
 */
export async function tryMarkLimitNoticeSent(userId: number): Promise<boolean> {
  const date = currentDateKey();
  const key = userLimitNoticeKey(userId, date);
  const ttl = ttlUntilMidnightSec();
  const r = getRedis();
  const ok = await r.set(key, "1", { ex: ttl, nx: true });
  return ok === "OK";
}

// -------- Админские утилиты (показ/сброс) --------

export async function resetUserQuotaForToday(userId: number): Promise<void> {
  const date = currentDateKey();
  await getRedis().del(userKey(userId, date));
}

export async function resetRandomQuotaForToday(): Promise<void> {
  const date = currentDateKey();
  await getRedis().del(randomKey(date));
}

export async function resetGlobalMessageCounterForToday(): Promise<void> {
  const date = currentDateKey();
  await getRedis().del(msgCounterKey(date));
}

export async function resetUserLimitNoticeForToday(userId: number): Promise<void> {
  const date = currentDateKey();
  await getRedis().del(userLimitNoticeKey(userId, date));
}

export async function resetAllUserQuotasForToday(): Promise<{ users: number }> {
  const date = currentDateKey();
  const r = getRedis();
  const raw = (await r.smembers(usersSeenKey(date))) as unknown as Array<string | number>;
  const ids = (Array.isArray(raw) ? raw : [])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);

  await Promise.all(
    ids.map(async (userId) => {
      await r.del(userKey(userId, date));
      await r.del(userLimitNoticeKey(userId, date));
    }),
  );
  await r.del(usersSeenKey(date));
  return { users: ids.length };
}

async function trackUserSeen(userId: number, date: string, ttlSec: number): Promise<void> {
  const r = getRedis();
  await r.sadd(usersSeenKey(date), String(userId));
  await r.expire(usersSeenKey(date), ttlSec);
}
