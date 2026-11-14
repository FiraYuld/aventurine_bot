import { InlineKeyboard } from "grammy";

export const DRAFT_TTL_SECONDS = 24 * 60 * 60;

export const POST_DRAFT_STEPS = [
  "await_post",
  "await_button_text",
  "await_button_url",
  "choose_next",
  "preview",
] as const;

export type PostDraftStep = (typeof POST_DRAFT_STEPS)[number];

export interface PostButton {
  text: string;
  url: string;
}

/**
 * Draft of "attach URL buttons to an existing channel post".
 * The owner publishes the post themselves (so Premium custom emoji survive) and the bot
 * only edits the reply markup of that post.
 */
export interface PostDraft {
  step: PostDraftStep;
  /** Channel that holds the target post. */
  channelId?: number;
  /** message_id of the target post inside `channelId`. */
  messageId?: number;
  pendingButtonText?: string;
  buttons: PostButton[];
}

export interface PostRef {
  channelId: number;
  messageId: number;
}

type BuildableInlineKeyboard = InlineKeyboard & {
  build(): { inline_keyboard: InlineKeyboard["inline_keyboard"] };
};

export function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export type ParsedPostLink =
  | { kind: "private"; channelId: number; messageId: number }
  | { kind: "public"; username: string; messageId: number };

/**
 * Parses a Telegram post link:
 * - private channel: https://t.me/c/3908886812/2  -> chat id -1003908886812
 * - public channel:  https://t.me/some_channel/15
 * Scheme is optional; query/fragment (e.g. ?single) is ignored.
 */
export function parsePostLink(value: string): ParsedPostLink | null {
  const raw = value.trim();
  const m = raw.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(c\/(\d+)|([A-Za-z][A-Za-z0-9_]{3,31}))\/(\d+)\/?(?:[?#].*)?$/,
  );
  if (!m) return null;
  const messageId = Number(m[4]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  if (m[2]) {
    const channelId = Number(`-100${m[2]}`);
    if (!Number.isSafeInteger(channelId)) return null;
    return { kind: "private", channelId, messageId };
  }
  return { kind: "public", username: m[3]!, messageId };
}

export function buildPostKeyboard(buttons: readonly PostButton[]): BuildableInlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.url(button.text, button.url).row();
  keyboard.inline_keyboard.pop();
  return Object.assign(keyboard, {
    build: () => ({ inline_keyboard: keyboard.inline_keyboard }),
  });
}
