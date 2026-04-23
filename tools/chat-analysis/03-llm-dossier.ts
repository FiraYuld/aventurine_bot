/**
 * Шаг 3 пайплайна: превращаем выборки из `out/samples/*.json` в читаемое
 * досье через LLM.
 *
 * На выходе:
 *  - `out/dossier.json` - структурированно (для шага 4 компиляции в chat-lore.ts)
 *  - `out/dossier.md`   - человекочитаемо, сюда ты глянешь глазами и поправишь
 *
 * Дешёвая модель по умолчанию (gpt-4o-mini). Переопределить:
 *   ANALYSIS_LLM_MODEL=gpt-4.1-mini npm run analysis:dossier
 *
 * Запуск: npm run analysis:dossier
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PATHS } from "./lib/paths.ts";
import { getCliLlmClient, parallelLimit, parseJsonLoose } from "./lib/llm-cli.ts";

// ----------------- схемы выходного dossier -----------------

interface PersonaCard {
  alias: string;
  from_id: string;
  one_liner: string;
  tone: string;
  recurring_topics: string[];
  signature_phrases: string[];
  relationships: string[];
  notes: string;
}

interface MemeEntry {
  trigger: string;
  meaning: string;
  origin_if_known: string;
  when_appropriate: string;
}

interface LoreOverview {
  summary: string;
  terminology: Array<{ term: string; meaning: string }>;
  events: Array<{ day: string; what: string }>;
}

interface Dossier {
  generated_at: string;
  provider: string;
  model: string;
  personas: PersonaCard[];
  memes: MemeEntry[];
  lore: LoreOverview;
}

// ----------------- входные выборки -----------------

interface AuthorSample {
  alias: string;
  from_id: string;
  stats: Record<string, unknown>;
  top_phrases: Array<{ phrase: string; count: number }>;
  top_sticker_docs: Array<{ doc: string; count: number }>;
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
  examples: Array<{ id: number; date: string; alias: string; text: string; reactions: number }>;
}

interface EventSample {
  day: string;
  messages: number;
  top_quotes: Array<{ id: number; alias: string; text: string; reactions: number }>;
}

// ----------------- промпты -----------------

const PERSONA_SYSTEM = `
Ты - аналитик чата. Твоя задача: по пачке сообщений одного участника
выдать краткое «досье» в JSON строго по схеме. Никаких комментариев вне JSON.
Правила:
- Русский язык, без воды и канцелярита.
- Будь точен: не выдумывай факты, если их нет в выборке. Если нечего сказать - оставь пусто.
- Без «психологических портретов»: опирайся на тон речи и реальные темы.
- Тон пиши как живой человек (напр. «ворчит но по делу», «хамит по-доброму»,
  «всегда в теме HSR», «часто байтит»).
- one_liner = одна фраза-карикатура про человека, как его представил бы друг.
- tone = 3-6 слов про стиль общения.
- recurring_topics = темы, которые этот человек реально обсуждает (2-5 пунктов).
- signature_phrases = его фирменные фразы/словечки из примеров (2-5 шт).
- relationships = с кем часто пересекается/спорит (если видно из reply_to).
- notes = 1-2 предложения, что про него важно знать боту-собеседнику.

Схема JSON:
{
  "one_liner": string,
  "tone": string,
  "recurring_topics": string[],
  "signature_phrases": string[],
  "relationships": string[],
  "notes": string
}
`.trim();

const MEME_SYSTEM = `
Ты - аналитик чата. Тебе дают пачку n-грамм (частых фраз) и примеры
сообщений, где они встречаются. Для КАЖДОЙ фразы реши:
- это реально мем/внутренняя шутка/фирменное словечко? ИЛИ просто частая нейтральная конструкция?
- если мем: кратко объясни смысл и когда уместно подхватывать.
- если НЕ мем (просто стопслова / обычная речь): верни поле "meaning":"".

Отвечай строго JSON-массивом того же порядка, что тебе пришёл список.

Формат каждого элемента:
{
  "trigger": "фраза",
  "meaning": "короткое объяснение или пусто если не мем",
  "origin_if_known": "откуда пошло, если известно",
  "when_appropriate": "в каких ситуациях стоит подхватить, 1 фраза"
}

Русский, кратко, честно. Не выдумывай происхождение.
`.trim();

const LORE_SYSTEM = `
Ты - аналитик чата. На вход дают топ-цитаты (самые реактные сообщения) и
пики активности по дням. Задача: выдать короткий обзор «вайба» чата в JSON.

Схема:
{
  "summary": "абзац-два: про что чат, какой тон, какая основная тематика (игры? HSR? мемы?)",
  "terminology": [{"term": "...", "meaning": "..."}, ...] до 12 пунктов,
  "events": [{"day": "YYYY-MM-DD", "what": "что там произошло по цитатам"}, ...] до 8 пунктов
}

Честно, без воды. Если не уверен - не включай. Русский язык.
`.trim();

// ----------------- main -----------------

async function main(): Promise<void> {
  const client = getCliLlmClient();
  console.info(
    `[dossier] LLM: provider=${client.provider}, model=${client.model}`,
  );

  const authors = readJson<AuthorSample[]>(resolve(PATHS.samplesDir, "authors.json"));
  const memes = readJson<MemeSample[]>(resolve(PATHS.samplesDir, "memes.json"));
  const events = readJson<EventSample[]>(resolve(PATHS.samplesDir, "events.json"));
  const quotes = readJson<Array<{ id: number; alias: string; text: string; reactions: number; date: string }>>(
    resolve(PATHS.samplesDir, "quotes.json"),
  );

  console.info(
    `[dossier] вход: ${authors.length} авторов, ${memes.length} мемов, ${events.length} пиков`,
  );

  // 1) Персонажи - параллельно, ограничение concurrency.
  console.info(`[dossier] генерируем карточки персонажей…`);
  const personas = await parallelLimit(authors, 4, async (a, i) => {
    const t0 = Date.now();
    const card = await buildPersonaCard(client, a);
    console.info(
      `  [${i + 1}/${authors.length}] ${a.alias} (${a.from_id}) - ${Date.now() - t0}мс`,
    );
    return card;
  });

  // 2) Мемы - батчами по 8, чтобы не перегружать контекст.
  console.info(`[dossier] объясняем мемы…`);
  const memeBatches = chunk(memes, 8);
  const memeResults: MemeEntry[] = [];
  for (let i = 0; i < memeBatches.length; i++) {
    const b = memeBatches[i]!;
    const t0 = Date.now();
    const batch = await explainMemeBatch(client, b);
    memeResults.push(...batch);
    console.info(`  [batch ${i + 1}/${memeBatches.length}] ${b.length} мемов - ${Date.now() - t0}мс`);
  }
  // Отфильтруем явные «не-мемы».
  const filteredMemes = memeResults.filter(
    (m) => m && m.trigger && m.meaning && m.meaning.trim().length > 0,
  );

  // 3) Лор - один проход на топ-цитаты + пики.
  console.info(`[dossier] сводим общий лор…`);
  const lore = await buildLore(client, quotes.slice(0, 60), events);

  const dossier: Dossier = {
    generated_at: new Date().toISOString(),
    provider: client.provider,
    model: client.model,
    personas,
    memes: filteredMemes,
    lore,
  };

  writeFileSync(PATHS.dossierJson, JSON.stringify(dossier, null, 2), "utf8");
  writeFileSync(PATHS.dossierMd, renderMarkdown(dossier), "utf8");
  console.info(`\n[dossier] готово:`);
  console.info(`  - ${PATHS.dossierJson}`);
  console.info(`  - ${PATHS.dossierMd}`);
  console.info(`\nДальше: прочитай dossier.md, поправь, потом npm run analysis:compile`);
}

// ----------------- построение карточки -----------------

async function buildPersonaCard(
  client: ReturnType<typeof getCliLlmClient>,
  a: AuthorSample,
): Promise<PersonaCard> {
  const userPayload = renderAuthorPayload(a);
  const raw = await client.chat({
    system: PERSONA_SYSTEM,
    user: userPayload,
    maxTokens: 600,
    json: client.provider !== "anthropic",
  });
  const parsed = parseJsonLoose<Partial<PersonaCard>>(raw);
  if (!parsed) {
    console.warn(`[dossier] не смог распарсить JSON для ${a.alias}: ${raw.slice(0, 200)}`);
  }
  return {
    alias: a.alias,
    from_id: a.from_id,
    one_liner: asString(parsed?.one_liner),
    tone: asString(parsed?.tone),
    recurring_topics: asStringArray(parsed?.recurring_topics),
    signature_phrases: asStringArray(parsed?.signature_phrases),
    relationships: asStringArray(parsed?.relationships),
    notes: asString(parsed?.notes),
  };
}

function renderAuthorPayload(a: AuthorSample): string {
  const lines: string[] = [];
  lines.push(`Алиас: ${a.alias}`);
  lines.push(`Сообщений в чате: ${a.stats.messages ?? "?"}, реакций получено: ${a.stats.reactions_received ?? "?"}.`);
  if (a.top_phrases.length > 0) {
    lines.push(`Любимые фразы (из его сообщений): ${a.top_phrases.slice(0, 10).map((p) => `"${p.phrase}"x${p.count}`).join(", ")}`);
  }
  lines.push(``);
  lines.push(`Примеры сообщений (${a.samples.length}):`);
  for (const s of a.samples) {
    const head = s.reply_to ? ` [в ответ ${s.reply_to.alias}: "${s.reply_to.text}"]` : "";
    lines.push(`- (${s.reactions}react)${head} ${s.text}`);
  }
  lines.push(``);
  lines.push(`Верни ТОЛЬКО JSON по заданной схеме.`);
  return lines.join("\n");
}

// ----------------- мем-батчи -----------------

async function explainMemeBatch(
  client: ReturnType<typeof getCliLlmClient>,
  batch: MemeSample[],
): Promise<MemeEntry[]> {
  const payload = batch
    .map((m, i) => {
      const examples = m.examples
        .slice(0, 6)
        .map((e) => `  * (${e.reactions}react, ${e.alias}) ${e.text}`)
        .join("\n");
      return `[${i + 1}] "${m.phrase}" (всего ${m.total_count}, авторов ${m.unique_authors})\n${examples}`;
    })
    .join("\n\n");

  const raw = await client.chat({
    system: MEME_SYSTEM,
    user:
      `Вот ${batch.length} фраз-кандидатов. Для каждой верни элемент массива JSON.\n\n` +
      payload +
      `\n\nОтветь JSON-массивом длины ${batch.length}.`,
    maxTokens: 1400,
    // Anthropic не любит json_object, но массив ему ок; у OpenAI JSON-режим
    // требует root-object. Поэтому НЕ включаем json=true здесь - парсим вольно.
  });

  // Может прилететь как массив напрямую или обёрнутый в {items:[...]}.
  const parsed =
    parseJsonLoose<MemeEntry[] | { items?: MemeEntry[] }>(raw) ?? [];
  const arr: MemeEntry[] = Array.isArray(parsed) ? parsed : parsed.items ?? [];
  if (arr.length !== batch.length) {
    console.warn(
      `[dossier] мем-батч: ожидал ${batch.length}, получил ${arr.length}. Продолжаем по трendency.`,
    );
  }
  const out: MemeEntry[] = [];
  for (let i = 0; i < batch.length; i++) {
    const p = arr[i] ?? ({} as Partial<MemeEntry>);
    out.push({
      trigger: asString(p?.trigger) || batch[i]!.phrase,
      meaning: asString(p?.meaning),
      origin_if_known: asString(p?.origin_if_known),
      when_appropriate: asString(p?.when_appropriate),
    });
  }
  return out;
}

// ----------------- лор -----------------

async function buildLore(
  client: ReturnType<typeof getCliLlmClient>,
  topQuotes: Array<{ id: number; alias: string; text: string; reactions: number; date: string }>,
  events: EventSample[],
): Promise<LoreOverview> {
  const quotesBlock = topQuotes
    .map((q) => `- [${q.date.slice(0, 10)}] ${q.alias}: ${q.text} (${q.reactions}react)`)
    .join("\n");
  const eventsBlock = events
    .map((e) => {
      const top = e.top_quotes
        .slice(0, 8)
        .map((q) => `    * ${q.alias}: ${q.text} (${q.reactions}r)`)
        .join("\n");
      return `День ${e.day} (${e.messages} сообщений):\n${top}`;
    })
    .join("\n\n");

  const raw = await client.chat({
    system: LORE_SYSTEM,
    user:
      `ТОП-ЦИТАТЫ ЧАТА (по реакциям):\n${quotesBlock}\n\n` +
      `ПИКИ АКТИВНОСТИ:\n${eventsBlock}\n\n` +
      `Верни JSON строго по схеме.`,
    maxTokens: 1200,
    json: client.provider !== "anthropic",
  });
  const parsed = parseJsonLoose<Partial<LoreOverview>>(raw);
  return {
    summary: asString(parsed?.summary),
    terminology: Array.isArray(parsed?.terminology)
      ? parsed.terminology
          .filter((t): t is { term: string; meaning: string } => !!t && typeof t === "object")
          .map((t) => ({ term: asString(t.term), meaning: asString(t.meaning) }))
          .filter((t) => t.term && t.meaning)
      : [],
    events: Array.isArray(parsed?.events)
      ? parsed.events
          .filter((e): e is { day: string; what: string } => !!e && typeof e === "object")
          .map((e) => ({ day: asString(e.day), what: asString(e.what) }))
          .filter((e) => e.day && e.what)
      : [],
  };
}

// ----------------- markdown -----------------

function renderMarkdown(d: Dossier): string {
  const out: string[] = [];
  out.push(`# Досье чата`);
  out.push(``);
  out.push(`Сгенерировано: ${d.generated_at} · модель: ${d.provider}/${d.model}`);
  out.push(``);
  out.push(`## Общий лор`);
  out.push(``);
  out.push(d.lore.summary || "_(пусто)_");
  out.push(``);
  if (d.lore.terminology.length > 0) {
    out.push(`### Термины`);
    for (const t of d.lore.terminology) {
      out.push(`- **${t.term}** - ${t.meaning}`);
    }
    out.push(``);
  }
  if (d.lore.events.length > 0) {
    out.push(`### Ключевые события`);
    for (const e of d.lore.events) {
      out.push(`- **${e.day}** - ${e.what}`);
    }
    out.push(``);
  }

  out.push(`## Персонажи`);
  out.push(``);
  for (const p of d.personas) {
    out.push(`### ${p.alias} \`${p.from_id}\``);
    if (p.one_liner) out.push(`_${p.one_liner}_`);
    if (p.tone) out.push(``);
    if (p.tone) out.push(`**Тон:** ${p.tone}`);
    if (p.recurring_topics.length > 0) out.push(`**Темы:** ${p.recurring_topics.join("; ")}`);
    if (p.signature_phrases.length > 0)
      out.push(`**Фирменные фразы:** ${p.signature_phrases.map((s) => `"${s}"`).join(", ")}`);
    if (p.relationships.length > 0) out.push(`**Связи:** ${p.relationships.join("; ")}`);
    if (p.notes) out.push(`**Заметка:** ${p.notes}`);
    out.push(``);
  }

  out.push(`## Мемы и внутренние шутки`);
  out.push(``);
  for (const m of d.memes) {
    out.push(`- **"${m.trigger}"** - ${m.meaning}${m.origin_if_known ? ` (исток: ${m.origin_if_known})` : ""}${m.when_appropriate ? ` · уместно: ${m.when_appropriate}` : ""}`);
  }
  out.push(``);

  return out.join("\n");
}

// ----------------- helpers -----------------

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
}
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Не найден ${path}. Запусти npm run analysis:samples`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

main().catch((err) => {
  console.error("[dossier] ошибка:", err);
  process.exit(1);
});
