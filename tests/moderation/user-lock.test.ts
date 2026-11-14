import assert from "node:assert/strict";
import { test } from "node:test";
import { withLock, type LockRedis, type LockOptions } from "../../src/user-lock.js";

/** In-memory Redis with SET NX PX and the compare-and-delete release script. */
class FakeRedis implements LockRedis {
  store = new Map<string, { value: string; expiresAt: number }>();
  failSet = false;

  async set(key: string, value: string, opts: { nx: true; px: number }): Promise<unknown> {
    if (this.failSet) throw new Error("redis down");
    const cur = this.store.get(key);
    if (cur && cur.expiresAt > Date.now() && opts.nx) return null;
    this.store.set(key, { value, expiresAt: Date.now() + opts.px });
    return "OK";
  }

  async eval(_script: string, keys: string[], args: string[]): Promise<unknown> {
    const cur = this.store.get(keys[0]!);
    if (cur && cur.value === args[0]) {
      this.store.delete(keys[0]!);
      return 1;
    }
    return 0;
  }
}

const FAST: LockOptions = { ttlMs: 2_000, waitMs: 1_000, pollMs: 5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("serialises concurrent work on the same key", async () => {
  const redis = new FakeRedis();
  const log: string[] = [];
  const job = (name: string) =>
    withLock(redis, "reactlock:1", async () => {
      log.push(`${name}:start`);
      await sleep(30);
      log.push(`${name}:end`);
    }, FAST);

  await Promise.all([job("a"), job("b")]);

  // No interleaving: each job finishes before the other starts.
  assert.deepEqual(
    [log[0]!.split(":")[1], log[1]!.split(":")[1], log[2]!.split(":")[1], log[3]!.split(":")[1]],
    ["start", "end", "start", "end"],
  );
  assert.equal(log[0]!.split(":")[0], log[1]!.split(":")[0]);
  assert.equal(redis.store.size, 0, "lock released");
});

test("different keys do not block each other", async () => {
  const redis = new FakeRedis();
  const log: string[] = [];
  const job = (key: string) =>
    withLock(redis, key, async () => {
      log.push(`${key}:start`);
      await sleep(30);
      log.push(`${key}:end`);
    }, FAST);

  await Promise.all([job("reactlock:1"), job("reactlock:2")]);

  assert.deepEqual(log.slice(0, 2).map((l) => l.split(":")[2]), ["start", "start"]);
});

test("runs anyway when the lock is stuck, and does not release someone else's lock", async () => {
  const redis = new FakeRedis();
  redis.store.set("reactlock:1", { value: "other", expiresAt: Date.now() + 60_000 });

  let ran = false;
  await withLock(redis, "reactlock:1", async () => void (ran = true), {
    ...FAST,
    waitMs: 30,
  });

  assert.equal(ran, true);
  assert.equal(redis.store.get("reactlock:1")?.value, "other");
});

test("runs anyway when Redis fails, and releases the lock when fn throws", async () => {
  const broken = new FakeRedis();
  broken.failSet = true;
  assert.equal(await withLock(broken, "k", async () => 42, FAST), 42);

  const redis = new FakeRedis();
  await assert.rejects(
    withLock(redis, "k", async () => {
      throw new Error("boom");
    }, FAST),
    /boom/,
  );
  assert.equal(redis.store.size, 0);
});
