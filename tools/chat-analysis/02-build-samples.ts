/**
 * Шаг 2 пайплайна: собираем «корм» для LLM.
 *
 * На основе `out/stats/*.json` и `alias-map.json` делаем выборки сообщений:
 * - per-author: 40-60 представительных реплик на автора (топ-30 по активности)
 * - per-meme: 5-10 сообщений, где встречается кандидат-n-грамма (топ-40)
 * - per-event: кластеры дат по пикам активности (топ-пики) - 10-20 цитат
 *
 * Использует alias-map для нормализации имён, так что LLM не увидит реальные.
 * Запуск: npm run analysis:samples
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PATHS } from "./lib/paths.ts";
import { extractPlainText, totalReactions, truncate } from "./lib/text.ts";
import type {
  AliasMap,
  AuthorStats,
  PhrasesStats,
  QuoteRef,
  TgExport,
  TgMessage,
  TimelineStats,
} from "./types.ts";

// --- пороги ---
const TOP_AUTHORS_FOR_SAMPLES = 30;
const AUTHOR_SAMPLES_PER = 50;
const MEME_CANDIDATES = 40;
const MEME_SAMPLES_PER = 8;
const EVENT_PEAKS = 8;
const EVENT_SAMPLES_PER = 15;

interface AuthorSample {
  alias: string;
  from_id: string;
  stats: {
    messages: number;
    reactions_received: number;
    replies_sent: number;
    replies_received: number;
    first_seen: string;
    last_seen: string;
  };
  top_phrases: AuthorStats["top_phrases"];
  top_sticker_docs: AuthorStats["top_sticker_docs"];
  samples: Array<{
    id: number;
    date: string;
    text: string;
    reactions: number;
    reply_to?: { alias: string; text: string };
  }>;
}

interface MemeSample {
  phrase: string;
  total_count: number;
  unique_authors: number;
  examples: Array<{
    id: number;
    date: string;
    alias: string;
    text: string;
    reactions: number;
    context_before?: { alias: string; text: string };
  }>;
}

interface EventSample {
  day: string;
  messages: number;
  top_quotes: Array<{
    id: number;
    alias: string;
    text: string;
    reactions: number;
    reactions_breakdown: ReadonlyArray<{ key: string; count: number }>;
  }>;
}

async function main(): Promise<void> {
  ensurePrereqs();

  console.info(`[samples] читаем result.json и артефакты шага 1…`);
  const data = JSON.parse(readFileSync(PATHS.rawExport, "utf8")) as TgExport;
  const authors = readJson<AuthorStats[]>(resolve(PATHS.statsDir, "authors.json"));
  const phrases = readJson<PhrasesStats>(resolve(PATHS.statsDir, "phrases.json"));
  const quotes = readJson<QuoteRef[]>(resolve(PATHS.statsDir, "quotes.json"));
  const timeline = readJson<TimelineStats>(resolve(PATHS.statsDir, "timeline.json"));
  const aliasMap = readJson<AliasMap>(PATHS.aliasMap);

  const resolveAlias = buildAliasResolver(aliasMap);
  const msgById = new Map<number, TgMessage>();
  for (const m of data.messages) {
    if (m.type === "message" && typeof m.id === "number") msgById.set(m.id, m);
  }

  mkdirSync(PATHS.samplesDir, { recursive: true });

  // --- per-author ---
  const excluded = new Set(
    Object.entries(aliasMap)
      .filter(([, v]) => v.exclude)
      .map(([k]) => k),
  );
  const topAuthors = authors
    .filter((a) => !excluded.has(a.from_id))
    .slice(0, TOP_AUTHORS_FOR_SAMPLES);

  const authorSamples: AuthorSample[] = [];
  for (const a of topAuthors) {
    const alias = resolveAlias(a.from_id) ?? "?";
    const sample = buildAuthorSample(a, alias, data.messages, msgById, resolveAlias);
    authorSamples.push(sample);
  }
  writeJson(resolve(PATHS.samplesDir, "authors.json"), authorSamples);
  console.info(`[samples] записано авторов: ${authorSamples.length}`);

  // --- per-meme ---
  const memeCandidates = phrases.ngrams.slice(0, MEME_CANDIDATES);
  const memeSamples = buildMemeSamples(memeCandidates, data.messages, resolveAlias);
  writeJson(resolve(PATHS.samplesDir, "memes.json"), memeSamples);
  console.info(`[samples] записано мем-кандидатов: ${memeSamples.length}`);

  // --- per-event ---
  const eventSamples = buildEventSamples(
    timeline.peaks.slice(0, EVENT_PEAKS),
    quotes,
    resolveAlias,
  );
  writeJson(resolve(PATHS.samplesDir, "events.json"), eventSamples);
  console.info(`[samples] записано пиков: ${eventSamples.length}`);

  // --- топ-цитаты как отдельный файл с нормализованными алиасами ---
  const topQuotes = quotes.slice(0, 80).map((q) => ({
    id: q.message_id,
    date: q.date,
    alias: resolveAlias(q.from_id) ?? q.display_name ?? "?",
    text: q.text,
    reactions: q.total_reactions,
    reactions_breakdown: q.reactions_breakdown,
  }));
  writeJson(resolve(PATHS.samplesDir, "quotes.json"), topQuotes);
  console.info(`[samples] записано цитат: ${topQuotes.length}`);

  console.info(`\n[samples] готово. Дальше: npm run analysis:dossier`);
}

// ----------------- builders -----------------

function buildAuthorSample(
  a: AuthorStats,
  alias: string,
  allMessages: readonly TgExport["messages"][number][],
  msgById: Map<number, TgMessage>,
  resolveAlias: (id: string) => string | undefined,
): AuthorSample {
  const mine: TgMessage[] = [];
  for (const m of allMessages) {
    if (m.type !== "message") continue;
    if (m.from_id !== a.from_id) continue;
    const text = extractPlainText(m);
    if (!text || text.length < 6) continue;
    mine.push(m);
  }

  // Стратегия отбора:
  //  - топ-20 по реакциям
  //  - 10 самых длинных (в словах)
  //  - 10 коротких «визиток» (>=15 и <=60 символов)
  //  - 10 случайных для общего вайба
  const byReactions = [...mine].sort((x, y) => totalReactions(y) - totalReactions(x)).slice(0, 20);
  const byLength = [...mine]
    .sort((x, y) => extractPlainText(y).length - extractPlainText(x).length)
    .slice(0, 10);
  const shorties = mine.filter((m) => {
    const t = extractPlainText(m);
    return t.length >= 15 && t.length <= 60;
  });
  const randomShorties = pickRandom(shorties, 10);
  const randomAny = pickRandom(mine, 10);

  const picked = dedupeById([...byReactions, ...byLength, ...randomShorties, ...randomAny]);
  const limited = picked.slice(0, AUTHOR_SAMPLES_PER);
  limited.sort((x, y) => (x.date < y.date ? -1 : 1));

  const samples = limited.map((m) => {
    const replyTo = resolveReplyContext(m, msgById, resolveAlias);
    const entry: AuthorSample["samples"][number] = {
      id: m.id,
      date: m.date,
      text: truncate(extractPlainText(m), 400),
      reactions: totalReactions(m),
    };
    if (replyTo) entry.reply_to = replyTo;
    return entry;
  });

  return {
    alias,
    from_id: a.from_id,
    stats: {
      messages: a.messages,
      reactions_received: a.reactions_received,
      replies_sent: a.replies_sent,
      replies_received: a.replies_received,
      first_seen: a.first_seen,
      last_seen: a.last_seen,
    },
    top_phrases: a.top_phrases,
    top_sticker_docs: a.top_sticker_docs,
    samples,
  };
}

function buildMemeSamples(
  candidates: PhrasesStats["ngrams"],
  allMessages: readonly TgExport["messages"][number][],
  resolveAlias: (id: string) => string | undefined,
): MemeSample[] {
  // Для эффективности: строим в один проход мапу phrase -> [msg]
  const candSet = new Set(candidates.map((c) => c.phrase));
  const bucket = new Map<string, TgMessage[]>();
  for (const ph of candSet) bucket.set(ph, []);

  for (const m of allMessages) {
    if (m.type !== "message") continue;
    const text = extractPlainText(m).toLowerCase();
    if (!text) continue;
    // Дешёвый отбор: по простому includes для каждой фразы.
    // Для 40 фраз × 126K сообщений это ~5M операций includes, ок.
    for (const ph of candSet) {
      if (text.includes(ph)) {
        const arr = bucket.get(ph)!;
        if (arr.length < 200) arr.push(m);
      }
    }
  }

  const out: MemeSample[] = [];
  for (const cand of candidates) {
    const list = bucket.get(cand.phrase) ?? [];
    if (list.length === 0) continue;
    // Берём микс: 4 топовых по реакциям + 4 случайных
    const top = [...list].sort((x, y) => totalReactions(y) - totalReactions(x)).slice(0, 4);
    const rest = pickRandom(list, MEME_SAMPLES_PER);
    const picked = dedupeById([...top, ...rest]).slice(0, MEME_SAMPLES_PER);
    picked.sort((x, y) => (x.date < y.date ? -1 : 1));
    const examples = picked.map((m) => ({
      id: m.id,
      date: m.date,
      alias: resolveAlias(m.from_id ?? "") ?? "?",
      text: truncate(extractPlainText(m), 260),
      reactions: totalReactions(m),
    }));
    out.push({
      phrase: cand.phrase,
      total_count: cand.count,
      unique_authors: cand.authors,
      examples,
    });
  }
  return out;
}

function buildEventSamples(
  peaks: TimelineStats["peaks"],
  quotes: readonly QuoteRef[],
  resolveAlias: (id: string) => string | undefined,
): EventSample[] {
  const out: EventSample[] = [];
  for (const p of peaks) {
    const slice = quotes
      .filter((q) => q.date.slice(0, 10) === p.day)
      .sort((a, b) => b.total_reactions - a.total_reactions)
      .slice(0, EVENT_SAMPLES_PER)
      .map((q) => ({
        id: q.message_id,
        alias: resolveAlias(q.from_id) ?? q.display_name ?? "?",
        text: q.text,
        reactions: q.total_reactions,
        reactions_breakdown: q.reactions_breakdown,
      }));
    out.push({ day: p.day, messages: p.messages, top_quotes: slice });
  }
  return out;
}

function resolveReplyContext(
  m: TgMessage,
  msgById: Map<number, TgMessage>,
  resolveAlias: (id: string) => string | undefined,
): AuthorSample["samples"][number]["reply_to"] | undefined {
  if (m.reply_to_message_id === undefined) return undefined;
  const target = msgById.get(m.reply_to_message_id);
  if (!target) return undefined;
  const text = extractPlainText(target);
  if (!text) return undefined;
  return {
    alias: resolveAlias(target.from_id ?? "") ?? "?",
    text: truncate(text, 160),
  };
}

// ----------------- helpers -----------------

function buildAliasResolver(aliasMap: AliasMap): (id: string) => string | undefined {
  return (id: string) => {
    const e = aliasMap[id];
    if (!e) return undefined;
    if (e.exclude) return "anon";
    return e.alias || undefined;
  };
}

function pickRandom<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const out: T[] = [];
  const used = new Set<number>();
  while (out.length < n && used.size < arr.length) {
    const i = Math.floor(Math.random() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]!);
  }
  return out;
}

function dedupeById(arr: readonly TgMessage[]): TgMessage[] {
  const seen = new Set<number>();
  const out: TgMessage[] = [];
  for (const m of arr) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Не найден ${path}. Сначала запусти шаг 1.`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function ensurePrereqs(): void {
  if (!existsSync(PATHS.statsDir)) {
    throw new Error(`Не найдена папка ${PATHS.statsDir}. Запусти сначала npm run analysis:stats.`);
  }
  if (!existsSync(PATHS.aliasMap)) {
    throw new Error(`Не найден ${PATHS.aliasMap}. Запусти сначала npm run analysis:stats.`);
  }
  if (!existsSync(PATHS.rawExport)) {
    throw new Error(`Не найден ${PATHS.rawExport}. Положи result.json в корень репо.`);
  }
}

main().catch((err) => {
  console.error("[samples] ошибка:", err);
  process.exit(1);
});
