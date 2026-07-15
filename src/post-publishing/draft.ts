import { InlineKeyboard } from "grammy";

export const DRAFT_TTL_SECONDS = 24 * 60 * 60;

export type PostDraftStep =
  | "select_channel"
  | "await_post"
  | "await_button_text"
  | "await_button_url"
  | "choose_next"
  | "preview";

export interface PostButton {
  text: string;
  url: string;
}

export interface PostDraft {
  step: PostDraftStep;
  channelId: number;
  sourceChatId?: number;
  sourceMessageId?: number;
  pendingButtonText?: string;
  buttons: PostButton[];
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

export function buildPostKeyboard(buttons: readonly PostButton[]): BuildableInlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.url(button.text, button.url).row();
  keyboard.inline_keyboard.pop();
  return Object.assign(keyboard, {
    build: () => ({ inline_keyboard: keyboard.inline_keyboard }),
  });
}
