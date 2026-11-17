# Aventurine Bot

**Open-source Telegram moderation bot for a channel with a linked discussion group** — keeps reactions and comments open while catching spam bots, drive-by reactors who are not subscribed to the channel, and spam accounts that join quietly and post later.

Production stack: **Node.js 20+**, **TypeScript**, **[grammY](https://grammy.dev/)**, **Vercel** serverless webhooks, **Upstash Redis**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4)](https://core.telegram.org/bots/api)

> **Russian documentation:** [docs/README.ru.md](docs/README.ru.md) (full setup guide in Russian).

---

## Why this project exists

Large Telegram channels face two kinds of spam in their discussion group:

- **Reaction spam** — accounts flood posts with emoji reactions without being subscribed. Disabling reactions hurts real subscribers.
- **Sleeper accounts** — accounts join the channel *and* the chat, wait, then start commenting. Their profiles usually carry a linked personal channel (often 18+).

The bot gives moderators a middle path: it watches, scores, and brings decisions to a **moderation chat** with inline buttons. Irreversible actions (deleting someone's messages) always need an explicit tap.

The optional **LLM persona mode** lets the bot reply in character in the discussion chat (OpenAI, Anthropic, OpenRouter), with per-user daily quotas in Redis. It is off when `LLM_API_KEY` is empty.

---

## Features

| Area | Capability |
|------|------------|
| **Reaction moderation** | Risk scoring (channel membership, username heuristics, spam nickname patterns); subscribers cost a single API call |
| **Human-in-the-loop** | Moderation cards with **Ban** / **Keep**; stale cards still work after the Redis session expired |
| **Auto-ban** | 3 suspicious reactions within 60 s → ban (strike session in Redis, serialised per user with a Redis lock) |
| **Channel reactions** | Reactions on behalf of a foreign channel → card with **Ban channel** (`banChatSenderChat` + remove its reactions) / **Keep** (adds to the ignore-list). Own channel, anonymous admins and ignore-listed channels are silent |
| **VPN nicknames** | A user with "vpn"/"впн" in the name or username (V.P.N, В-П-Н, cheap_vpn_bot…) writes in the chat → card **Ban** / **Keep** (Keep = not asked again for 90 days) |
| **Join log** | Every join to the chat or channel → silent entry in the moderation chat: profile link, ID, how they joined, bio, linked personal channel, keyword hints, **Ban** button |
| **After any ban** | Ban by anyone (button, another bot, manual) → bot bans in both chat and channel and removes the "joined the group" message. Messages and reactions are deleted **only** after a separate **🧹** confirmation |
| **Inline post buttons** | `/post` attaches URL buttons to a post you published yourself, so Premium custom emoji survive |
| **LLM chat mode** | Optional addressed + random replies; Redis rate limits; request capped below the webhook budget |
| **Ops** | Webhook setup endpoint, health check, `/status` rights report, staging via `BOT_ENV` |

### Telegram API limitations (documented)

- Reactions on **channel posts** are not attributed to users in the Bot API — only counts. The bot moderates the **linked discussion group**.
- Bots never receive reactions set by **other bots**, and cannot see other bots' messages in groups.
- Bots can't send Premium custom emoji to channels without a Fragment username — hence the `/post` design below.
- Messages can be deleted only within **48 h**, so old "joined the group" messages stay.

---

## Architecture

```text
Telegram webhook → /api/telegram (grammY, 9 s budget)
  ├── scope middleware (discussion chat, moderation chat, owner DM, chat_member of chat/channel)
  ├── commands (/status, /unban, ignore-list, LLM limits, /post, …)
  ├── /post wizard → editMessageReplyMarkup on the owner's channel post
  ├── message_reaction
  │     ├── user    → risk → card | auto-ban          (per-user Redis lock)
  │     └── channel → card Ban channel / Keep
  ├── chat_member
  │     ├── join → join-log entry with 🔨
  │     └── ban by someone else → ban in chat + channel, mark entry, offer 🧹
  ├── callback_query → Ban / Keep, 🔨, 🧹, channel cards, /post buttons
  └── message:text → optional LLM persona (if LLM_API_KEY set)

Redis (Upstash): reaction sessions + locks, leave-alone immunity, ignore-list,
join-log entries, join message ids, post drafts, LLM quotas and context
```

---

## Quick start

### Prerequisites

1. Create a bot via [@BotFather](https://t.me/BotFather) — `/setprivacy` → **Disable**, `/setjoingroups` → **Enable**
2. Add the bot as admin:
   - parent **channel** — ban users, **edit messages** (for `/post`), delete messages
   - **discussion supergroup** — ban users, **delete messages**, send messages
   - **moderation chat** — send messages
   - optional **test channel** for `/post` — edit messages
3. [Upstash Redis](https://upstash.com/) REST credentials
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
| `MODERATION_CHAT_ID` | Moderation chat for cards, join log and ban logs |
| `TOURNAMENT_CHAT_ID` | Optional separate public group: join log + newcomer link guard (delete, mute, card) |
| `ADMIN_LOG_CHAT_ID` | Owner user ID (private commands + error logs) |
| `UPSTASH_REDIS_REST_URL` / `TOKEN` | Upstash REST API |
| `LLM_API_KEY` | Optional — enables persona mode |

> If your Vercel variables are marked *sensitive*, `vercel env pull` writes `[SENSITIVE]` placeholders instead of values; keep a real `.env` elsewhere.

### Local development

```bash
npm install
cp .env.example .env   # edit values
npm run typecheck
npm test
npm run local          # Vercel dev on :3000
```

Expose webhooks with [ngrok](https://ngrok.com/) and register:

```bash
curl -H "Authorization: Bearer $TELEGRAM_WEBHOOK_SECRET" https://<your-tunnel>/api/setup
```

Verify: `GET /api/health` → `bot_env`, `llm_enabled`, env presence flags.

### Production deploy

With the Vercel GitHub integration, merging to `main` deploys production. Without it:

```bash
vercel link
vercel env add TELEGRAM_BOT_TOKEN production
# … add all variables from .env.example
vercel --prod
```

Then register the webhook once (the secret goes in a header, never in the URL):

```bash
curl -H "Authorization: Bearer $TELEGRAM_WEBHOOK_SECRET" https://<your-domain>/api/setup
curl -H "Authorization: Bearer $TELEGRAM_WEBHOOK_SECRET" "https://<your-domain>/api/setup?action=info"
```

Confirm `allowed_updates` includes `message_reaction`, `callback_query` and `chat_member`.

---

## Bot commands

| Command | Who | Purpose |
|---------|-----|---------|
| `/start`, `/help`, `/ping` | Owner | Help and liveness |
| `/status` | Owner | Bot rights per chat: ban, edit messages for `/post` |
| `/limits [@user]` | Owner | LLM daily usage (chat + privileged DM counters) |
| `/limits_reset`, `/limits_reset_all` | Owner | Reset LLM quotas |
| `/clear_react_leave <user_id>` | Owner | Clear “Keep” immunity |
| `/ignore_channel`, `/ignore_channel_remove`, `/ignore_channel_list` | Owner | Channels allowed to react |
| `/post` | Owner (private DM only) | Attach URL buttons to your own channel post |
| `/cancel` | Owner (private DM only) | Cancel an active post draft |
| `/unban <user_id>` | Owner or channel/discussion admins | Unban in discussion + channel |

### Join log and bans

For every join the moderation chat gets a silent entry: name linked to the profile, @username, ID, how they joined (invite link, request, folder), whether they are also in the other place, bio, linked personal channel (title, @username, description) and hints (18+, casino, crypto, dating). Nothing is banned automatically.

When someone is banned in the chat or channel — via **🔨 Забанить**, another bot (e.g. Iris) or by hand — the bot:

1. bans them in both the chat and the channel (reversible by `/unban`),
2. deletes the "… joined the group" service message (if younger than 48 h),
3. marks the entry “🔨 Забанен (who) … messages and reactions untouched” (or posts a small card) with **🧹 Удалить сообщения и реакции**.

Only that **🧹** button deletes the user's messages (re-ban with `revoke_messages`) and reactions. A real person banned by mistake keeps their messages unless someone confirms.

The reaction flow (auto-ban after 3 reactions, **Ban** on a reaction card) works the same way: it bans in both places and puts **🧹** under the ban log instead of deleting right away.

### Inline post buttons (`/post`)

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
api/                 Vercel routes: telegram webhook, setup, health
src/
  bot.ts             handler registration order (matters: see comments)
  handlers/          reactions + channel cards, moderation callbacks, join log, commands, /post
  post-publishing/   /post wizard state machine, drafts
  chat/              optional LLM persona, limits, context buffer
  ban-cleanup.ts     after-ban follow-up and the confirmed wipe
  join-log.ts        join detection, log entry text, hints
  user-lock.ts       per-user Redis lock
  redis.ts           shared Upstash client
tests/               node:test unit tests (fake Telegram / Redis)
tools/chat-analysis/ offline chat export analysis (optional)
```

---

## Security

- Secrets only in environment variables — never commit `.env`
- `/api/setup` requires `Authorization: Bearer <TELEGRAM_WEBHOOK_SECRET>` (or `X-Setup-Key`), compared in constant time; the old `?key=` form is rejected so the secret never lands in request logs
- Telegram webhook header `X-Telegram-Bot-Api-Secret-Token` validated by grammY
- Revoke and rotate `TELEGRAM_BOT_TOKEN` if leaked

---

## Contributing

Issues and pull requests are welcome. Please do not commit tokens or chat IDs from production.

1. Fork the repository
2. Create a branch (`git checkout -b feature/my-change`)
3. Run `npm run typecheck` and `npm test`
4. Open a PR with a clear description

Moderation code bans real people: test it with fakes (see `tests/`) or dry runs that intercept Telegram writes, not against live chats.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 FiraYuld

---

## Acknowledgments

Built for communities running **channel + discussion group** setups on Telegram. Uses [grammY](https://grammy.dev/) and current Bot API features: reaction updates, bulk reaction removal, sender-chat bans and personal channels in profiles.
