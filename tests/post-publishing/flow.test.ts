import assert from "node:assert/strict";
import { test } from "node:test";
import type { PostDraft } from "../../src/post-publishing/draft.js";
import type { PostDraftStore } from "../../src/post-publishing/store.js";
import {
  PostPublishingFlow,
  type PostPublishingApi,
  type ActorInput,
  type CallbackInput,
  type MessageInput,
} from "../../src/post-publishing/flow.js";

const OWNER = 1001;
const CHANNEL = -1003677551589;
const TEST_CHANNEL = -1003908886812;
const FOREIGN_CHANNEL = -1009999999999;

class FakeStore implements PostDraftStore {
  current: PostDraft | null = null;

  async get(_userId: number): Promise<PostDraft | null> {
    return this.current;
  }

  async set(_userId: number, draft: PostDraft): Promise<void> {
    this.current = draft;
  }

  async delete(_userId: number): Promise<void> {
    this.current = null;
  }
}

type SentMessage = { chatId: number; text: string; replyMarkup?: unknown };
type CopyCall = { fromChatId: number; messageId: number; toChatId: number; replyMarkup?: unknown };
type AttachCall = { channelId: number; messageId: number; replyMarkup: unknown };

class FakeApi implements PostPublishingApi {
  sent: SentMessage[] = [];
  copyCalls: CopyCall[] = [];
  attachCalls: AttachCall[] = [];
  answeredCallbacks: string[] = [];
  usernames = new Map<string, number>([["sleepy_corner", CHANNEL]]);
  copyPostError: Error | null = null;
  attachError: Error | null = null;

  async getChannelTitle(channelId: number): Promise<string> {
    return channelId === TEST_CHANNEL ? "🧪 Тест: тест Авантюрин" : "Сонный Уголок";
  }

  async resolveChannelId(username: string): Promise<number> {
    const id = this.usernames.get(username);
    if (id === undefined) throw new Error("chat not found");
    return id;
  }

  async sendText(chatId: number, text: string, options?: { replyMarkup?: unknown }): Promise<void> {
    this.sent.push({ chatId, text, replyMarkup: options?.replyMarkup });
  }

  async copyPost(
    fromChatId: number,
    messageId: number,
    toChatId: number,
    options?: { replyMarkup?: unknown },
  ): Promise<void> {
    if (this.copyPostError) throw this.copyPostError;
    this.copyCalls.push({ fromChatId, messageId, toChatId, replyMarkup: options?.replyMarkup });
  }

  async attachButtons(channelId: number, messageId: number, replyMarkup: unknown): Promise<void> {
    if (this.attachError) throw this.attachError;
    this.attachCalls.push({ channelId, messageId, replyMarkup });
  }

  async answerCallback(callbackQueryId: string): Promise<void> {
    this.answeredCallbacks.push(callbackQueryId);
  }
}

function ownerInput(overrides: Partial<ActorInput> = {}): ActorInput {
  return { userId: OWNER, chatId: OWNER, chatType: "private", ...overrides };
}

function ownerMessage(overrides: Partial<MessageInput> = {}): MessageInput {
  return { ...ownerInput(), messageId: 1, ...overrides };
}

function ownerCallback(overrides: Partial<CallbackInput> = {}): CallbackInput {
  return { ...ownerInput(), data: "post:done", callbackQueryId: "cb-1", ...overrides };
}

function createFlow(channelIds: readonly number[] = [CHANNEL, TEST_CHANNEL]) {
  const store = new FakeStore();
  const api = new FakeApi();
  return {
    flow: new PostPublishingFlow({ ownerId: OWNER, channelIds, store, api }),
    store,
    api,
  };
}

async function advanceToChooseNext(
  flow: PostPublishingFlow,
  store: FakeStore,
  post: Partial<MessageInput> = { forwardedFrom: { channelId: CHANNEL, messageId: 42 } },
) {
  await flow.start(ownerInput());
  await flow.handleMessage(ownerMessage({ messageId: 10, ...post }));
  await flow.handleMessage(ownerMessage({ messageId: 11, text: "Сайт" }));
  await flow.handleMessage(ownerMessage({ messageId: 12, text: "https://example.com" }));
  assert.equal(store.current?.step, "choose_next");
}

function expectUrlKeyboard(buttons: { text: string; url: string }[]) {
  return { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
}

test("happy path: forwarded post -> buttons -> preview -> attach to the original post", async () => {
  const { flow, store, api } = createFlow();

  await flow.start(ownerInput());
  assert.equal(store.current?.step, "await_post");
  assert.match(api.sent.at(-1)!.text, /перешлите/i);

  await flow.handleMessage(
    ownerMessage({ messageId: 10, forwardedFrom: { channelId: CHANNEL, messageId: 42 } }),
  );
  assert.equal(store.current?.step, "await_button_text");
  assert.equal(store.current?.channelId, CHANNEL);
  assert.equal(store.current?.messageId, 42);
  assert.match(api.sent.at(-1)!.text, /Сонный Уголок/);

  await flow.handleMessage(ownerMessage({ messageId: 11, text: "Сайт" }));
  await flow.handleMessage(ownerMessage({ messageId: 12, text: "https://example.com" }));
  assert.deepEqual(store.current?.buttons, [{ text: "Сайт", url: "https://example.com" }]);

  await flow.handleCallback(ownerCallback({ data: "post:done", callbackQueryId: "cb-done" }));
  assert.equal(store.current?.step, "preview");
  assert.deepEqual(api.copyCalls, [
    {
      fromChatId: CHANNEL,
      messageId: 42,
      toChatId: OWNER,
      replyMarkup: expectUrlKeyboard([{ text: "Сайт", url: "https://example.com" }]),
    },
  ]);

  await flow.handleCallback(ownerCallback({ data: "post:publish", callbackQueryId: "cb-pub" }));
  assert.equal(store.current, null);
  assert.deepEqual(api.attachCalls, [
    {
      channelId: CHANNEL,
      messageId: 42,
      replyMarkup: expectUrlKeyboard([{ text: "Сайт", url: "https://example.com" }]),
    },
  ]);
  // The post is never re-sent into the channel (that would drop Premium custom emoji).
  assert.equal(api.copyCalls.some((c) => c.toChatId === CHANNEL), false);
  assert.match(api.sent.at(-1)!.text, /Кнопки добавлены/);
});

test("accepts a private-channel link to the post", async () => {
  const { flow, store } = createFlow();
  await flow.start(ownerInput());

  await flow.handleMessage(ownerMessage({ text: "https://t.me/c/3908886812/2" }));

  assert.equal(store.current?.step, "await_button_text");
  assert.equal(store.current?.channelId, TEST_CHANNEL);
  assert.equal(store.current?.messageId, 2);
});

test("accepts a public-channel link and resolves the username", async () => {
  const { flow, store } = createFlow();
  await flow.start(ownerInput());

  await flow.handleMessage(ownerMessage({ text: "t.me/sleepy_corner/15?single" }));

  assert.equal(store.current?.channelId, CHANNEL);
  assert.equal(store.current?.messageId, 15);
});

test("reports an unknown public channel and keeps await_post", async () => {
  const { flow, store, api } = createFlow();
  await flow.start(ownerInput());

  await flow.handleMessage(ownerMessage({ text: "https://t.me/nope_channel/3" }));

  assert.equal(store.current?.step, "await_post");
  assert.match(api.sent.at(-1)!.text, /@nope_channel/);
});

test("rejects posts from channels that are not connected", async () => {
  const { flow, store, api } = createFlow();
  await flow.start(ownerInput());

  await flow.handleMessage(
    ownerMessage({ forwardedFrom: { channelId: FOREIGN_CHANNEL, messageId: 5 } }),
  );

  assert.equal(store.current?.step, "await_post");
  assert.match(api.sent.at(-1)!.text, /не подключён/);
});

test("rejects albums, non-channel forwards and random text", async () => {
  const { flow, store, api } = createFlow();
  await flow.start(ownerInput());

  await flow.handleMessage(
    ownerMessage({ mediaGroup: true, forwardedFrom: { channelId: CHANNEL, messageId: 5 } }),
  );
  assert.match(api.sent.at(-1)!.text, /альбому/);

  await flow.handleMessage(ownerMessage({ forwardedFromNonChannel: true, text: "hi" }));
  assert.match(api.sent.at(-1)!.text, /не из канала/);

  await flow.handleMessage(ownerMessage({ text: "просто текст" }));
  assert.match(api.sent.at(-1)!.text, /перешлите/i);

  assert.equal(store.current?.step, "await_post");
});

test("ignores foreign users and group chats", async () => {
  const foreign = createFlow();
  await foreign.flow.start({ userId: 999, chatId: 999, chatType: "private" });
  assert.equal(foreign.api.sent.length, 0);
  assert.equal(foreign.store.current, null);

  const { flow, store, api } = createFlow();
  await flow.start(ownerInput());

  const consumed = await flow.handleMessage({
    userId: 999,
    chatId: 999,
    chatType: "private",
    messageId: 1,
    forwardedFrom: { channelId: CHANNEL, messageId: 1 },
  });
  assert.equal(consumed, false);
  assert.equal(store.current?.step, "await_post");

  await flow.handleCallback({
    userId: 999,
    chatId: -100500,
    chatType: "supergroup",
    data: "post:publish",
    callbackQueryId: "cb-x",
  });
  assert.equal(api.answeredCallbacks.length, 0);
});

test("rejects invalid URL and keeps await_button_url", async () => {
  const { flow, store } = createFlow();
  await flow.start(ownerInput());
  await flow.handleMessage(ownerMessage({ forwardedFrom: { channelId: CHANNEL, messageId: 42 } }));
  await flow.handleMessage(ownerMessage({ text: "Сайт" }));

  await flow.handleMessage(ownerMessage({ text: "not-a-url" }));

  assert.equal(store.current?.step, "await_button_url");
  assert.equal(store.current?.pendingButtonText, "Сайт");
});

test("post:add collects several buttons", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(flow, store);

  await flow.handleCallback(ownerCallback({ data: "post:add", callbackQueryId: "cb-add" }));
  assert.equal(store.current?.step, "await_button_text");
  await flow.handleMessage(ownerMessage({ text: "Второй" }));
  await flow.handleMessage(ownerMessage({ text: "https://example.com/2" }));

  assert.equal(store.current?.buttons.length, 2);
  assert.equal(api.answeredCallbacks.includes("cb-add"), true);
});

test("preview failure still allows attaching buttons", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(flow, store);

  api.copyPostError = new Error("content is protected");
  await flow.handleCallback(ownerCallback({ data: "post:done" }));

  assert.equal(store.current?.step, "preview");
  assert.match(api.sent.at(-1)!.text, /Превью недоступно/);
  assert.match(api.sent.at(-1)!.text, /https:\/\/example\.com/);
});

test("attach error keeps the draft at preview", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(flow, store);
  await flow.handleCallback(ownerCallback({ data: "post:done" }));

  api.attachError = new Error("message can't be edited");
  await flow.handleCallback(ownerCallback({ data: "post:publish" }));

  assert.equal(store.current?.step, "preview");
  assert.match(api.sent.at(-1)!.text, /Не удалось добавить кнопки/);
});

test("cancel deletes an active draft and returns true", async () => {
  const { flow, store } = createFlow();
  await flow.start(ownerInput());

  assert.equal(await flow.cancel(ownerInput()), true);
  assert.equal(store.current, null);
});

test("cancel without draft returns false", async () => {
  const { flow } = createFlow();
  assert.equal(await flow.cancel(ownerInput()), false);
});

test("repeat start replaces an unfinished draft", async () => {
  const { flow, store } = createFlow();
  await advanceToChooseNext(flow, store);

  await flow.start(ownerInput());

  assert.deepEqual(store.current, { step: "await_post", buttons: [] });
});

test("stale post callback is answered safely without a draft", async () => {
  const { flow, api } = createFlow();

  const handled = await flow.handleCallback(
    ownerCallback({ data: "post:publish", callbackQueryId: "cb-stale" }),
  );

  assert.equal(handled, false);
  assert.deepEqual(api.answeredCallbacks, ["cb-stale"]);
});

test("handleMessage returns false without an active draft", async () => {
  const { flow } = createFlow();
  assert.equal(await flow.handleMessage(ownerMessage({ text: "hello" })), false);
});
