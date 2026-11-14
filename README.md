# Aventurine Bot

**Open-source Telegram bot for moderating reactions in a channel-linked discussion group** — built for communities that want to keep reactions enabled while fighting spam bots and drive-by reactors who are not subscribed to the channel.

Production stack: **Node.js 20+**, **TypeScript**, **[grammY](https://grammy.dev/)**, **Vercel** serverless webhooks, **Upstash Redis**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4)](https://core.telegram.org/bots/api)

> **Russian documentation:** [docs/README.ru.md](docs/README.ru.md) (full setup guide in Russian).

---

## Why this project exists

Large Telegram channels often face **reaction spam**: bot accounts flood discussion posts with emoji reactions. Disabling reactions entirely hurts legitimate subscribers. This bot offers a middle path:

- Monitor `message_reaction` updates in the linked discussion supergroup
- Flag users who react without being subscribed to the parent channel
- Route decisions to a **moderator inbox** with inline **Ban** / **Keep** buttons
- Auto-ban on repeated strikes within a time window
- Instantly ban obvious bot accounts
- After a ban, optionally **remove all reactions** from that user (Telegram Bot API 10.0 `deleteAllMessageReactions`)

The optional **LLM persona mode** lets the bot reply in-character in the discussion chat (multi-provider: OpenAI, Anthropic, OpenRouter), with per-user daily quotas stored in Redis.

---

## Features

| Area | Capability |
|------|------------|
| **Reaction moderation** | Risk scoring (channel membership, username heuristics, spam nickname patterns) |
| **Human-in-the-loop** | Moderation cards with inline keyboards; stale cards still work after Redis session expiry |
| **Auto-ban** | Configurable strike window (default 3 reactions / 60s) via Redis sessions |
| **Bot accounts** | Immediate ban on bot reactions |
| **Anonymous reactions** | Detect `actor_chat` reactions; ban linked chats except allowlisted channels |
| **Post-ban cleanup** | `deleteAllMessageReactions` after successful chat ban (API 10.0) |
| **Channel allowlist** | Ignore reactions from trusted channels (`/ignore_channel`) |
| **LLM chat mode** | Optional addressed + random replies; Redis rate limits; owner DM without caps |
| **Ops** | Webhook setup endpoint, health check, staging via `BOT_ENV` |

### Telegram API limitation (documented)

Reactions on **channel posts** are not attributed to individual users in the Bot API — only aggregate counts. This bot moderates the **linked discussion group** only. That is a platform constraint, not a bug.

---

## Architecture

```text
Telegram webhook → /api/telegram (grammY)
  ├── scope middleware (discussion chat, moderation chat, owner DM)
  ├── commands (/status, /unban, ignore-list, LLM limits, …)
  ├── message_reaction → risk → ban | moderation card | auto-ban
  ├── callback_query → Ban / Keep (fresh + stale paths)
  └── message:text → optional LLM persona (if LLM_API_KEY set)

Redis (Upstash): reaction mod sessions, leave-alone immunity, LLM quotas
```

---

## Quick start

### Prerequisites

1. Create a bot via [@BotFather](https://t.me/BotFather) — `/setprivacy` → **Disable**, `/setjoingroups` → **Enable**
2. Add the bot as admin in: parent **channel** (ban users), **discussion supergroup** (ban + delete messages + send messages), **moderation supergroup** (send messages + inline buttons)
3. [Upstash Redis](https://upstash.com/) REST credentials (required for strike sessions and auto-ban)
4. Deploy to [Vercel](https://vercel.com/) or run locally with `vercel dev`

### Environment

Copy [`.env.example`](.env.example) to `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret (`openssl rand -hex 32`) |
| `CHANNEL_ID` | Parent channel ID (`-100…`) — moderation + `/post` |
| `POST_TEST_CHANNEL_ID` | Optional test channel for `/post` |
| `CHAT_ID` | Linked discussion supergroup ID |
| `MODERATION_CHAT_ID` | Moderator supergroup for cards and ban logs |
| `ADMIN_LOG_CHAT_ID` | Owner user ID (private commands + error logs) |
| `UPSTASH_REDIS_REST_URL` / `TOKEN` | Upstash REST API |
| `LLM_API_KEY` | Optional — enables persona mode |

### Local development

```bash
npm install
cp .env.example .env   # edit values
npm run typecheck
npm run local          # Vercel dev on :3000
```

Expose webhooks with [ngrok](https://ngrok.com/) and register:

```text
https://<your-tunnel>/api/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

Verify: `GET /api/health` → `bot_env`, `llm_enabled`, env presence flags.

### Production deploy

```bash
vercel link
vercel env add TELEGRAM_BOT_TOKEN production
# … add all variables from .env.example
vercel --prod
```

Then open `https://<your-domain>/api/setup?key=<TELEGRAM_WEBHOOK_SECRET>` once. Confirm `allowed_updates` includes `message_reaction` and `callback_query` (`?action=info`).

---

## Bot commands

| Command | Who | Purpose |
|---------|-----|---------|
| `/start`, `/help`, `/ping`, `/status` | Owner | Health and setup checks |
| `/limits [@user]` | Owner | LLM daily usage (chat + privileged DM counters) |
| `/limits_reset`, `/limits_reset_all` | Owner | Reset LLM quotas |
| `/clear_react_leave <user_id>` | Owner | Clear “Keep” immunity |
| `/ignore_channel`, `/ignore_channel_remove`, `/ignore_channel_list` | Owner | Channel reaction allowlist |
| `/post` | Owner (private DM only) | Attach URL buttons to your own channel post |
| `/cancel` | Owner (private DM only) | Cancel an active post draft |
| `/unban <user_id>` | Owner or channel/discussion admins | Unban in discussion + channel |

### Inline post publishing (`/post`)

Available only to the owner (`ADMIN_LOG_CHAT_ID`) in a **private chat** with the bot. The bot must be a channel admin with permission to **edit messages** in `CHANNEL_ID` and, if set, `POST_TEST_CHANNEL_ID`.

Bots cannot send Premium custom emoji to channels unless they own a Fragment username, so the bot never re-sends the post. You publish it yourself and the bot only attaches the buttons (`editMessageReplyMarkup`), which keeps the caption and its custom emoji intact.

1. Publish the post in the channel from your own account.
2. Send `/post` to the bot, then **forward that post** to it or send its link (`https://t.me/c/…/123`). Albums are not supported (Telegram does not allow buttons on them).
3. Enter button label and URL (`http` or `https`) — repeat for more buttons, or finish.
4. Review the preview (a copy of the post with buttons, sent to your DM).
5. Tap **Publish** to attach the buttons to the channel post, or **Cancel** to discard the draft. Publishing again replaces the post's buttons.

`/cancel` aborts the wizard at any step. A new `/post` replaces an unfinished draft. Drafts expire after 24 hours of inactivity.

---

## Project structure

```text
api/           Vercel serverless routes (telegram webhook, setup, health)
src/
  handlers/    reactions, moderation callbacks, commands
  chat/        optional LLM persona, limits, context buffer
  moderation.ts, post-ban.ts, reaction-mod-session.ts, …
tools/chat-analysis/   offline chat export analysis (optional)
```

---

## Security

- Secrets only in environment variables — never commit `.env`
- `/api/setup` protected by `?key=` matching `TELEGRAM_WEBHOOK_SECRET`
- Telegram webhook header `X-Telegram-Bot-Api-Secret-Token` validated by grammY
- Revoke and rotate `TELEGRAM_BOT_TOKEN` if leaked

---

## Contributing

Issues and pull requests are welcome. Please do not commit tokens or chat IDs from production.

1. Fork the repository
2. Create a branch (`git checkout -b feature/my-change`)
3. Run `npm run typecheck`
4. Open a PR with a clear description

---

## License

[MIT](LICENSE) — Copyright (c) 2026 FiraYuld

---

## Acknowledgments

Built for communities running **channel + discussion group** setups on Telegram. Uses [grammY](https://grammy.dev/) and targets current Bot API features including reaction updates and bulk reaction removal for banned users.
