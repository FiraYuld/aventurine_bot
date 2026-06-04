# Codex for Open Source — application cheat sheet

Use this when filling https://openai.com/form/codex-for-oss/

**Before you submit**

1. GitHub profile → **Public** (Settings → Profile → visibility).
2. Repository `FiraYuld/aventurine_bot` → **Public** (not private).
3. Push latest `README.md`, `LICENSE`, and this commit to `main`.
4. ChatGPT account email = same email on the form.
5. OpenAI Organization ID: https://platform.openai.com/settings/organization/general → copy **Organization ID**.

---

## Suggested field values (copy-paste, edit if needed)

### Role

**Primary maintainer** (if you are the sole author and deployer).

### Why does this repository qualify? (max 500 chars)

```
Production open-source Telegram bot for channel-linked discussion groups. It uses message_reaction webhooks, Redis-backed moderation sessions, human-in-the-loop Ban/Keep flows, and Bot API 10.0 deleteAllMessageReactions after bans. Helps communities keep reactions enabled while reducing spam-bot floods without disabling reactions entirely. TypeScript + grammY + Vercel reference implementation others can fork and adapt.
```

(~380 characters)

### I'm interested in

- [x] Codex Security (if you want security review tooling)
- [x] API credits for my project

### How will you use API credits for your project? (max 500 chars)

```
Maintain and improve the optional LLM persona module (multi-provider client), run integration tests against OpenAI models, and power offline chat-analysis tooling under tools/chat-analysis for moderation research. Credits reduce cost of testing prompts, rate limits, and release QA while keeping the core moderation bot free for self-hosters.
```

(~290 characters)

### Anything else we should know? (max 500 chars)

```
Actively maintained; MIT licensed. Russian setup docs in docs/README.ru.md. The bot is deployed in production for a real community. I contribute Bot API reaction-moderation patterns that are under-documented elsewhere. Happy to share learnings with the OSS program if selected.
```

(~230 characters)

---

## Realistic expectations

OpenAI selects projects they consider important to the ecosystem (often widely used libraries). This repo is a **focused application**, not a npm package with millions of downloads. A strong application emphasizes:

- Real production use and maintenance
- Clear MIT license and public repo
- Concrete API credit use (LLM module + tooling)
- Reference value for Telegram bot developers

Approval is **not guaranteed**. Rejection is common for small/niche apps — you can reapply later as the project grows (stars, forks, blog posts, demos).
