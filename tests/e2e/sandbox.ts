/**
 * Sandbox for the dry-run harness (see harness.ts). ES modules evaluate imports in
 * order, so harness.ts imports this file first: it sets fake env,
 * replaces `globalThis.fetch` (only the fake Upstash host answers, every other host
 * throws) and intercepts all Telegram API calls. Nothing leaves the process, so the
 * real `.env` is never read and no real chat can be touched.
 */

export const FAKE = {
  token: "1:verify-fake-token",
  secret: "verify-secret",
  channelId: -100200,
  chatId: -100300,
  adminLogChatId: 1001,
  moderationChatId: -100400,
  tournamentChatId: -100500,
  redisUrl: "https://fake-upstash.verify.test",
} as const;

process.env.TELEGRAM_BOT_TOKEN = FAKE.token;
process.env.TELEGRAM_WEBHOOK_SECRET = FAKE.secret;
process.env.CHANNEL_ID = String(FAKE.channelId);
process.env.CHAT_ID = String(FAKE.chatId);
process.env.ADMIN_LOG_CHAT_ID = String(FAKE.adminLogChatId);
process.env.MODERATION_CHAT_ID = String(FAKE.moderationChatId);
process.env.TOURNAMENT_CHAT_ID = String(FAKE.tournamentChatId);
process.env.UPSTASH_REDIS_REST_URL = FAKE.redisUrl;
process.env.UPSTASH_REDIS_REST_TOKEN = "fake";
process.env.UPSTASH_DISABLE_TELEMETRY = "1";
delete process.env.LLM_API_KEY;

// ---------------------------------------------------------------- fake Redis

type Entry =
  | { kind: "str"; value: string; expiresAt?: number }
  | { kind: "list"; value: string[]; expiresAt?: number }
  | { kind: "set"; value: Set<string>; expiresAt?: number }
  | { kind: "zset"; value: Map<string, number>; expiresAt?: number };

export const redisData = new Map<string, Entry>();
/** Every command the bot sent to Redis, lowercase name first. */
export const redisLog: string[][] = [];

const RELEASE_SCRIPT_MARK = 'redis.call("get", KEYS[1]) == ARGV[1]';

class UnsupportedCommand extends Error {}

function live(key: string): Entry | undefined {
  const e = redisData.get(key);
  if (e?.expiresAt !== undefined && e.expiresAt <= Date.now()) {
    redisData.delete(key);
    return undefined;
  }
  return e;
}

function typed<K extends Entry["kind"]>(key: string, kind: K): Extract<Entry, { kind: K }> | undefined {
  const e = live(key);
  if (e && e.kind !== kind) throw new UnsupportedCommand(`WRONGTYPE ${key} is ${e.kind}, not ${kind}`);
  return e as Extract<Entry, { kind: K }> | undefined;
}

function listRange<T>(arr: T[], start: number, stop: number): T[] {
  const n = arr.length;
  const s = start < 0 ? Math.max(0, n + start) : start;
  const e = stop < 0 ? n + stop : Math.min(stop, n - 1);
  return s > e ? [] : arr.slice(s, e + 1);
}

const at = (a: string[], i: number): string => a[i] ?? "";

function runCommand(cmd: unknown[]): unknown {
  const [rawName, ...rawArgs] = cmd;
  const name = String(rawName).toLowerCase();
  const args = rawArgs.map((a) => String(a));
  redisLog.push([name, ...args]);
  const key = at(args, 0);

  switch (name) {
    case "get": {
      const e = typed(key, "str");
      return e ? e.value : null;
    }
    case "set": {
      let nx = false;
      let xx = false;
      let expiresAt: number | undefined;
      for (let i = 2; i < args.length; i++) {
        const opt = at(args, i).toLowerCase();
        if (opt === "nx") nx = true;
        else if (opt === "xx") xx = true;
        else if (opt === "ex") expiresAt = Date.now() + Number(at(args, ++i)) * 1000;
        else if (opt === "px") expiresAt = Date.now() + Number(at(args, ++i));
        else throw new UnsupportedCommand(`SET option ${opt}`);
      }
      const exists = live(key) !== undefined;
      if ((nx && exists) || (xx && !exists)) return null;
      redisData.set(key, { kind: "str", value: at(args, 1), expiresAt });
      return "OK";
    }
    case "del": {
      let n = 0;
      for (const k of args) if (live(k) && redisData.delete(k)) n++;
      return n;
    }
    case "exists":
      return args.filter((k) => live(k) !== undefined).length;
    case "expire": {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + Number(at(args, 1)) * 1000;
      return 1;
    }
    case "incr": {
      const e = typed(key, "str");
      const next = Number(e?.value ?? 0) + 1;
      redisData.set(key, { kind: "str", value: String(next), expiresAt: e?.expiresAt });
      return next;
    }
    case "lpush": {
      const e = typed(key, "list") ?? { kind: "list" as const, value: [] };
      for (const v of args.slice(1)) e.value.unshift(v);
      redisData.set(key, e);
      return e.value.length;
    }
    case "lrange":
      return listRange(typed(key, "list")?.value ?? [], Number(at(args, 1)), Number(at(args, 2)));
    case "ltrim": {
      const e = typed(key, "list");
      if (e) e.value = listRange(e.value, Number(at(args, 1)), Number(at(args, 2)));
      return "OK";
    }
    case "sadd": {
      const e = typed(key, "set") ?? { kind: "set" as const, value: new Set<string>() };
      let n = 0;
      for (const v of args.slice(1)) if (!e.value.has(v) && e.value.add(v)) n++;
      redisData.set(key, e);
      return n;
    }
    case "sismember":
      return typed(key, "set")?.value.has(at(args, 1)) ? 1 : 0;
    case "smembers":
      return [...(typed(key, "set")?.value ?? [])];
    case "srem": {
      const e = typed(key, "set");
      let n = 0;
      for (const v of args.slice(1)) if (e?.value.delete(v)) n++;
      return n;
    }
    case "zadd": {
      const e = typed(key, "zset") ?? { kind: "zset" as const, value: new Map<string, number>() };
      let n = 0;
      for (let i = 1; i + 1 < args.length; i += 2) {
        if (!e.value.has(at(args, i + 1))) n++;
        e.value.set(at(args, i + 1), Number(at(args, i)));
      }
      redisData.set(key, e);
      return n;
    }
    case "zrange":
    case "zremrangebyrank": {
      const e = typed(key, "zset");
      const sorted = [...(e?.value ?? new Map<string, number>())].sort((a, b) => a[1] - b[1]);
      const picked = listRange(sorted, Number(at(args, 1)), Number(at(args, 2)));
      if (name === "zrange") {
        if (args.slice(3).length) throw new UnsupportedCommand(`ZRANGE options ${args.slice(3)}`);
        return picked.map(([m]) => m);
      }
      for (const [m] of picked) e?.value.delete(m);
      return picked.length;
    }
    case "eval": {
      // Only the user-lock release script is supported (compare-and-delete).
      if (!at(args, 0).includes(RELEASE_SCRIPT_MARK)) throw new UnsupportedCommand("EVAL with unknown script");
      const lockKey = at(args, 2);
      const token = at(args, 3);
      const e = typed(lockKey, "str");
      if (e?.value === token) {
        redisData.delete(lockKey);
        return 1;
      }
      return 0;
    }
    default:
      throw new UnsupportedCommand(name.toUpperCase());
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== FAKE.redisUrl) {
    throw new Error(`[verify] blocked network call to ${url.origin} (only the fake Redis is allowed)`);
  }
  const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "null")));
  if (url.pathname === "/pipeline") {
    // The client auto-pipelines: an array of commands, one {result}|{error} each.
    return Response.json(
      (body as unknown[][]).map((cmd) => {
        try {
          return { result: runCommand(cmd) };
        } catch (err) {
          return { error: `fake Redis: ${(err as Error).message}` };
        }
      }),
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    // multi-exec etc. are not used by the bot; fail loudly instead of retrying.
    return Response.json({ error: `fake Redis: unsupported endpoint ${url.pathname}` }, { status: 400 });
  }
  try {
    return Response.json({ result: runCommand(body as unknown[]) });
  } catch (err) {
    // HTTP 400 → UpstashError at once (a thrown fetch would be retried 5 times).
    return Response.json({ error: `fake Redis: ${(err as Error).message}` }, { status: 400 });
  }
}) as typeof fetch;

