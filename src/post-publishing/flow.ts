import { InlineKeyboard } from "grammy";
import { buildPostKeyboard, isHttpUrl, type PostDraft } from "./draft.js";
import type { PostDraftStore } from "./store.js";

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface ActorInput {
  userId: number;
  chatId: number;
  chatType: ChatType;
}

export interface MessageInput extends ActorInput {
  messageId: number;
  photo?: boolean;
  caption?: string;
  text?: string;
}

export interface CallbackInput extends ActorInput {
  data: string;
  callbackQueryId?: string;
}

export interface PostPublishingApi {
  getChannelTitle(channelId: number): Promise<string>;
  sendText(chatId: number, text: string, options?: { replyMarkup?: unknown }): Promise<void>;
  copyPost(
    fromChatId: number,
    messageId: number,
    toChatId: number,
    options?: { replyMarkup?: unknown },
  ): Promise<void>;
  answerCallback(callbackQueryId: string): Promise<void>;
}

function isAuthorized(input: ActorInput, ownerId: number): boolean {
  return input.userId === ownerId && input.chatType === "private" && input.chatId === ownerId;
}

function parseChannelCallback(data: string): number | null {
  const prefix = "post:channel:";
  if (!data.startsWith(prefix)) return null;
  const raw = data.slice(prefix.length);
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || String(id) !== raw) return null;
  return id;
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

  private get channelIds(): readonly number[] {
    return this.deps.channelIds;
  }

  private get store(): PostDraftStore {
    return this.deps.store;
  }

  private get api(): PostPublishingApi {
    return this.deps.api;
  }

  private isAllowedChannel(channelId: number): boolean {
    return this.channelIds.includes(channelId);
  }

  async start(input: ActorInput): Promise<void> {
    if (!isAuthorized(input, this.ownerId)) return;

    await this.store.delete(this.ownerId);

    const channels: { id: number; title: string }[] = [];
    for (const channelId of this.channelIds) {
      try {
        channels.push({
          id: channelId,
          title: await this.api.getChannelTitle(channelId),
        });
      } catch {
        // skip unavailable channel; fail below if none remain
      }
    }

    if (channels.length === 0) {
      await this.api.sendText(
        this.ownerId,
        "Не удалось получить данные канала. Попробуйте позже.",
      );
      return;
    }

    const draft: PostDraft = {
      step: "select_channel",
      channelId: channels[0]!.id,
      buttons: [],
    };
    await this.store.set(this.ownerId, draft);

    const keyboard = new InlineKeyboard();
    for (const channel of channels) {
      keyboard.text(channel.title, `post:channel:${channel.id}`).row();
    }
    keyboard.inline_keyboard.pop();
    await this.api.sendText(this.ownerId, "Выберите канал для публикации:", {
      replyMarkup: keyboard,
    });
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
      case "await_post": {
        if (!input.photo || !input.caption?.trim()) {
          if (input.photo && !input.caption?.trim()) {
            await this.api.sendText(this.ownerId, "Пришлите одно фото с непустой подписью.");
          }
          return true;
        }

        await this.store.set(this.ownerId, {
          ...draft,
          step: "await_button_text",
          sourceChatId: input.chatId,
          sourceMessageId: input.messageId,
        });
        await this.api.sendText(this.ownerId, "Введите текст первой кнопки:");
        return true;
      }

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

    const selectedChannelId = parseChannelCallback(input.data);
    if (selectedChannelId !== null) {
      if (draft.step !== "select_channel") return false;
      if (!this.isAllowedChannel(selectedChannelId)) return false;
      await this.store.set(this.ownerId, {
        ...draft,
        step: "await_post",
        channelId: selectedChannelId,
      });
      await this.api.sendText(this.ownerId, "Пришлите одно фото с непустой подписью.");
      return true;
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
    if (
      draft.sourceChatId === undefined ||
      draft.sourceMessageId === undefined ||
      draft.buttons.length === 0
    ) {
      return false;
    }

    const replyMarkup = buildPostKeyboard(draft.buttons).build();
    try {
      await this.api.copyPost(
        draft.sourceChatId,
        draft.sourceMessageId,
        this.ownerId,
        { replyMarkup },
      );
    } catch {
      return false;
    }

    const controlKeyboard = new InlineKeyboard()
      .text("Опубликовать", "post:publish")
      .text("Отмена", "post:cancel");
    await this.api.sendText(this.ownerId, "Проверьте превью и опубликуйте пост:", {
      replyMarkup: controlKeyboard,
    });

    await this.store.set(this.ownerId, { ...draft, step: "preview" });
    return true;
  }

  private async publish(draft: PostDraft): Promise<boolean> {
    if (draft.sourceChatId === undefined || draft.sourceMessageId === undefined) {
      return false;
    }

    const replyMarkup = buildPostKeyboard(draft.buttons).build();
    try {
      await this.api.copyPost(
        draft.sourceChatId,
        draft.sourceMessageId,
        draft.channelId,
        { replyMarkup },
      );
    } catch {
      await this.api.sendText(this.ownerId, "Не удалось опубликовать пост. Попробуйте ещё раз.");
      return false;
    }

    await this.store.delete(this.ownerId);
    await this.api.sendText(this.ownerId, "Пост опубликован.");
    return true;
  }
}
