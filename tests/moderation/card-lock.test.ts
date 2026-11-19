import assert from "node:assert/strict";
import { test } from "node:test";
import { CardLockBusyError, makeRedisCardLock, type CardLockRedis } from "../../src/card-lock.js";

class FakeRedis implements CardLockRedis {
  keys = new Map<string, string>();
  down = false;
  async set(key: string, value: string) {
    if (this.down) throw new Error("redis down");
    if (this.keys.has(key)) return null;
    this.keys.set(key, value);
    return "OK";
  }
  async eval(_s: string, keys: string[], args: string[]) {
    if (this.keys.get(keys[0]!) === args[0]) this.keys.delete(keys[0]!);
    return 1;
  }
}

const timing = { ttlMs: 1000, waitMs: 50, pollMs: 5 };

test("strict lock: busy → throws and does NOT run the operation", async () => {
  const redis = new FakeRedis();
  redis.keys.set("k", "someone");
  const lock = makeRedisCardLock(() => redis, timing);
  let ran = false;
  await assert.rejects(lock("k", async () => void (ran = true), {}), CardLockBusyError);
  assert.equal(ran, false);
});

test("strict lock: Redis down → throws and does NOT run", async () => {
  const redis = new FakeRedis();
  redis.down = true;
  const lock = makeRedisCardLock(() => redis, timing);
  let ran = false;
  await assert.rejects(lock("k", async () => void (ran = true), {}), CardLockBusyError);
  assert.equal(ran, false);
});

test("bestEffort: busy → runs anyway; free lock → acquired and released", async () => {
  const redis = new FakeRedis();
  const lock = makeRedisCardLock(() => redis, timing);
  assert.equal(await lock("k", async () => redis.keys.has("k"), {}), true, "held while running");
  assert.equal(redis.keys.has("k"), false, "released");
  redis.keys.set("k", "someone");
  assert.equal(await lock("k", async () => 42, { bestEffort: true }), 42);
  assert.equal(redis.keys.get("k"), "someone", "someone else's lock untouched");
});
