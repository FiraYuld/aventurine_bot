import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";

let client: Redis | undefined;

/** One shared Upstash client per process (created lazily, after env is loaded). */
export function getRedis(): Redis {
  if (!client) {
    const c = getConfig();
    client = new Redis({
      url: c.upstashRedisRestUrl,
      token: c.upstashRedisRestToken,
    });
  }
  return client;
}
