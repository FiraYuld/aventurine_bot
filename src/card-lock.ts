import { getRedis } from "./redis.js";
import { withLock, type LockRedis } from "./user-lock.js";

/**
 * Per-user lock for everything that reads and rewrites a moderation card or decides on
 * an automatic action (tournament link guard vs "✅ Свой", ban follow-up vs "✅ Свой").
 * Without it a click racing a ban could overwrite the ban mark, or a link check that
 * started before "✅ Свой" could still mute the confirmed person.
 *
 *   j = discussion chat / channel join log, t = tournament chat.
 */
export type CardLockScope = "j" | "t";
type LockImpl = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

const redisLock: LockImpl = (key, fn) => withLock(getRedis() as unknown as LockRedis, key, fn);
let impl: LockImpl = redisLock;

export function withCardLock<T>(scope: CardLockScope, userId: number, fn: () => Promise<T>): Promise<T> {
  return impl(`cardlock:${scope}:${userId}`, fn);
}

/** Tests only: replace the Redis lock (undefined restores it). */
export function setCardLockForTests(lock: LockImpl | undefined): void {
  impl = lock ?? redisLock;
}
