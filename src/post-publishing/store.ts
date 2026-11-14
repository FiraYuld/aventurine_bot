import type { Redis } from "@upstash/redis";
import { getRedis } from "../redis.js";
import { DRAFT_TTL_SECONDS, POST_DRAFT_STEPS, type PostDraft } from "./draft.js";

export interface PostDraftStore {
  get(userId: number): Promise<PostDraft | null>;
  set(userId: number, draft: PostDraft): Promise<void>;
  delete(userId: number): Promise<void>;
}

type DraftRedis = Pick<Redis, "get" | "set" | "del">;

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
    (POST_DRAFT_STEPS as readonly unknown[]).includes(raw.step) &&
    "buttons" in raw &&
    Array.isArray(raw.buttons)
  ) {
    return raw as PostDraft;
  }

  return null;
}

export class RedisPostDraftStore implements PostDraftStore {
  constructor(private readonly redis: DraftRedis = getRedis()) {}

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
