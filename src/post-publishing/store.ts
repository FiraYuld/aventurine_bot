import { Redis } from "@upstash/redis";
import { getConfig } from "../config.js";
import { DRAFT_TTL_SECONDS, type PostDraft } from "./draft.js";

export interface PostDraftStore {
  get(userId: number): Promise<PostDraft | null>;
  set(userId: number, draft: PostDraft): Promise<void>;
  delete(userId: number): Promise<void>;
}

type DraftRedis = Pick<Redis, "get" | "set" | "del">;

function createRedis(): Redis {
  const config = getConfig();
  return new Redis({
    url: config.upstashRedisRestUrl,
    token: config.upstashRedisRestToken,
  });
}

function key(userId: number): string {
  return `postdraft:${userId}`;
}

function parseDraft(raw: unknown): PostDraft | null {
  if (typeof raw === "string") {
    try {
      return parseDraft(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    "step" in raw &&
    "channelId" in raw &&
    "buttons" in raw
  ) {
    return raw as PostDraft;
  }

  return null;
}

export class RedisPostDraftStore implements PostDraftStore {
  constructor(private readonly redis: DraftRedis = createRedis()) {}

  async get(userId: number): Promise<PostDraft | null> {
    return parseDraft(await this.redis.get(key(userId)));
  }

  async set(userId: number, draft: PostDraft): Promise<void> {
    await this.redis.set(key(userId), JSON.stringify(draft), { ex: DRAFT_TTL_SECONDS });
  }

  async delete(userId: number): Promise<void> {
    await this.redis.del(key(userId));
  }
}
