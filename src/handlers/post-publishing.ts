import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { config } from "../config.js";
import {
  PostPublishingFlow,
  type ActorInput,
  type CallbackInput,
  type MessageInput,
  type PostPublishingApi,
} from "../post-publishing/flow.js";
import { RedisPostDraftStore } from "../post-publishing/store.js";

function actorFromCtx(ctx: Context): ActorInput | null {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return null;

  return {
    userId: from.id,
    chatId: chat.id,
    chatType: chat.type,
  };
}

function createApi(bot: Bot): PostPublishingApi {
  return {
    async getChannelTitle(channelId: number): Promise<string> {
      const chat = await bot.api.getChat(channelId);
      if ("title" in chat && chat.title) return chat.title;
      return String(channelId);
    },

    async sendText(
      chatId: number,
      text: string,
      options?: { replyMarkup?: unknown },
    ): Promise<void> {
      await bot.api.sendMessage(chatId, text, {
        reply_markup: options?.replyMarkup as InlineKeyboardMarkup | undefined,
      });
    },

    async copyPost(
      fromChatId: number,
      messageId: number,
      toChatId: number,
      options?: { replyMarkup?: unknown },
    ): Promise<void> {
      await bot.api.copyMessage(toChatId, fromChatId, messageId, {
        reply_markup: options?.replyMarkup as InlineKeyboardMarkup | undefined,
      });
    },

    async answerCallback(callbackQueryId: string): Promise<void> {
      await bot.api.answerCallbackQuery(callbackQueryId);
    },
  };
}

export function registerPostPublishing(bot: Bot): void {
  const store = new RedisPostDraftStore();
  const flow = new PostPublishingFlow({
    ownerId: config.adminLogChatId,
    channelId: config.channelId,
    store,
    api: createApi(bot),
  });

  bot.command("post", async (ctx) => {
    const actor = actorFromCtx(ctx);
    if (!actor) return;
    await flow.start(actor);
  });

  bot.command("cancel", async (ctx) => {
    const actor = actorFromCtx(ctx);
    if (!actor) return;
    const cancelled = await flow.cancel(actor);
    if (cancelled) {
      await ctx.reply("Публикация отменена.");
    }
  });

  bot.callbackQuery(/^post:/, async (ctx) => {
    const actor = actorFromCtx(ctx);
    if (!actor) return;

    const input: CallbackInput = {
      ...actor,
      data: ctx.callbackQuery.data,
      callbackQueryId: ctx.callbackQuery.id,
    };
    await flow.handleCallback(input);
  });

  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    const actor = actorFromCtx(ctx);
    if (!msg || !actor) {
      await next();
      return;
    }

    const input: MessageInput = {
      ...actor,
      messageId: msg.message_id,
      photo: Boolean(msg.photo) && !msg.media_group_id,
      caption: msg.caption,
      text: msg.text,
    };

    const consumed = await flow.handleMessage(input);
    if (!consumed) {
      await next();
    }
  });
}
