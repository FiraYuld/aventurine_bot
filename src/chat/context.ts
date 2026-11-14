import { getRedis } from "../redis.js";

/**
 * Короткий буфер последних сообщений в основном чате (`CHAT_ID`).
 * Используется как «фоновый» контекст для LLM при рандомной вставке и для
 * человеческой склейки короткого диалога. TTL короткий — это не «память»,
 * а скользящий буфер последних реплик.
 */

export interface RecentMessage {
  /** Отображаемое имя автора (без @). */
  author: string;
  /** Сам текст сообщения (урезанный). */
  text: string;
  /** Автор — сам бот? Помогает LLM различать реплики. */
  fromBot: boolean;
}

const KEY = "chat:recent";
const MAX_ITEMS = 20;
const MAX_TEXT_CHARS = 400;
const TTL_SEC = 6 * 60 * 60;

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}

export async function appendRecentMessage(msg: RecentMessage): Promise<void> {
  const r = getRedis();
  const item: RecentMessage = {
    author: truncate(msg.author, 64) || "?",
    text: truncate(msg.text, MAX_TEXT_CHARS),
    fromBot: msg.fromBot,
  };
  if (item.text.length === 0) return;

  await r.lpush(KEY, JSON.stringify(item));
  await r.ltrim(KEY, 0, MAX_ITEMS - 1);
  await r.expire(KEY, TTL_SEC);
}

/** Последние N сообщений в хронологическом порядке (старые → новые). */
export async function getRecentMessages(limit: number): Promise<RecentMessage[]> {
  if (limit <= 0) return [];
  const n = Math.min(limit, MAX_ITEMS);
  const r = getRedis();
  const raw = (await r.lrange(KEY, 0, n - 1)) as unknown as Array<string | RecentMessage>;
  if (!Array.isArray(raw)) return [];

  const out: RecentMessage[] = [];
  for (const v of raw) {
    const parsed = parseItem(v);
    if (parsed) out.push(parsed);
  }
  return out.reverse();
}

function parseItem(v: string | RecentMessage): RecentMessage | null {
  if (v == null) return null;
  if (typeof v === "object") {
    if (typeof v.text === "string" && typeof v.author === "string") {
      return { author: v.author, text: v.text, fromBot: Boolean(v.fromBot) };
    }
    return null;
  }
  try {
    const obj = JSON.parse(v) as Partial<RecentMessage>;
    if (typeof obj.text !== "string" || typeof obj.author !== "string") return null;
    return {
      author: obj.author,
      text: obj.text,
      fromBot: Boolean(obj.fromBot),
    };
  } catch {
    return null;
  }
}
