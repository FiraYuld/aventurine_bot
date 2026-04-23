/**
 * Шаг 1 пайплайна: детерминированная выжимка из `result.json`.
 *
 * Считает статистику по авторам, стикерам, эмодзи, n-граммам, цитатам
 * (top-reacted), reply-графу и таймлайну. Ничего не знает про LLM.
 *
 * Запуск:
 *   npm run analysis:stats
 *
 * Входные данные: `result.json` в корне репо (или RESULT_JSON_PATH).
 * Выход: `tools/chat-analysis/out/stats/*.json` + draft `alias-map.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PATHS } from "./lib/paths.ts";
import {
  extractCustomDocs,
  extractPlainText,
  extractUnicodeEmoji,
  ngrams,
  STOPWORDS,
  tokenize,
  totalReactions,
  truncate,
} from "./lib/text.ts";
import type {
  AliasMap,
  AliasMapEntry,
  AuthorStats,
  EdgesStats,
  PhrasesStats,
  QuoteRef,
  StickersStats,
  TgAnyMessage,
  TgExport,
  TgMessage,
  TimelineStats,
} from "./types.ts";

// --- конфиг скрипта (не из env - тут он не нужен) ---
const TOP_AUTHORS = 60;
const TOP_PHRASES_GLOBAL = 200;
const TOP_PHRASES_PER_AUTHOR = 25;
const TOP_STICKERS = 40;
const TOP_EMOJI = 60;
const TOP_QUOTES = 120;
const TOP_EDGES = 80;
const TIMELINE_PEAKS = 12;
const MIN_AUTHOR_MESSAGES_FOR_STATS = 30;

// ----------------- main -----------------

async function main(): Promise<void> {
  const path = PATHS.rawExport;
  if (!existsSync(path)) {
    throw new Error(
      `result.json не найден: ${path}\n` +
        `Положи экспорт в корень репо или задай RESULT_JSON_PATH.`,
    );
  }

  console.info(`[stats] читаем ${path} (большой файл, несколько секунд)…`);
  const t0 = Date.now();
  const raw = readFileSync(path, "utf8");
  console.info(`[stats] прочитано ${(raw.length / 1_048_576).toFixed(1)}MB за ${Date.now() - t0}мс, парсим JSON…`);

  const t1 = Date.now();
  const data = JSON.parse(raw) as TgExport;
  console.info(`[stats] распарсили, сообщений: ${data.messages.length}, ${Date.now() - t1}мс`);

  mkdirSync(PATHS.statsDir, { recursive: true });

  const acc = buildAccumulators();

  // Первый проход: индекс message_id -> from_id для reply-графа.
  const msgIdToAuthor = new Map<number, string>();
  for (const m of data.messages) {
    if (m.type === "message" && typeof m.id === "number" && typeof m.from_id === "string") {
      msgIdToAuthor.set(m.id, m.from_id);
    }
  }

  // Основной проход.
  let processed = 0;
  for (const m of data.messages) {
    if (m.type !== "message") continue;
    processAuthor(acc, m, msgIdToAuthor);
    processGlobals(acc, m);
    processed++;
  }
  console.info(`[stats] обработано сообщений: ${processed}`);

  const statsByAuthor = finalizeAuthors(acc);
  const statsStickers = finalizeStickers(acc);
  const statsPhrases = finalizePhrases(acc);
  const statsQuotes = finalizeQuotes(acc);
  const statsEdges = finalizeEdges(acc);
  const statsTimeline = finalizeTimeline(acc);

  writeJson(resolve(PATHS.statsDir, "authors.json"), statsByAuthor);
  writeJson(resolve(PATHS.statsDir, "stickers.json"), statsStickers);
  writeJson(resolve(PATHS.statsDir, "phrases.json"), statsPhrases);
  writeJson(resolve(PATHS.statsDir, "quotes.json"), statsQuotes);
  writeJson(resolve(PATHS.statsDir, "edges.json"), statsEdges);
  writeJson(resolve(PATHS.statsDir, "timeline.json"), statsTimeline);

  // Draft alias-map: пишем ТОЛЬКО если файла ещё нет, чтобы не затирать ручные правки.
  if (!existsSync(PATHS.aliasMap)) {
    const aliasMap = buildDraftAliasMap(statsByAuthor);
    writeJson(PATHS.aliasMap, aliasMap);
    console.info(`[stats] создан draft alias-map: ${PATHS.aliasMap}`);
  } else {
    console.info(`[stats] alias-map уже существует, не трогаем: ${PATHS.aliasMap}`);
  }

  printSummary(statsByAuthor, statsStickers, statsPhrases, statsQuotes);
}

// ----------------- accumulators -----------------

interface Accumulators {
  /** from_id -> raw accumulator */
  authors: Map<string, RawAuthor>;
  /** customEmoji/sticker document_id -> count */
  customDocs: Map<string, number>;
  /** customEmoji/sticker document_id -> set of sender from_ids */
  customDocSenders: Map<string, Set<string>>;
  /** emoji из реакций */
  reactionEmoji: Map<string, number>;
  /** emoji внутри текста (не из реакций) */
  textEmoji: Map<string, number>;
  /** глобальные n-граммы: phrase -> count */
  globalPhrases: Map<string, number>;
  /** globalPhrases: phrase -> set<from_id> (сколько разных людей это говорят) */
  globalPhraseAuthors: Map<string, Set<string>>;
  /** цитаты */
  quotes: QuoteRef[];
  /** reply-пары (from_id::to_from_id) -> count */
  edgePairs: Map<string, number>;
  /** день YYYY-MM-DD -> count */
  byDay: Map<string, number>;
  /** hour 0..23 -> count */
  byHour: Map<number, number>;
}

interface RawAuthor {
  from_id: string;
  display_names: Map<string, number>;
  messages: number;
  words: number;
  chars: number;
  reactions_received: number;
  replies_received: number;
  replies_sent: number;
  stickers_sent: number;
  photos_sent: number;
  first_seen: string;
  last_seen: string;
  /** phrase -> count (считаем только когда сообщение содержит >=4 токенов чтобы шум сократить). */
  phrases: Map<string, number>;
  /** document_id -> count для кастомных стикеров. */
  sticker_docs: Map<string, number>;
}

function buildAccumulators(): Accumulators {
  return {
    authors: new Map(),
    customDocs: new Map(),
    customDocSenders: new Map(),
    reactionEmoji: new Map(),
    textEmoji: new Map(),
    globalPhrases: new Map(),
    globalPhraseAuthors: new Map(),
    quotes: [],
    edgePairs: new Map(),
    byDay: new Map(),
    byHour: new Map(),
  };
}

function getOrInitAuthor(acc: Accumulators, m: TgMessage): RawAuthor | null {
  const id = m.from_id;
  if (!id) return null;
  let a = acc.authors.get(id);
  if (!a) {
    a = {
      from_id: id,
      display_names: new Map(),
      messages: 0,
      words: 0,
      chars: 0,
      reactions_received: 0,
      replies_received: 0,
      replies_sent: 0,
      stickers_sent: 0,
      photos_sent: 0,
      first_seen: m.date,
      last_seen: m.date,
      phrases: new Map(),
      sticker_docs: new Map(),
    };
    acc.authors.set(id, a);
  }
  return a;
}

// ----------------- per-message processing -----------------

function processAuthor(
  acc: Accumulators,
  m: TgMessage,
  msgIdToAuthor: Map<number, string>,
): void {
  const a = getOrInitAuthor(acc, m);
  if (!a) return;

  // Имя
  if (m.from) {
    a.display_names.set(m.from, (a.display_names.get(m.from) ?? 0) + 1);
  }
  a.messages += 1;
  if (m.date < a.first_seen) (a as { first_seen: string }).first_seen = m.date;
  if (m.date > a.last_seen) (a as { last_seen: string }).last_seen = m.date;

  // Текст + n-граммы для автора
  const text = extractPlainText(m);
  if (text) {
    a.chars += text.length;
    const toks = tokenize(text);
    a.words += toks.length;
    if (toks.length >= 4) {
      // 2-, 3-, 4-, 5-граммы для автора
      for (let n = 2; n <= 5; n++) {
        for (const ph of ngrams(toks, n)) {
          a.phrases.set(ph, (a.phrases.get(ph) ?? 0) + 1);
        }
      }
    }
  }

  // Реакции и реплаи
  a.reactions_received += totalReactions(m);
  if (m.reply_to_message_id !== undefined) {
    a.replies_sent += 1;
    const toId = msgIdToAuthor.get(m.reply_to_message_id);
    if (toId && toId !== m.from_id) {
      // edge: кто-кому
      const key = `${m.from_id}\u0000${toId}`;
      acc.edgePairs.set(key, (acc.edgePairs.get(key) ?? 0) + 1);
      // встречная сторона увеличивает replies_received
      const target = acc.authors.get(toId);
      if (target) target.replies_received += 1;
    }
  }

  // Стикеры / фото
  if (m.media_type === "sticker" || typeof m.sticker_emoji === "string") {
    a.stickers_sent += 1;
  }
  if (typeof m.photo === "string") {
    a.photos_sent += 1;
  }

  // Кастом-доки (sticker.webp и пр.) из text_entities
  const docs = extractCustomDocs(m);
  for (const d of docs) {
    a.sticker_docs.set(d, (a.sticker_docs.get(d) ?? 0) + 1);
  }
}

function processGlobals(acc: Accumulators, m: TgMessage): void {
  // Таймлайн
  const day = m.date.slice(0, 10);
  acc.byDay.set(day, (acc.byDay.get(day) ?? 0) + 1);
  const hour = Number(m.date.slice(11, 13));
  if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
    acc.byHour.set(hour, (acc.byHour.get(hour) ?? 0) + 1);
  }

  // Глобальные n-граммы (2-4) с автором как ключом для «сколько людей говорят»
  const text = extractPlainText(m);
  if (text && m.from_id) {
    const toks = tokenize(text);
    if (toks.length >= 3) {
      const seen = new Set<string>();
      for (let n = 2; n <= 4; n++) {
        for (const ph of ngrams(toks, n)) {
          seen.add(ph);
        }
      }
      for (const ph of seen) {
        acc.globalPhrases.set(ph, (acc.globalPhrases.get(ph) ?? 0) + 1);
        let authors = acc.globalPhraseAuthors.get(ph);
        if (!authors) {
          authors = new Set();
          acc.globalPhraseAuthors.set(ph, authors);
        }
        authors.add(m.from_id);
      }
    }

    // Unicode-эмодзи в тексте
    for (const e of extractUnicodeEmoji(text)) {
      acc.textEmoji.set(e, (acc.textEmoji.get(e) ?? 0) + 1);
    }
  }

  // Реакции под сообщением
  if (Array.isArray(m.reactions)) {
    for (const r of m.reactions) {
      if (r.type === "emoji" && typeof r.emoji === "string") {
        acc.reactionEmoji.set(
          r.emoji,
          (acc.reactionEmoji.get(r.emoji) ?? 0) + (r.count ?? 0),
        );
      } else if (r.type === "custom_emoji" && typeof r.document_id === "string") {
        acc.customDocs.set(
          r.document_id,
          (acc.customDocs.get(r.document_id) ?? 0) + (r.count ?? 0),
        );
      }
    }
  }

  // Кастом-доки из text_entities - учитываем и в глобальный топ
  const docs = extractCustomDocs(m);
  for (const d of docs) {
    acc.customDocs.set(d, (acc.customDocs.get(d) ?? 0) + 1);
    let senders = acc.customDocSenders.get(d);
    if (!senders) {
      senders = new Set();
      acc.customDocSenders.set(d, senders);
    }
    if (m.from_id) senders.add(m.from_id);
  }

  // Цитаты: кандидаты с большим числом реакций
  const rsum = totalReactions(m);
  if (rsum >= 10 && m.from_id && typeof m.id === "number") {
    const text2 = extractPlainText(m);
    if (text2.length > 0 && text2.length < 2000) {
      const breakdown: Array<{ key: string; count: number }> = [];
      if (Array.isArray(m.reactions)) {
        for (const r of m.reactions) {
          const key = r.emoji ?? (r.document_id ? `doc:${r.document_id}` : r.type);
          breakdown.push({ key, count: r.count ?? 0 });
        }
      }
      acc.quotes.push({
        message_id: m.id,
        from_id: m.from_id,
        display_name: m.from ?? "",
        date: m.date,
        text: truncate(text2, 500),
        total_reactions: rsum,
        reactions_breakdown: breakdown,
      });
    }
  }
}

// ----------------- finalize -----------------

function finalizeAuthors(acc: Accumulators): AuthorStats[] {
  const out: AuthorStats[] = [];
  for (const a of acc.authors.values()) {
    if (a.messages < MIN_AUTHOR_MESSAGES_FOR_STATS) continue;

    const display_names: Record<string, number> = {};
    for (const [k, v] of sortMapDesc(a.display_names).slice(0, 10)) display_names[k] = v;

    const top_phrases = sortMapDesc(a.phrases)
      .filter(([ph, c]) => c >= 2 && phraseLooksMeaningful(ph))
      .slice(0, TOP_PHRASES_PER_AUTHOR)
      .map(([phrase, count]) => ({ phrase, count }));

    const top_sticker_docs = sortMapDesc(a.sticker_docs)
      .slice(0, 10)
      .map(([doc, count]) => ({ doc, count }));

    out.push({
      from_id: a.from_id,
      display_names,
      messages: a.messages,
      words: a.words,
      chars: a.chars,
      reactions_received: a.reactions_received,
      replies_received: a.replies_received,
      replies_sent: a.replies_sent,
      stickers_sent: a.stickers_sent,
      photos_sent: a.photos_sent,
      first_seen: a.first_seen,
      last_seen: a.last_seen,
      top_phrases,
      top_sticker_docs,
    });
  }

  out.sort((a, b) => b.messages - a.messages);
  return out.slice(0, TOP_AUTHORS);
}

function finalizeStickers(acc: Accumulators): StickersStats {
  const top_custom = sortMapDesc(acc.customDocs)
    .slice(0, TOP_STICKERS)
    .map(([doc, count]) => {
      const senders = acc.customDocSenders.get(doc) ?? new Set();
      return {
        doc,
        count,
        sample_senders: Array.from(senders).slice(0, 5),
      };
    });
  const top_reaction_emoji = sortMapDesc(acc.reactionEmoji)
    .slice(0, TOP_EMOJI)
    .map(([emoji, count]) => ({ emoji, count }));
  const top_text_emoji = sortMapDesc(acc.textEmoji)
    .slice(0, TOP_EMOJI)
    .map(([emoji, count]) => ({ emoji, count }));
  return { top_custom, top_reaction_emoji, top_text_emoji };
}

function finalizePhrases(acc: Accumulators): PhrasesStats {
  const scored: Array<{ phrase: string; count: number; authors: number }> = [];
  for (const [phrase, count] of acc.globalPhrases) {
    if (count < 5) continue;
    if (!phraseLooksMeaningful(phrase)) continue;
    const authors = (acc.globalPhraseAuthors.get(phrase) ?? new Set()).size;
    if (authors < 2) continue;
    scored.push({ phrase, count, authors });
  }
  // Сортировка: сильнее вес тем, где много разных авторов (чат-вайд), но и частота
  // имеет значение. Простая метрика: authors * log2(count).
  scored.sort((a, b) => {
    const sa = a.authors * Math.log2(a.count + 1);
    const sb = b.authors * Math.log2(b.count + 1);
    return sb - sa;
  });
  return { ngrams: scored.slice(0, TOP_PHRASES_GLOBAL) };
}

function finalizeQuotes(acc: Accumulators): QuoteRef[] {
  acc.quotes.sort((a, b) => b.total_reactions - a.total_reactions);
  return acc.quotes.slice(0, TOP_QUOTES);
}

function finalizeEdges(acc: Accumulators): EdgesStats {
  const pairs = Array.from(acc.edgePairs.entries())
    .map(([key, count]) => {
      const [from_id, to_id] = key.split("\u0000");
      return { from_id: from_id ?? "", to_id: to_id ?? "", count };
    })
    .filter((p) => p.from_id && p.to_id && p.count >= 3);
  pairs.sort((a, b) => b.count - a.count);
  return { top_pairs: pairs.slice(0, TOP_EDGES) };
}

function finalizeTimeline(acc: Accumulators): TimelineStats {
  const by_day = Array.from(acc.byDay.entries())
    .map(([day, messages]) => ({ day, messages }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const by_hour = Array.from(acc.byHour.entries())
    .map(([hour, messages]) => ({ hour, messages }))
    .sort((a, b) => a.hour - b.hour);

  const peaksSorted = [...by_day].sort((a, b) => b.messages - a.messages);
  const peaks = peaksSorted.slice(0, TIMELINE_PEAKS).map((p) => ({
    day: p.day,
    messages: p.messages,
    reason_sample: [] as string[],
  }));

  return { by_day, by_hour, peaks };
}

function buildDraftAliasMap(authors: readonly AuthorStats[]): AliasMap {
  const out: AliasMap = {};
  for (const a of authors) {
    const entry: AliasMapEntry = {
      alias: suggestAlias(a),
      candidates: a.display_names,
      note: "Поставь свой alias, или exclude:true чтобы не включать в лор.",
    };
    out[a.from_id] = entry;
  }
  return out;
}

function suggestAlias(a: AuthorStats): string {
  // Берём самый частый display_name, чистим от чат-шуточных хвостов.
  const entries = Object.entries(a.display_names).sort((x, y) => y[1] - x[1]);
  const raw = entries[0]?.[0] ?? a.from_id;
  // Первое слово как эвристика (для «Воронин Вадим Владимирович Ещё раз епт...» -> «Воронин»).
  const first = raw.split(/\s+/)[0] ?? raw;
  // Режем мусорные символы.
  return first.replace(/[^\p{L}\p{N}_-]+/gu, "").slice(0, 24) || raw.slice(0, 24);
}

// ----------------- helpers -----------------

function phraseLooksMeaningful(phrase: string): boolean {
  const parts = phrase.split(" ");
  // Хотя бы половина слов - не стопслова.
  let nonStop = 0;
  for (const p of parts) {
    if (!STOPWORDS.has(p)) nonStop += 1;
  }
  return nonStop * 2 >= parts.length;
}

function sortMapDesc<K>(m: Map<K, number>): Array<[K, number]> {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  console.info(`[stats] записан ${path}`);
}

function printSummary(
  authors: readonly AuthorStats[],
  stickers: StickersStats,
  phrases: PhrasesStats,
  quotes: readonly QuoteRef[],
): void {
  console.info(`\n[stats] === ИТОГО ===`);
  console.info(`  авторов в топе:    ${authors.length}`);
  console.info(`  кастом-стикеров:   ${stickers.top_custom.length}`);
  console.info(`  реакция-эмодзи:    ${stickers.top_reaction_emoji.length}`);
  console.info(`  глоб. n-грамм:     ${phrases.ngrams.length}`);
  console.info(`  цитат (top):       ${quotes.length}`);
  console.info(`\nТоп-5 авторов:`);
  for (const a of authors.slice(0, 5)) {
    const name = Object.keys(a.display_names)[0] ?? a.from_id;
    console.info(`  - ${name} (${a.from_id}): ${a.messages} сообщ, ${a.reactions_received} реакц.`);
  }
  console.info(`\nТоп-5 фраз:`);
  for (const ph of phrases.ngrams.slice(0, 5)) {
    console.info(`  - "${ph.phrase}" x${ph.count} от ${ph.authors} чел.`);
  }
  console.info(
    `\n[stats] Draft alias-map: ${PATHS.aliasMap}\n` +
      `         -> открой и поправь alias/exclude под себя, потом запускай 02-build-samples.`,
  );
}

main().catch((err) => {
  console.error("[stats] ошибка:", err);
  process.exit(1);
});
