/**
 * Шаг 4 пайплайна: сворачиваем `out/dossier.json` в `src/chat/chat-lore.ts`.
 *
 * Экспортируем две константы:
 *  - CHAT_LORE_COMPACT - короткая выжимка, которая лезет в system промпт каждый
 *    LLM-вызов (целимся в ≤1500 токенов, ~4-5KB русского текста).
 *  - CHAT_LORE_FULL - полное досье, пока не используется, лежит под будущий RAG
 *    или отладочный /lore.
 *
 * Мемы из dossier в итог НЕ включаем - LLM плохо отделяет реальные мемы
 * от частотных вводных фраз ("мне кажется", "скорее всего"), а мусор в промпте
 * дороже отсутствия мемов. Если захочется добавить мемы - правь руками в
 * chat-lore.ts или добавляй их сюда через отдельный файл.
 *
 * `pinned-personas.json` рядом со скриптом - это ручные «закреплённые»
 * карточки (владелец чата, ключевые люди). Они вмёрживаются в топ списка
 * персонажей и переживают регенерацию. Алиас = ключ дедупликации
 * (если в dossier есть такой же - pinned побеждает).
 *
 * Запуск: npm run analysis:compile
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PATHS } from "./lib/paths.ts";

// --- настройки свёртки ---
const COMPACT_PERSONAS = 20;
const COMPACT_TERMS = 10;
const COMPACT_EVENTS = 6;

// грубая оценка: для русского ~3 символа на токен. 1500 токенов ~= 4500 символов.
const COMPACT_HARD_CHAR_CAP = 5000;

const PINNED_PERSONAS_PATH = resolve(PATHS.toolsRoot, "pinned-personas.json");

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
  /** Оставляем поле опциональным - старые dossier.json могут содержать мемы, игнорируем. */
  memes?: unknown;
  lore: LoreOverview;
}

interface PinnedPersona extends PersonaCard {
  /** Маркер ручной карточки, для отладки и сортировки. */
  pinned?: boolean;
}

async function main(): Promise<void> {
  if (!existsSync(PATHS.dossierJson)) {
    throw new Error(`Не найден ${PATHS.dossierJson}. Запусти npm run analysis:dossier.`);
  }
  const d = JSON.parse(readFileSync(PATHS.dossierJson, "utf8")) as Dossier;
  const pinned = loadPinnedPersonas();
  if (pinned.length > 0) {
    console.info(`[compile] подгружено закреплённых персонажей: ${pinned.length}`);
  }
  const mergedPersonas = mergePersonas(pinned, d.personas);

  const compact = buildCompact(d, mergedPersonas);
  const full = buildFull(d, mergedPersonas);

  const ts = renderLoreModule(compact, full, d);
  writeFileSync(PATHS.loreTs, ts, "utf8");
  console.info(`[compile] записан ${PATHS.loreTs}`);
  console.info(`[compile] CHAT_LORE_COMPACT: ${compact.length} символов (~${Math.round(compact.length / 3)} токенов)`);
  console.info(`[compile] CHAT_LORE_FULL:    ${full.length} символов`);
  if (compact.length > COMPACT_HARD_CHAR_CAP) {
    console.warn(
      `[compile] WARN: COMPACT превысил жёсткий лимит ${COMPACT_HARD_CHAR_CAP} символов. ` +
        `Обрежь COMPACT_PERSONAS в 04-compile-lore.ts.`,
    );
  }
}

function loadPinnedPersonas(): PinnedPersona[] {
  if (!existsSync(PINNED_PERSONAS_PATH)) return [];
  try {
    const raw = readFileSync(PINNED_PERSONAS_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(`[compile] ${PINNED_PERSONAS_PATH} должен быть массивом - игнорирую.`);
      return [];
    }
    const out: PinnedPersona[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== "object") continue;
      const p = e as Partial<PinnedPersona>;
      if (typeof p.alias !== "string" || !p.alias.trim()) continue;
      out.push({
        alias: p.alias.trim(),
        from_id: typeof p.from_id === "string" ? p.from_id : `pinned:${p.alias}`,
        one_liner: typeof p.one_liner === "string" ? p.one_liner : "",
        tone: typeof p.tone === "string" ? p.tone : "",
        recurring_topics: Array.isArray(p.recurring_topics)
          ? p.recurring_topics.filter((s): s is string => typeof s === "string")
          : [],
        signature_phrases: Array.isArray(p.signature_phrases)
          ? p.signature_phrases.filter((s): s is string => typeof s === "string")
          : [],
        relationships: Array.isArray(p.relationships)
          ? p.relationships.filter((s): s is string => typeof s === "string")
          : [],
        notes: typeof p.notes === "string" ? p.notes : "",
        pinned: true,
      });
    }
    return out;
  } catch (err) {
    console.warn(`[compile] не смог прочитать ${PINNED_PERSONAS_PATH}: ${(err as Error).message}`);
    return [];
  }
}

/** Вмёрживает pinned в начало, дедуплицирует по нормализованному алиасу. */
function mergePersonas(pinned: PinnedPersona[], fromDossier: PersonaCard[]): PinnedPersona[] {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
  const pinnedKeys = new Set(pinned.map((p) => norm(p.alias)));
  const filtered = fromDossier.filter((p) => !pinnedKeys.has(norm(p.alias)));
  return [...pinned, ...filtered];
}

// ----------------- компактная выжимка -----------------

function buildCompact(d: Dossier, personas: readonly PinnedPersona[]): string {
  const lines: string[] = [];

  // Общий вайб - одно предложение. Возьмём первую фразу summary и урежем.
  const summary = firstSentence(d.lore.summary, 260);
  if (summary) lines.push(summary);

  // Закреплённые - выводим развёрнуто (pinned обычно про важных людей).
  const pinned = personas.filter((p) => p.pinned);
  if (pinned.length > 0) {
    lines.push("");
    lines.push("Важные люди (знать обязательно):");
    for (const p of pinned) {
      const body = p.one_liner ? `${p.alias}: ${shrink(p.one_liner, 160)}` : p.alias;
      lines.push(`- ${body}`);
      if (p.notes) lines.push(`  ${shrink(p.notes, 240)}`);
    }
  }

  // Остальные завсегдатаи: алиас - one_liner одной строкой.
  const regulars = personas
    .filter((p) => !p.pinned && p.one_liner && p.one_liner.length > 0)
    .slice(0, COMPACT_PERSONAS);
  if (regulars.length > 0) {
    lines.push("");
    lines.push("Завсегдатаи (алиас - в двух словах):");
    for (const p of regulars) {
      lines.push(`- ${p.alias}: ${shrink(p.one_liner, 120)}`);
    }
  }

  // Термины из лора.
  const terms = d.lore.terminology.slice(0, COMPACT_TERMS);
  if (terms.length > 0) {
    lines.push("");
    lines.push("Термины и жаргон чата:");
    for (const t of terms) {
      lines.push(`- ${t.term}: ${shrink(t.meaning, 120)}`);
    }
  }

  // События (коротко).
  const events = d.lore.events.slice(0, COMPACT_EVENTS);
  if (events.length > 0) {
    lines.push("");
    lines.push("Сквозные события:");
    for (const e of events) {
      lines.push(`- ${e.day}: ${shrink(e.what, 160)}`);
    }
  }

  let compact = lines.join("\n").trim();
  // Подстрахуемся: если всё равно длиннее лимита - режем по строкам, оставляя хедер.
  if (compact.length > COMPACT_HARD_CHAR_CAP) {
    compact = compact.slice(0, COMPACT_HARD_CHAR_CAP).replace(/[^.?!]+$/, "").trim() + "…";
  }
  return compact;
}

// ----------------- полная версия (читаемая, для владельца/будущего RAG) -----------------

function buildFull(d: Dossier, personas: readonly PinnedPersona[]): string {
  const lines: string[] = [];
  lines.push(`Чат-лор (${d.generated_at.slice(0, 10)}):`);
  lines.push("");
  lines.push("ОБЗОР:");
  lines.push(d.lore.summary);

  if (d.lore.terminology.length > 0) {
    lines.push("");
    lines.push("ТЕРМИНЫ:");
    for (const t of d.lore.terminology) {
      lines.push(`- ${t.term}: ${t.meaning}`);
    }
  }

  if (d.lore.events.length > 0) {
    lines.push("");
    lines.push("КЛЮЧЕВЫЕ СОБЫТИЯ:");
    for (const e of d.lore.events) {
      lines.push(`- ${e.day}: ${e.what}`);
    }
  }

  lines.push("");
  lines.push("ПЕРСОНАЖИ:");
  for (const p of personas) {
    const head = p.pinned ? `* [PINNED] ${p.alias}` : `* ${p.alias}`;
    lines.push(`${head} - ${p.one_liner}`);
    if (p.tone) lines.push(`    тон: ${p.tone}`);
    if (p.recurring_topics.length > 0)
      lines.push(`    темы: ${p.recurring_topics.join("; ")}`);
    if (p.signature_phrases.length > 0)
      lines.push(`    фразы: ${p.signature_phrases.map((s) => `"${s}"`).join(", ")}`);
    if (p.relationships.length > 0)
      lines.push(`    связи: ${p.relationships.join("; ")}`);
    if (p.notes) lines.push(`    заметка: ${p.notes}`);
  }

  return lines.join("\n").trim();
}

// ----------------- рендер TS-файла -----------------

function renderLoreModule(compact: string, full: string, d: Dossier): string {
  const header = `/**
 * Сгенерировано автоматически скриптом tools/chat-analysis/04-compile-lore.ts
 * на основе \`out/dossier.json\` (модель ${d.provider}/${d.model},
 * ${d.generated_at}).
 *
 * ПРАВИТЬ ВРУЧНУЮ МОЖНО - это обычный текст. Но учти, что следующий запуск
 * \`npm run analysis:compile\` перезапишет файл. Если хочется ручных правок -
 * отредактируй \`out/dossier.json\` и перегенерь, или руками зафиксируй тут и
 * не запускай compile повторно.
 *
 * CHAT_LORE_COMPACT вшит в системный промпт персоны, идёт в каждый LLM-вызов.
 * CHAT_LORE_FULL пока не используется в рантайме - задел под будущий RAG
 * (подгрузку карточек по упоминаниям) или отладочные команды владельцу.
 */
`;

  const compactLit = toTemplateLiteral(compact);
  const fullLit = toTemplateLiteral(full);
  return (
    header +
    "\n" +
    `export const CHAT_LORE_COMPACT = ${compactLit}.trim();\n\n` +
    `export const CHAT_LORE_FULL = ${fullLit}.trim();\n`
  );
}

// ----------------- utils -----------------

function toTemplateLiteral(s: string): string {
  // Экранируем символы, которые ломают template literal: backslash, backtick, ${.
  const escaped = s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return "`\n" + escaped + "\n`";
}

function shrink(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).replace(/[^\p{L}\p{N}]+$/u, "") + "…";
}

function firstSentence(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // Берём первые 2 предложения, если влезает.
  const parts = flat.split(/(?<=[.!?])\s+/);
  let out = parts[0] ?? flat;
  if (parts.length > 1 && (out + " " + parts[1]!).length <= max) {
    out = out + " " + parts[1]!;
  }
  return shrink(out, max);
}

main().catch((err) => {
  console.error("[compile] ошибка:", err);
  process.exit(1);
});
