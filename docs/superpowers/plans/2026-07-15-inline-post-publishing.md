# Inline Post Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать владельцу бота команду `/post`, которая собирает фото с подписью и URL-кнопки, показывает превью и публикует пост в `CHANNEL_ID`.

**Architecture:** Пошаговый сценарий оформляется как конечный автомат с 24-часовым черновиком в существующем Upstash Redis. Чистая логика сценария отделяется от grammY-адаптера, чтобы переходы и ошибки проверялись без Telegram; адаптер переводит реальные сообщения и callback-запросы в команды автомата.

**Tech Stack:** Node.js 20+, TypeScript, grammY 1.30, Upstash Redis, встроенный `node:test` через `tsx --test`.

## Global Constraints

- Команда и callback-кнопки доступны только `ADMIN_LOG_CHAT_ID` в личном чате.
- Канал публикации — только текущий `CHANNEL_ID`; новых переменных окружения нет.
- Пост — одно фото с непустой подписью; альбомы и текстовые посты не входят в задачу.
- Нужна минимум одна `http`/`https` URL-кнопка; каждая кнопка выводится в отдельной строке.
- Черновик живёт 24 часа с последнего успешного шага.
- Ошибка превью или публикации не удаляет черновик.
- Существующее пользовательское изменение `.env.example` не редактировать и не коммитить.

---

### Task 1: Модель и Redis-хранилище черновика

**Files:**
- Create: `src/post-publishing/draft.ts`
- Create: `src/post-publishing/store.ts`
- Create: `tests/post-publishing/draft.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `PostDraft`, `PostButton`, `PostDraftStep`, `DRAFT_TTL_SECONDS`, `isHttpUrl(value: string): boolean`, `buildPostKeyboard(buttons: readonly PostButton[]): InlineKeyboard`.
- Produces: `PostDraftStore` with `get(userId)`, `set(userId, draft)`, `delete(userId)` and `RedisPostDraftStore`.

- [ ] **Step 1: Подключить test runner и написать падающие тесты модели**

Добавить скрипт `"test": "tsx --test tests/**/*.test.ts"`, включить `tests/**/*.ts` в `tsconfig.json` и проверить:

```ts
test("accepts only absolute http and https URLs", () => {
  assert.equal(isHttpUrl("https://example.com/path"), true);
  assert.equal(isHttpUrl("http://example.com"), true);
  assert.equal(isHttpUrl("tg://resolve?domain=test"), false);
  assert.equal(isHttpUrl("example.com"), false);
});

test("puts every URL button on a separate row", () => {
  const keyboard = buildPostKeyboard([
    { text: "Первая", url: "https://example.com/1" },
    { text: "Вторая", url: "https://example.com/2" },
  ]).build();
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.deepEqual(keyboard.inline_keyboard.map((row) => row.length), [1, 1]);
});
```

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run: `npm test -- tests/post-publishing/draft.test.ts`

Expected: FAIL из-за отсутствующего `src/post-publishing/draft.ts`.

- [ ] **Step 3: Реализовать типы, URL-проверку и клавиатуру**

```ts
export const DRAFT_TTL_SECONDS = 24 * 60 * 60;
export type PostDraftStep =
  | "select_channel" | "await_post" | "await_button_text"
  | "await_button_url" | "choose_next" | "preview";
export interface PostButton { text: string; url: string }
export interface PostDraft {
  step: PostDraftStep;
  channelId: number;
  sourceChatId?: number;
  sourceMessageId?: number;
  pendingButtonText?: string;
  buttons: PostButton[];
}
export function isHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}
export function buildPostKeyboard(buttons: readonly PostButton[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.url(button.text, button.url).row();
  return keyboard;
}
```

`RedisPostDraftStore.set` записывает JSON в `postdraft:<userId>` с `{ ex: DRAFT_TTL_SECONDS }`; `get` принимает как объектный, так и строковый ответ Upstash, а повреждённое значение трактует как отсутствие черновика.

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npm test -- tests/post-publishing/draft.test.ts && npm run typecheck`

Expected: PASS и TypeScript без ошибок.

- [ ] **Step 5: Зафиксировать компонент**

```bash
git add package.json tsconfig.json src/post-publishing/draft.ts src/post-publishing/store.ts tests/post-publishing/draft.test.ts
git commit -m "feat: add post draft model and storage"
```

### Task 2: Конечный автомат публикации

**Files:**
- Create: `src/post-publishing/flow.ts`
- Create: `tests/post-publishing/flow.test.ts`

**Interfaces:**
- Consumes: `PostDraftStore`, `PostDraft`, `isHttpUrl`, `buildPostKeyboard` from Task 1.
- Produces: `PostPublishingApi` with `getChannelTitle`, `sendText`, `copyPost`, `answerCallback`; `PostPublishingFlow.start`, `cancel`, `handleMessage`, `handleCallback`.
- `handleMessage(input): Promise<boolean>` returns `true` only when an active publishing draft consumed the message.

- [ ] **Step 1: Написать падающие сценарные тесты с fake API/store**

Тесты последовательно доказывают:

```ts
await flow.start({ userId: OWNER, chatId: OWNER, chatType: "private" });
assert.equal(store.current?.step, "select_channel");
assert.match(api.sent.at(-1)!.text, /Выберите канал/);

await flow.handleCallback({ userId: OWNER, chatId: OWNER, chatType: "private", data: "post:channel" });
assert.equal(store.current?.step, "await_post");

await flow.handleMessage({ userId: OWNER, chatId: OWNER, chatType: "private", messageId: 10, photo: true, caption: "Подпись" });
assert.equal(store.current?.step, "await_button_text");

await flow.handleMessage({ userId: OWNER, chatId: OWNER, chatType: "private", messageId: 11, text: "Сайт" });
assert.equal(store.current?.step, "await_button_url");

await flow.handleMessage({ userId: OWNER, chatId: OWNER, chatType: "private", messageId: 12, text: "https://example.com" });
assert.equal(store.current?.step, "choose_next");
assert.deepEqual(store.current?.buttons, [{ text: "Сайт", url: "https://example.com" }]);
```

Отдельные тесты проверяют: чужой пользователь и группа игнорируются; фото без подписи отклоняется; неверный URL оставляет `await_button_url`; «Добавить ещё» возвращает `await_button_text`; «Готово» вызывает `copyPost` в личку и создаёт `preview`; «Опубликовать» копирует в канал и очищает store; ошибка `copyPost` сохраняет черновик; `/cancel`, повторный `/post` и устаревший callback безопасны.

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run: `npm test -- tests/post-publishing/flow.test.ts`

Expected: FAIL из-за отсутствующего `PostPublishingFlow`.

- [ ] **Step 3: Реализовать минимальный автомат**

```ts
export class PostPublishingFlow {
  constructor(private readonly deps: {
    ownerId: number; channelId: number; store: PostDraftStore; api: PostPublishingApi;
  }) {}

  async start(input: ActorInput): Promise<void>;
  async cancel(input: ActorInput): Promise<boolean>;
  async handleMessage(input: MessageInput): Promise<boolean>;
  async handleCallback(input: CallbackInput): Promise<boolean>;
}
```

Каждый публичный метод сначала проверяет `userId === ownerId`, `chatType === "private"` и `chatId === ownerId`. Успешный переход всегда сохраняет новое состояние, а ошибки Telegram API перехватываются только там, где нужно сохранить возможность повторить превью или публикацию.

Callback data фиксируется как `post:channel`, `post:add`, `post:done`, `post:publish`, `post:cancel`. Любой callback с префиксом `post:` получает `answerCallback`, даже если черновика уже нет.

- [ ] **Step 4: Добиться GREEN и проверить весь набор**

Run: `npm test && npm run typecheck`

Expected: все сценарии PASS, TypeScript без ошибок.

- [ ] **Step 5: Зафиксировать автомат**

```bash
git add src/post-publishing/flow.ts tests/post-publishing/flow.test.ts
git commit -m "feat: add inline post publishing flow"
```

### Task 3: Подключение к grammY и scope middleware

**Files:**
- Create: `src/handlers/post-publishing.ts`
- Create: `tests/post-publishing/scope.test.ts`
- Modify: `src/middleware/scope.ts`
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `PostPublishingFlow` and `RedisPostDraftStore` from Tasks 1–2.
- Produces: `registerPostPublishing(bot: Bot): void`.

- [ ] **Step 1: Написать падающий тест области callback-запросов**

Проверить, что `post:*` callback владельца из лички вызывает `next`, чужой — получает ответ и останавливается, а существующий callback модерации продолжает допускаться только из `MODERATION_CHAT_ID`.

```ts
await scopeMiddleware(ownerPrivatePostCallback, next);
assert.equal(next.mock.callCount(), 1);
await scopeMiddleware(strangerPrivatePostCallback, next);
assert.equal(next.mock.callCount(), 1);
assert.equal(strangerPrivatePostCallback.answerCallback.mock.callCount(), 1);
```

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run: `npm test -- tests/post-publishing/scope.test.ts`

Expected: FAIL, потому что текущий middleware отвергает все callback не из чата модерации.

- [ ] **Step 3: Расширить scope и реализовать grammY-адаптер**

В `scopeMiddleware` до проверки moderation chat разрешить только `data.startsWith("post:")`, private chat и `isOwnerUserId(ctx.from.id)`.

`registerPostPublishing` создаёт Redis store и flow, регистрирует `/post`, `/cancel`, `callbackQuery(/^post:/)` и общий `message` handler. Общий handler обязательно вызывает `next()` при `consumed === false`, чтобы не блокировать LLM и остальные обработчики.

В `src/bot.ts` зарегистрировать адаптер после `registerCommands` и до обработчиков callback модерации и LLM:

```ts
registerCommands(botInstance);
registerPostPublishing(botInstance);
registerReactionHandler(botInstance);
registerModerationCallbacks(botInstance);
registerChatHandler(botInstance);
```

- [ ] **Step 4: Запустить все проверки**

Run: `npm test && npm run typecheck`

Expected: PASS; старые обработчики компилируются без изменений поведения.

- [ ] **Step 5: Зафиксировать интеграцию**

```bash
git add src/handlers/post-publishing.ts src/middleware/scope.ts src/bot.ts tests/post-publishing/scope.test.ts
git commit -m "feat: connect post publishing to telegram bot"
```

### Task 4: Команды и документация

**Files:**
- Modify: `src/handlers/commands.ts`
- Modify: `README.md`
- Modify: `docs/README.ru.md`

**Interfaces:**
- Consumes: пользовательский сценарий `/post` из Tasks 2–3.
- Produces: видимую владельцу справку и эксплуатационную документацию.

- [ ] **Step 1: Написать падающую проверку текста справки**

Вынести `HELP_TEXT` как именованный export и добавить тест, который ожидает `/post` и `/cancel`.

```ts
assert.match(HELP_TEXT, /\/post/);
assert.match(HELP_TEXT, /\/cancel/);
```

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run: `npm test -- tests/post-publishing/help.test.ts`

Expected: FAIL, потому что команды ещё не описаны в `HELP_TEXT`.

- [ ] **Step 3: Обновить справку и README**

Добавить владельцу краткие строки: `/post` запускает мастер фото-поста с URL-кнопками, `/cancel` отменяет черновик. В обоих README описать шаги, ограничение одним фото и необходимость права бота публиковать сообщения в `CHANNEL_ID`.

- [ ] **Step 4: Финальная автоматическая проверка**

Run: `npm test && npm run typecheck && git diff --check`

Expected: все тесты PASS, typecheck и diff check без вывода ошибок.

- [ ] **Step 5: Зафиксировать документацию**

```bash
git add src/handlers/commands.ts tests/post-publishing/help.test.ts README.md docs/README.ru.md
git commit -m "docs: explain inline post publishing"
```

### Task 5: Финальная проверка сценария

**Files:**
- Verify only; production-файлы не изменяются без нового RED-теста.

**Interfaces:**
- Consumes: завершённую функцию из Tasks 1–4.
- Produces: подтверждённый результат и список ручных staging-проверок.

- [ ] **Step 1: Проверить чистоту и полный набор**

Run: `git status --short && npm test && npm run typecheck && git diff --check`

Expected: только исходное пользовательское изменение `.env.example`; тесты и typecheck PASS.

- [ ] **Step 2: Просмотреть итоговый diff относительно спецификации**

Run: `git diff HEAD~4 -- src tests README.md docs/README.ru.md package.json tsconfig.json`

Expected: только изменения `/post`, `/cancel`, хранилища, scope и документации; функция напоминания отсутствует.

- [ ] **Step 3: Передать ручной staging-чеклист**

Проверить на staging: `/post` → канал → фото с подписью → две кнопки → превью → публикация; затем ошибочный URL, отмену и повторное нажатие старой кнопки публикации. Production webhook и env этим планом не изменяются.
