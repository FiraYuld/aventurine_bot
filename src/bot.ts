import { Bot, GrammyError, HttpError } from "grammy";
import { getConfig } from "./config.js";
import { registerReactionHandler } from "./handlers/reaction.js";
import { registerModerationCallbacks } from "./handlers/moderation-callbacks.js";
import { registerCommands } from "./handlers/commands.js";
import { registerChatHandler } from "./chat/handler.js";
import { scopeMiddleware } from "./middleware/scope.js";

let botInstance: Bot | undefined;

export function getBot(): Bot {
  if (!botInstance) {
    const cfg = getConfig();
    botInstance = new Bot(cfg.botToken);
    console.info(`[bot] init: env=${cfg.botEnv}`);
    botInstance.use(scopeMiddleware);
    // Команды регистрируются ПЕРВЫМИ, чтобы не уходить в LLM-хендлер.
    registerCommands(botInstance);
    registerReactionHandler(botInstance);
    registerModerationCallbacks(botInstance);
    // LLM-режим регистрируется ПОСЛЕ команд: команды типа /ping /status уже
    // отработали и вернули, а оставшиеся message:text попадут сюда.
    registerChatHandler(botInstance);
    botInstance.catch((err) => {
      const ctx = err.ctx;
      console.error(`Ошибка в обновлении ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error("Telegram API:", e.description);
      } else if (e instanceof HttpError) {
        console.error("Сеть:", e);
      } else {
        console.error("Неизвестная ошибка:", e);
      }
    });
  }
  return botInstance;
}

export const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "message_reaction",
  "callback_query",
  "chat_member",
  "my_chat_member",
] as const;
