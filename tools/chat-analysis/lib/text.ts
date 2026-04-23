import type { TgMessage, TgTextPart } from "../types.ts";

/** Собирает plain-текст сообщения из `text`/`text_entities`. */
export function extractPlainText(msg: TgMessage): string {
  const raw = msg.text;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return joinParts(raw);
  const ents = msg.text_entities;
  if (Array.isArray(ents)) return joinParts(ents);
  return "";
}

function joinParts(parts: readonly TgTextPart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      if (p) out.push(p);
      continue;
    }
    if (p && typeof p === "object" && typeof p.text === "string") {
      out.push(p.text);
    }
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

/** Вытаскивает document_id кастом-эмодзи/стикеров, встреченных в тексте. */
export function extractCustomDocs(msg: TgMessage): string[] {
  const out: string[] = [];
  const parts = Array.isArray(msg.text) ? msg.text : msg.text_entities;
  if (!Array.isArray(parts)) return out;
  for (const p of parts) {
    if (typeof p === "object" && p && typeof p.document_id === "string") {
      out.push(p.document_id);
    }
  }
  return out;
}

/** Эмодзи из Unicode, включая составные (ZWJ, skin tones). Простая эвристика. */
const EMOJI_REGEX =
  /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

export function extractUnicodeEmoji(text: string): string[] {
  if (!text) return [];
  const m = text.match(EMOJI_REGEX);
  return m ? m.map((e) => e) : [];
}

/** Токенизация для n-грамм: берём словосочетания, режем служебку. */
const TOKEN_REGEX = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const toks = lower.match(TOKEN_REGEX);
  if (!toks) return [];
  return toks.filter((t) => t.length > 1 && t.length < 32);
}

/**
 * Короткий стоп-лист частотных русских/английских слов - отсекаем мусорные
 * n-граммы. Не полный, но достаточный для ранжирования.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "и", "в", "во", "не", "что", "он", "она", "оно", "они", "на", "я", "с", "со",
  "как", "а", "но", "да", "нет", "мне", "тебе", "это", "эта", "этот", "эти",
  "то", "ну", "ли", "же", "бы", "уже", "ещё", "еще", "или", "только", "был",
  "была", "было", "были", "есть", "за", "от", "до", "для", "к", "ко", "о", "об",
  "по", "про", "у", "из", "при", "над", "под", "без", "через", "между", "ты",
  "вы", "мы", "так", "там", "тут", "где", "когда", "почему", "зачем", "что-то",
  "чтото", "чё", "че", "чо", "вот", "ага", "ок", "кек", "лол", "ж", "блин",
  "блять", "нахуй", "нахуя", "хуй", "хуя", "хули", "ёбаный", "ебаный",
  "the", "a", "an", "and", "or", "is", "it", "to", "of", "in", "on", "for",
  "that", "this", "you", "i", "we", "me", "my", "so", "be", "as", "at", "but",
]);

export function ngrams(tokens: readonly string[], n: number): string[] {
  if (tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    const slice = tokens.slice(i, i + n);
    // Отсекаем n-граммы, где все токены - стопслова, и слишком короткие/длинные.
    const allStop = slice.every((t) => STOPWORDS.has(t));
    if (allStop) continue;
    // Отсекаем слишком длинные/короткие куски.
    const totalLen = slice.reduce((s, t) => s + t.length, 0);
    if (totalLen < 5) continue;
    out.push(slice.join(" "));
  }
  return out;
}

/** Считает суммарное число реакций под сообщением. */
export function totalReactions(msg: TgMessage): number {
  if (!Array.isArray(msg.reactions)) return 0;
  let sum = 0;
  for (const r of msg.reactions) sum += r.count ?? 0;
  return sum;
}

/** Обрезает до `n` символов с многоточием. */
export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}
