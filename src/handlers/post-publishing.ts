import { GrammyError, type Bot, type Context } from "grammy";
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

export function createPostPublishingApi(bot: Bot): PostPublishingApi {
  return {
    async getChannelTitle(channelId: number): Promise<string> {
      const chat = await bot.api.getChat(channelId);
      const title = "title" in chat && chat.title ? chat.title : String(channelId);
      return channelId === config.postTestChannelId ? `🧪 Тест: ${title}` : title;
    },

    async resolveChannelId(username: string): Promise<number> {
      const chat = await bot.api.getChat(`@${username}`);
      return chat.id;
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

    async attachButtons(channelId: number, messageId: number, replyMarkup: unknown): Promise<void> {
      try {
        await bot.api.editMessageReplyMarkup(channelId, messageId, {
          reply_markup: replyMarkup as InlineKeyboardMarkup,
        });
      } catch (err) {
        // Same buttons are already attached: nothing to change, treat as success.
        if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
        console.error("[post] attachButtons failed", {
          channelId,
          messageId,
          error: err instanceof GrammyError ? err.description : String(err),
        });
        throw err;
      }
    },

    async answerCallback(callbackQueryId: string): Promise<void> {
      await bot.api.answerCallbackQuery(callbackQueryId);
    },
  };
}

export function registerPostPublishing(bot: Bot): void {
  const store = new RedisPostDraftStore();
  const channelIds = [
    config.channelId,
    ...(config.postTestChannelId !== undefined ? [config.postTestChannelId] : []),
  ];
  const flow = new PostPublishingFlow({
    ownerId: config.adminLogChatId,
    channelIds,
    store,
    api: createPostPublishingApi(bot),
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

    const origin = msg.forward_origin;
    const input: MessageInput = {
      ...actor,
      messageId: msg.message_id,
      text: msg.text,
      forwardedFrom:
        origin?.type === "channel"
          ? { channelId: origin.chat.id, messageId: origin.message_id }
          : undefined,
      forwardedFromNonChannel: origin !== undefined && origin.type !== "channel",
      mediaGroup: Boolean(msg.media_group_id),
    };

    const consumed = await flow.handleMessage(input);
    if (!consumed) {
      await next();
    }
  });
}
