/**
 * Short per-key mutex on Redis (SET NX PX). Telegram delivers webhook updates in
 * parallel, so two quick reactions from one spammer can run the read-modify-write on the
 * reaction session at the same time: two moderation cards, two warnings, and a strike
 * counter that never reaches the cap. Holding this lock per user serialises them.
 */

export interface LockRedis {
  set(key: string, value: string, opts: { nx: true; px: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export interface LockOptions {
  /** Lock auto-expires after this many ms (crash safety). */
  ttlMs: number;
  /** Give up waiting after this many ms and run anyway. */
  waitMs: number;
  /** Poll interval while waiting. */
  pollMs: number;
}

export const DEFAULT_LOCK_OPTIONS: LockOptions = { ttlMs: 8_000, waitMs: 5_000, pollMs: 150 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding `key`. If the lock can't be taken within `waitMs` (a stuck
 * holder), `fn` still runs: losing a reaction is worse than a rare duplicate card.
 * Lock errors never block `fn`.
 */
export async function withLock<T>(
  redis: LockRedis,
  key: string,
  fn: () => Promise<T>,
  options: LockOptions = DEFAULT_LOCK_OPTIONS,
): Promise<T> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let acquired = false;
  const deadline = Date.now() + options.waitMs;
  try {
    for (;;) {
      const res = await redis.set(key, token, { nx: true, px: options.ttlMs });
      if (res === "OK") {
        acquired = true;
        break;
      }
      if (Date.now() >= deadline) {
        console.warn("[lock] wait timed out, running without lock", { key });
        break;
      }
      await sleep(options.pollMs);
    }
  } catch (err) {
    console.error("[lock] acquire failed, running without lock", { key, err });
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      await redis.eval(RELEASE_SCRIPT, [key], [token]).catch((err) => {
        console.error("[lock] release failed", { key, err });
      });
    }
  }
}
