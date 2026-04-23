/**
 * Типы, описывающие формат экспорта Telegram Desktop (`result.json`) и общие
 * структуры артефактов оффлайн-анализа.
 *
 * Telegram-формат недокументирован стабильно, поэтому всё opt и мы защищаемся
 * при парсинге.
 */

export interface TgExport {
  readonly name: string;
  readonly type: string;
  readonly id: number;
  readonly messages: readonly TgAnyMessage[];
}

export type TgAnyMessage = TgMessage | TgService;

export interface TgBase {
  readonly id: number;
  readonly type: "message" | "service";
  readonly date: string;
  readonly date_unixtime?: string;
}

export interface TgMessage extends TgBase {
  readonly type: "message";
  readonly from?: string;
  readonly from_id?: string;
  readonly reply_to_message_id?: number;
  readonly forwarded_from?: string;
  readonly text?: string | readonly TgTextPart[];
  readonly text_entities?: readonly TgTextPart[];
  readonly photo?: string;
  readonly file?: string;
  readonly file_name?: string;
  readonly sticker_emoji?: string;
  readonly media_type?: string;
  readonly reactions?: readonly TgReaction[];
  readonly edited?: string;
}

export interface TgService extends TgBase {
  readonly type: "service";
  readonly action?: string;
  readonly actor?: string;
  readonly actor_id?: string;
}

export type TgTextPart =
  | string
  | {
      readonly type?: string;
      readonly text?: string;
      readonly document_id?: string;
    };

export interface TgReaction {
  readonly type: "emoji" | "custom_emoji" | string;
  readonly count: number;
  readonly emoji?: string;
  readonly document_id?: string;
}

// ---------- stats artefacts ----------

export interface AuthorStats {
  readonly from_id: string;
  /** Все встречавшиеся варианты отображаемого имени в чате. */
  readonly display_names: Record<string, number>;
  readonly messages: number;
  readonly words: number;
  readonly chars: number;
  readonly reactions_received: number;
  readonly replies_received: number;
  readonly replies_sent: number;
  readonly stickers_sent: number;
  readonly photos_sent: number;
  /** ISO-дата первого сообщения. */
  readonly first_seen: string;
  /** ISO-дата последнего сообщения. */
  readonly last_seen: string;
  /** Топ n-грамм (2-5 слов) внутри сообщений этого автора. */
  readonly top_phrases: ReadonlyArray<{ phrase: string; count: number }>;
  /** Топ кастомных стикеров, которые автор шлёт. */
  readonly top_sticker_docs: ReadonlyArray<{ doc: string; count: number }>;
}

export interface StickersStats {
  /** Топ кастом-стикеров (`sticker.webp` → документ) по количеству появлений в чате. */
  readonly top_custom: ReadonlyArray<{ doc: string; count: number; sample_senders: readonly string[] }>;
  /** Топ эмодзи по частоте появления в реакциях. */
  readonly top_reaction_emoji: ReadonlyArray<{ emoji: string; count: number }>;
  /** Топ эмодзи, которые сами пользователи используют в тексте (не в реакциях). */
  readonly top_text_emoji: ReadonlyArray<{ emoji: string; count: number }>;
}

export interface PhrasesStats {
  readonly ngrams: ReadonlyArray<{ phrase: string; count: number; authors: number }>;
}

export interface QuoteRef {
  readonly message_id: number;
  readonly from_id: string;
  readonly display_name: string;
  readonly date: string;
  readonly text: string;
  readonly total_reactions: number;
  readonly reactions_breakdown: ReadonlyArray<{ key: string; count: number }>;
}

export interface EdgesStats {
  readonly top_pairs: ReadonlyArray<{
    from_id: string;
    to_id: string;
    count: number;
  }>;
}

export interface TimelineStats {
  readonly by_day: ReadonlyArray<{ day: string; messages: number }>;
  readonly by_hour: ReadonlyArray<{ hour: number; messages: number }>;
  readonly peaks: ReadonlyArray<{
    day: string;
    messages: number;
    reason_sample: readonly string[];
  }>;
}

export interface AliasMapEntry {
  /** Канонический алиас, как бот будет называть человека в ответах. */
  alias: string;
  /** Ставим true, чтобы исключить автора из лора. */
  exclude?: boolean;
  /** Кандидаты-имена из чата (для подсказки при ручном редактировании). */
  readonly candidates: Record<string, number>;
  /** @username, если встречался (Telegram Desktop export его обычно не включает). */
  username?: string;
  /** Комментарий-подсказка для тебя при редактировании. */
  note?: string;
}

export type AliasMap = Record<string, AliasMapEntry>;
