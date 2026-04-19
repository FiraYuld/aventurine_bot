# Авантюрин — модератор реакций

Telegram-бот, который ловит подозрительные реакции в привязанном к каналу чате
обсуждения (в первую очередь «не подписан на канал»). Карточка с кнопками уходит
в чат модерации; бот-аккаунты банятся сразу. Бан выполняется и в чате, и в канале.

Стек: **Node.js 20+**, **TypeScript**, **[grammY](https://grammy.dev/)**,
хостинг на **Vercel** (бесплатный Hobby-план).

---

## Как работает

1. Telegram присылает webhook на `/api/telegram`, когда кто-то меняет реакцию в чате.
2. Бот проверяет:
   - является ли отправитель админом чата/канала (если да — игнор);
   - является ли он ботом (если да — немедленный бан и лог в чат модерации);
   - подписан ли он на канал через `getChatMember` и прочий риск-скоринг.
3. Если человек попадает под правило «надо банить» (сейчас это в основном «не подписан на канал»):
   в **чат модерации** (`MODERATION_CHAT_ID`) уходит сообщение с кнопками **Забанить** / **Оставить**.
4. Если за **60 секунд** с первой такой реакции пользователь снова добавляет/меняет реакцию (в т.ч. на
   **другом** сообщении в чате — как у ботов), а админы не нажали кнопку — **автобан** (нужен **Upstash Redis**).
5. После любого бана по реакции бот отвечает на сообщение с реакцией фразой «Схватил бота за жёпу!».
6. Дополнительные риск-сигналы (нет username, «подозрительное» имя) попадают в текст карточки.

> **Ограничение Telegram Bot API:** реакции на посты самого канала не отдаются
> поимённо ни одному боту (только агрегированные счётчики). Поэтому бот
> модерирует реакции **только в привязанном чате**. Это не баг и не лень — это
> проектное ограничение Telegram, обойти его можно только userbot'ом
> (Telethon/Pyrogram), что в данный проект сознательно не входит.

---

## Что нужно подготовить

### 1. Бот в @BotFather

1. `/newbot` → имя `Авантюрин`, username (например `AvanturinModBot`).
2. Сохранить полученный токен — это `TELEGRAM_BOT_TOKEN`.
3. `/setprivacy` → выбрать бота → **Disable** (иначе бот не будет видеть
   реакции и сообщения в группах).
4. `/setjoingroups` → **Enable**.

### 2. Права в канале и чате

- **В канале**: добавить бота администратором с правом «Удалять подписчиков»
  (Ban users / Remove users).
- **В чате обсуждения**: добавить бота администратором с правами «Блокировка
  пользователей», «Удаление сообщений» и возможность **писать сообщения**
  (нужно для ответа «Схватил бота за жёпу!» под постом).
- **В чате модерации** (`MODERATION_CHAT_ID`): добавить бота участником или
  админом с правом отправлять сообщения (карточки и inline-кнопки).

### 3. ID каналов

Получить числовые ID можно у @username_to_id_bot или @getidsbot —
переслать ему пост из канала и сообщение из чата.

### 4. Владелец, модерация и Redis

- `ADMIN_LOG_CHAT_ID` — **твой личный user ID** (у @userinfobot): только личка
  (`/start`, `/help`, `/ping`, `/status`) и **технические** логи (`logError` /
  `logInfo`). Один раз напиши боту `/start` в личке.
- `MODERATION_CHAT_ID` — ID супергруппы, куда бот шлёт карточки с кнопками и
  итоговые сообщения о банах.
- `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN` — из консоли
  [Upstash](https://upstash.com/) (Redis по REST). Без них на Vercel не
  получится хранить «сессию» между двумя реакциями, то есть **автобан при 2+
  за 60 с** не будет работать корректно.

---

## Локальная разработка

```bash
# Поставить зависимости
npm install

# Создать .env на основе примера
cp .env.example .env
# и заполнить значения

# Проверить компиляцию TypeScript
npm run typecheck

# Запустить локальный dev-сервер Vercel (потребуется vercel login).
# Скрипт называется local, а не dev: иначе vercel dev рекурсивно вызывает сам себя
# (см. https://vercel.link/recursive-invocation-of-commands).
npm run local
```

Для локального тестирования вебхуков понадобится туннель, например
[ngrok](https://ngrok.com/):

```bash
ngrok http 3000
# затем установить webhook вручную:
# https://<ngrok-url>/api/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

---

## Деплой на Vercel — пошагово

```bash
# Один раз: установить CLI
npm i -g vercel
vercel login

# Сгенерировать секрет для вебхука (понадобится для env)
openssl rand -hex 32

# Привязать проект (создаст .vercel/)
vercel link

# Добавить env-переменные (production)
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_WEBHOOK_SECRET production
vercel env add CHANNEL_ID production
vercel env add CHAT_ID production
vercel env add ADMIN_LOG_CHAT_ID production
vercel env add MODERATION_CHAT_ID production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production

# Деплой
vercel --prod
```

После деплоя получишь URL вида `https://avanturin-bot-xxxx.vercel.app`.

### Установка webhook

Один раз открой в браузере:

```
https://<твой-домен>/api/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

Должен вернуться JSON `{"ok": true, "message": "Webhook установлен на ..."}`.
В нём же в `details` будет ответ `getWebhookInfo` — проверь, что
`allowed_updates` содержит `message_reaction` и `callback_query` (после
обновления кода снова вызови `/api/setup`, иначе кнопки не заработают).

Полезные параметры:
- `?action=info` — посмотреть текущее состояние webhook
- `?action=delete` — удалить webhook (например, перед перенастройкой)
- `?action=set` — установить (по умолчанию)

Если видишь **500 / FUNCTION_INVOCATION_FAILED** на `/api/setup`:

1. Открой **`/api/health`** — там видно, какие переменные окружения Vercel реально видит (только факт наличия, без значений).
2. В панели Vercel переменные должны быть добавлены для среды **Production** (не только Preview). После правок env сделай **Redeploy** — иначе старый деплой без новых значений.

---

## Команды бота

Обрабатываются личка владельца, чат обсуждения (`CHAT_ID`), чат модерации
(`MODERATION_CHAT_ID`, в т.ч. команды `/unban`) и callback из чата модерации
(см. `src/middleware/scope.ts`).

- `/start`, `/help`, `/ping`, `/status` — только пользователь с ID = `ADMIN_LOG_CHAT_ID`.
- `/unban <user_id>` — владелец или администраторы канала и чата обсуждения.

---

## Безопасность

- Все секреты — только в `vercel env`, никогда не коммитить.
- Если токен бота попал в публичное место (чат с агентом, скрин и т.п.) —
  обязательно сделать `/revoke` у @BotFather и обновить `TELEGRAM_BOT_TOKEN`.
- Endpoint `/api/setup` защищён параметром `?key=`, который должен совпадать с
  `TELEGRAM_WEBHOOK_SECRET`. Без правильного ключа возвращает 403.
- Telegram при каждом запросе на webhook присылает заголовок
  `X-Telegram-Bot-Api-Secret-Token` со значением `TELEGRAM_WEBHOOK_SECRET`.
  grammy его проверяет автоматически — посторонние запросы будут отброшены.

---

## Возможные ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `setMyCommands: chat not found` или похожие 400 на старте | Неверный `CHANNEL_ID`/`CHAT_ID` | Проверить, что ID числовой и со знаком минус (`-100...`) |
| Бот не банит, в логах `Bad Request: not enough rights` | Не выданы права админа на бан | Проверить через `/status`, переоткрыть права в чате/канале |
| `getChatMember: user not found` | Юзер вообще не известен Telegram (редкое) | Считается «не подписан», бан срабатывает |
| Реакции не приходят в webhook | `allowed_updates` не содержит `message_reaction` | Дёрнуть `/api/setup` ещё раз, проверить `?action=info` |
| Кнопки в чате модерации не реагируют | Webhook без `callback_query` | Снова открыть `/api/setup?key=...`, в `info` должен быть `callback_query` |
| Автобан по 2-й реакции не срабатывает | Нет Redis или неверные ключи Upstash | Проверить `UPSTASH_*` и `/api/health` |
| Бот не может писать в личку | Юзер ни разу не написал боту `/start` | Написать боту `/start` со своего аккаунта |

---

## Структура

```
avanturin-bot/
├── api/
│   ├── telegram.ts       # webhook endpoint
│   └── setup.ts          # установка/удаление/инфо webhook
├── src/
│   ├── bot.ts            # инстанс grammY
│   ├── config.ts         # парсинг env
│   ├── logger.ts         # логи (баны → модерация, ошибки → владелец)
│   ├── moderation.ts     # бан, проверка подписки, риск-скоринг
│   ├── moderation-card.ts
│   ├── post-ban.ts       # бан + ответ в чате обсуждения
│   ├── reaction-mod-session.ts  # Redis-сессии
│   └── handlers/
│       ├── reaction.ts   # message_reaction
│       ├── moderation-callbacks.ts  # inline-кнопки
│       └── commands.ts   # /start /help /ping /status /unban
├── .env.example
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```
# aventurine_bot
# aventurine_bot
