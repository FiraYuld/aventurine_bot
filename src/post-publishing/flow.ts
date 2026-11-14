import { InlineKeyboard } from "grammy";
import {
  buildPostKeyboard,
  isHttpUrl,
  parsePostLink,
  type PostDraft,
  type PostRef,
} from "./draft.js";
import type { PostDraftStore } from "./store.js";

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface ActorInput {
  userId: number;
  chatId: number;
  chatType: ChatType;
}

export interface MessageInput extends ActorInput {
  messageId: number;
  text?: string;
  /** Set when the message is a forward of a channel post (forward_origin.type === "channel"). */
  forwardedFrom?: PostRef;
  /** Message is forwarded, but not from a channel (user, hidden user, group). */
  forwardedFromNonChannel?: boolean;
  /** Message belongs to an album (media group). */
  mediaGroup?: boolean;
}

export interface CallbackInput extends ActorInput {
  data: string;
  callbackQueryId?: string;
}

export interface PostPublishingApi {
  getChannelTitle(channelId: number): Promise<string>;
  /** Resolves a public channel @username to its numeric chat id. */
  resolveChannelId(username: string): Promise<number>;
  sendText(chatId: number, text: string, options?: { replyMarkup?: unknown }): Promise<void>;
  /** Copies the channel post into `toChatId` (used for the preview in the owner DM). */
  copyPost(
    fromChatId: number,
    messageId: number,
    toChatId: number,
    options?: { replyMarkup?: unknown },
  ): Promise<void>;
  /** Replaces the inline keyboard of an existing channel post; caption and entities stay intact. */
  attachButtons(channelId: number, messageId: number, replyMarkup: unknown): Promise<void>;
  answerCallback(callbackQueryId: string): Promise<void>;
}

const ASK_POST_TEXT =
  "Опубликуйте пост в канале сами (так сохранятся премиум-эмодзи), затем перешлите его сюда " +
  "или пришлите ссылку на него (ПКМ / долгое нажатие на пост → «Копировать ссылку»).";

function isAuthorized(input: ActorInput, ownerId: number): boolean {
  return input.userId === ownerId && input.chatType === "private" && input.chatId === ownerId;
}

export class PostPublishingFlow {
  constructor(
    private readonly deps: {
      ownerId: number;
      channelIds: readonly number[];
      store: PostDraftStore;
      api: PostPublishingApi;
    },
  ) {
    if (deps.channelIds.length === 0) {
      throw new Error("PostPublishingFlow requires at least one channelId");
    }
  }

  private get ownerId(): number {
    return this.deps.ownerId;
  }

  private get store(): PostDraftStore {
    return this.deps.store;
  }

  private get api(): PostPublishingApi {
    return this.deps.api;
  }

  private isAllowedChannel(channelId: number): boolean {
    return this.deps.channelIds.includes(channelId);
  }

  private async channelTitle(channelId: number): Promise<string> {
    try {
      return await this.api.getChannelTitle(channelId);
    } catch {
      return String(channelId);
    }
  }

  async start(input: ActorInput): Promise<void> {
    if (!isAuthorized(input, this.ownerId)) return;

    await this.store.set(this.ownerId, { step: "await_post", buttons: [] });
    await this.api.sendText(this.ownerId, ASK_POST_TEXT);
  }

  async cancel(input: ActorInput): Promise<boolean> {
    if (!isAuthorized(input, this.ownerId)) return false;

    const draft = await this.store.get(this.ownerId);
    if (!draft) return false;

    await this.store.delete(this.ownerId);
    return true;
  }

  async handleMessage(input: MessageInput): Promise<boolean> {
    if (!isAuthorized(input, this.ownerId)) return false;

    const draft = await this.store.get(this.ownerId);
    if (!draft) return false;

    switch (draft.step) {
      case "await_post":
        return this.handlePostReference(draft, input);

      case "await_button_text": {
        const text = input.text?.trim();
        if (!text) return true;

        await this.store.set(this.ownerId, {
          ...draft,
          step: "await_button_url",
          pendingButtonText: text,
        });
        await this.api.sendText(this.ownerId, "Введите URL кнопки (http или https):");
        return true;
      }

      case "await_button_url": {
        const url = input.text?.trim();
        if (!url) return true;

        if (!isHttpUrl(url)) {
          await this.api.sendText(
            this.ownerId,
            "URL должен начинаться с http:// или https://.",
          );
          return true;
        }

        await this.store.set(this.ownerId, {
          ...draft,
          step: "choose_next",
          pendingButtonText: undefined,
          buttons: [...draft.buttons, { text: draft.pendingButtonText!, url }],
        });
        await this.sendChooseNextPrompt();
        return true;
      }

      default:
        return false;
    }
  }

  private async handlePostReference(draft: PostDraft, input: MessageInput): Promise<boolean> {
    if (input.mediaGroup) {
      await this.api.sendText(
        this.ownerId,
        "К альбому нельзя прикрепить кнопки — это ограничение Telegram. Нужен пост из одного фото или текста.",
      );
      return true;
    }

    let ref: PostRef | null = input.forwardedFrom ?? null;

    if (!ref && input.forwardedFromNonChannel) {
      await this.api.sendText(this.ownerId, "Это пересылка не из канала. " + ASK_POST_TEXT);
      return true;
    }

    if (!ref && input.text) {
      const link = parsePostLink(input.text);
      if (link?.kind === "private") {
        ref = { channelId: link.channelId, messageId: link.messageId };
      } else if (link?.kind === "public") {
        try {
          ref = {
            channelId: await this.api.resolveChannelId(link.username),
            messageId: link.messageId,
          };
        } catch {
          await this.api.sendText(this.ownerId, `Не удалось найти канал @${link.username}.`);
          return true;
        }
      }
    }

    if (!ref) {
      await this.api.sendText(this.ownerId, ASK_POST_TEXT);
      return true;
    }

    if (!this.isAllowedChannel(ref.channelId)) {
      await this.api.sendText(
        this.ownerId,
        "Этот канал не подключён к публикации. Перешлите пост из канала, где бот — администратор.",
      );
      return true;
    }

    await this.store.set(this.ownerId, {
      ...draft,
      step: "await_button_text",
      channelId: ref.channelId,
      messageId: ref.messageId,
    });
    const title = await this.channelTitle(ref.channelId);
    await this.api.sendText(
      this.ownerId,
      `Пост из «${title}» принят. Введите текст первой кнопки:`,
    );
    return true;
  }

  async handleCallback(input: CallbackInput): Promise<boolean> {
    if (!isAuthorized(input, this.ownerId)) return false;

    if (input.data.startsWith("post:") && input.callbackQueryId) {
      await this.api.answerCallback(input.callbackQueryId);
    }

    const draft = await this.store.get(this.ownerId);
    if (!draft) {
      if (input.data === "post:publish") {
        await this.api.sendText(this.ownerId, "Сценарий публикации уже завершён.");
      }
      return false;
    }

    switch (input.data) {
      case "post:add":
        if (draft.step !== "choose_next") return false;
        await this.store.set(this.ownerId, { ...draft, step: "await_button_text" });
        await this.api.sendText(this.ownerId, "Введите текст кнопки:");
        return true;

      case "post:done":
        if (draft.step !== "choose_next") return false;
        return this.showPreview(draft);

      case "post:publish":
        if (draft.step !== "preview") return false;
        return this.publish(draft);

      case "post:cancel":
        await this.store.delete(this.ownerId);
        await this.api.sendText(this.ownerId, "Публикация отменена.");
        return true;

      default:
        return false;
    }
  }

  private async sendChooseNextPrompt(): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("Добавить ещё", "post:add")
      .text("Готово", "post:done");
    await this.api.sendText(this.ownerId, "Добавить ещё кнопку или завершить?", {
      replyMarkup: keyboard,
    });
  }

  private async showPreview(draft: PostDraft): Promise<boolean> {
    if (draft.channelId === undefined || draft.messageId === undefined || draft.buttons.length === 0) {
      return false;
    }

    const replyMarkup = buildPostKeyboard(draft.buttons).build();
    let previewShown = true;
    try {
      await this.api.copyPost(draft.channelId, draft.messageId, this.ownerId, { replyMarkup });
    } catch {
      // e.g. the channel restricts saving content: still allow attaching the buttons
      previewShown = false;
    }

    const title = await this.channelTitle(draft.channelId);
    const buttonsList = draft.buttons.map((b) => `• ${b.text} — ${b.url}`).join("\n");
    const text = previewShown
      ? `Так будет выглядеть пост в «${title}». Добавить кнопки?`
      : `Превью недоступно, но кнопки можно прикрепить к посту в «${title}»:\n${buttonsList}`;

    const controlKeyboard = new InlineKeyboard()
      .text("Опубликовать", "post:publish")
      .text("Отмена", "post:cancel");
    await this.api.sendText(this.ownerId, text, { replyMarkup: controlKeyboard });

    await this.store.set(this.ownerId, { ...draft, step: "preview" });
    return true;
  }

  private async publish(draft: PostDraft): Promise<boolean> {
    if (draft.channelId === undefined || draft.messageId === undefined) {
      return false;
    }

    const replyMarkup = buildPostKeyboard(draft.buttons).build();
    try {
      await this.api.attachButtons(draft.channelId, draft.messageId, replyMarkup);
    } catch {
      await this.api.sendText(
        this.ownerId,
        "Не удалось добавить кнопки. Проверьте, что пост не удалён и у бота есть право редактировать сообщения в канале.",
      );
      return false;
    }

    await this.store.delete(this.ownerId);
    await this.api.sendText(this.ownerId, "Кнопки добавлены к посту.");
    return true;
  }
}
