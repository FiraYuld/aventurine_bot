import { getRedis } from "./redis.js";

/**
 * Per-user lock for everything that reads and rewrites a moderation card or decides on
 * an automatic action (tournament link guard vs "✅ Свой", ban follow-up vs "✅ Свой").
 * Without it a click racing a ban could overwrite the ban mark, or a link check that
 * started before "✅ Свой" could still mute the confirmed person.
 *
 * Strict by default: if the lock can't be taken (held too long, Redis error) the
 * operation does NOT run and CardLockBusyError is thrown — callers skip the automatic
 * action or ask the moderator to press again. `bestEffort` runs anyway (only for
 * writes that can't hurt anyone, e.g. posting a new join card).
 *
 * Wait is short (3 s) so a webhook stays inside its 9 s budget; TTL 8 s covers the
 * longest holder (link guard: getChatMember + delete + restrict + card ≈ 1–2 s).
 *
 *   j = discussion chat / channel join log, t = tournament chat.
 */
export type CardLockScope = "j" | "t";

export class CardLockBusyError extends Error {
  constructor(key: string) {
    super(`card lock busy: ${key}`);
    this.name = "CardLockBusyError";
  }
}

export interface CardLockOptions {
  bestEffort?: boolean;
}

type LockImpl = <T>(key: string, fn: () => Promise<T>, opts: CardLockOptions) => Promise<T>;

export interface CardLockRedis {
  set(key: string, value: string, opts: { nx: true; px: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exported for tests; production uses Upstash with ttl 8 s / wait 3 s. */
export function makeRedisCardLock(
  getRedisClient: () => CardLockRedis,
  timing = { ttlMs: 8_000, waitMs: 3_000, pollMs: 100 },
): LockImpl {
  return async (key, fn, opts) => {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let acquired = false;
    let r: CardLockRedis | undefined;
    const deadline = Date.now() + timing.waitMs;
    try {
      r = getRedisClient();
      for (;;) {
        if ((await r.set(key, token, { nx: true, px: timing.ttlMs })) === "OK") {
          acquired = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(timing.pollMs);
      }
    } catch (err) {
      console.error("[card-lock] acquire failed", { key, err });
    }
    if (!acquired && !opts.bestEffort) throw new CardLockBusyError(key);
    try {
      return await fn();
    } finally {
      if (acquired && r) {
        await r.eval(RELEASE_SCRIPT, [key], [token]).catch((err) => console.error("[card-lock] release failed", { key, err }));
      }
    }
  };
}

const redisLock: LockImpl = makeRedisCardLock(() => getRedis() as unknown as CardLockRedis);

let impl: LockImpl = redisLock;

export function withCardLock<T>(
  scope: CardLockScope,
  userId: number,
  fn: () => Promise<T>,
  opts: CardLockOptions = {},
): Promise<T> {
  return impl(`cardlock:${scope}:${userId}`, fn, opts);
}

/** Tests only: replace the Redis lock (undefined restores it). */
export function setCardLockForTests(lock: LockImpl | undefined): void {
  impl = lock ?? redisLock;
}
