import assert from "node:assert/strict";
import { mock, test } from "node:test";
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
const CHANNEL = -100200;
const CHANNEL_B = -1003677551589;
const channelCallback = (channelId = CHANNEL) => `post:channel:${channelId}`;

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

type SentMessage = {
  chatId: number;
  text: string;
  replyMarkup?: unknown;
};

type CopyCall = {
  fromChatId: number;
  messageId: number;
  toChatId: number;
  replyMarkup?: unknown;
};

class FakeApi implements PostPublishingApi {
  sent: SentMessage[] = [];
  copyCalls: CopyCall[] = [];
  answeredCallbacks: string[] = [];
  channelTitles = new Map<number, string>([
    [CHANNEL, "Сонный Уголок"],
    [CHANNEL_B, "Подвал Неомраченных"],
  ]);
  channelTitleError: Error | null = null;
  copyPostError: Error | null = null;

  async getChannelTitle(channelId: number): Promise<string> {
    if (this.channelTitleError) throw this.channelTitleError;
    return this.channelTitles.get(channelId) ?? `Канал ${channelId}`;
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
  return {
    ...ownerInput(),
    data: channelCallback(),
    callbackQueryId: "cb-1",
    ...overrides,
  };
}

function createFlow(
  store = new FakeStore(),
  api = new FakeApi(),
  channelIds: readonly number[] = [CHANNEL],
) {
  return {
    flow: new PostPublishingFlow({ ownerId: OWNER, channelIds, store, api }),
    store,
    api,
  };
}

async function advanceToChooseNext(
  store: FakeStore,
  flow: PostPublishingFlow,
  channelId = CHANNEL,
) {
  await flow.start(ownerInput());
  await flow.handleCallback(ownerCallback({ data: channelCallback(channelId) }));
  await flow.handleMessage(
    ownerMessage({ messageId: 10, photo: true, caption: "Подпись" }),
  );
  await flow.handleMessage(ownerMessage({ messageId: 11, text: "Сайт" }));
  await flow.handleMessage(
    ownerMessage({ messageId: 12, text: "https://example.com" }),
  );
  assert.equal(store.current?.step, "choose_next");
}

test("happy path advances through the publishing state machine", async () => {
  const { flow, store, api } = createFlow();

  await flow.start(ownerInput());
  assert.equal(store.current?.step, "select_channel");
  assert.match(api.sent.at(-1)!.text, /Выберите канал/);

  await flow.handleCallback(ownerCallback({ data: channelCallback() }));
  assert.equal(store.current?.step, "await_post");
  assert.equal(store.current?.channelId, CHANNEL);

  await flow.handleMessage(
    ownerMessage({ messageId: 10, photo: true, caption: "Подпись" }),
  );
  assert.equal(store.current?.step, "await_button_text");

  await flow.handleMessage(ownerMessage({ messageId: 11, text: "Сайт" }));
  assert.equal(store.current?.step, "await_button_url");

  await flow.handleMessage(
    ownerMessage({ messageId: 12, text: "https://example.com" }),
  );
  assert.equal(store.current?.step, "choose_next");
  assert.deepEqual(store.current?.buttons, [{ text: "Сайт", url: "https://example.com" }]);
});

test("offers both channels and publishes to the selected secondary channel", async () => {
  const { flow, store, api } = createFlow(new FakeStore(), new FakeApi(), [CHANNEL, CHANNEL_B]);

  await flow.start(ownerInput());
  assert.equal(store.current?.step, "select_channel");
  const keyboard = api.sent.at(-1)!.replyMarkup as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  assert.deepEqual(
    keyboard.inline_keyboard.map((row) => row.map((btn) => [btn.text, btn.callback_data])),
    [
      [["Сонный Уголок", channelCallback(CHANNEL)]],
      [["Подвал Неомраченных", channelCallback(CHANNEL_B)]],
    ],
  );

  await advanceToChooseNext(store, flow, CHANNEL_B);
  assert.equal(store.current?.channelId, CHANNEL_B);
  await flow.handleCallback(ownerCallback({ data: "post:done" }));
  await flow.handleCallback(ownerCallback({ data: "post:publish", callbackQueryId: "cb-pub" }));

  assert.equal(store.current, null);
  assert.equal(api.copyCalls.at(-1)!.toChatId, CHANNEL_B);
});

test("ignores foreign users and group chats", async () => {
  const foreign = createFlow();
  await foreign.flow.start({ userId: 999, chatId: 999, chatType: "private" });
  assert.equal(foreign.api.sent.length, 0);
  assert.equal(foreign.store.current, null);

  const { flow, store, api } = createFlow();
  await flow.start(ownerInput());
  assert.equal(store.current?.step, "select_channel");

  await flow.handleMessage({
    userId: 999,
    chatId: 999,
    chatType: "private",
    messageId: 1,
    text: "hello",
  });
  assert.equal(store.current?.step, "select_channel");

  await flow.handleCallback({
    userId: 999,
    chatId: -100500,
    chatType: "supergroup",
    data: channelCallback(),
    callbackQueryId: "cb-x",
  });
  assert.equal(store.current?.step, "select_channel");
  assert.equal(api.answeredCallbacks.length, 0);
});

test("rejects photo without caption and keeps await_post", async () => {
  const { flow, store } = createFlow();

  await flow.start(ownerInput());
  await flow.handleCallback(ownerCallback({ data: channelCallback() }));

  const consumed = await flow.handleMessage(
    ownerMessage({ messageId: 10, photo: true, caption: "" }),
  );

  assert.equal(consumed, true);
  assert.equal(store.current?.step, "await_post");
});

test("rejects invalid URL and keeps await_button_url", async () => {
  const { flow, store } = createFlow();

  await flow.start(ownerInput());
  await flow.handleCallback(ownerCallback({ data: channelCallback() }));
  await flow.handleMessage(
    ownerMessage({ messageId: 10, photo: true, caption: "Подпись" }),
  );
  await flow.handleMessage(ownerMessage({ messageId: 11, text: "Сайт" }));

  await flow.handleMessage(ownerMessage({ messageId: 12, text: "not-a-url" }));

  assert.equal(store.current?.step, "await_button_url");
  assert.equal(store.current?.pendingButtonText, "Сайт");
});

test("post:add returns to await_button_text", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(store, flow);

  await flow.handleCallback(ownerCallback({ data: "post:add", callbackQueryId: "cb-add" }));

  assert.equal(store.current?.step, "await_button_text");
  assert.equal(api.answeredCallbacks.includes("cb-add"), true);
});

test("post:done copies preview to owner DM and moves to preview", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(store, flow);

  await flow.handleCallback(ownerCallback({ data: "post:done", callbackQueryId: "cb-done" }));

  assert.equal(store.current?.step, "preview");
  assert.equal(api.copyCalls.length, 1);
  assert.deepEqual(api.copyCalls[0], {
    fromChatId: OWNER,
    messageId: 10,
    toChatId: OWNER,
    replyMarkup: expectUrlKeyboard([{ text: "Сайт", url: "https://example.com" }]),
  });
  const controlMessage = api.sent.at(-1)!;
  assert.match(controlMessage.text, /Опубликовать|опублик/i);
  assert.equal(controlMessage.chatId, OWNER);
});

test("post:publish copies to channel and clears the store", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(store, flow);
  await flow.handleCallback(ownerCallback({ data: "post:done" }));

  await flow.handleCallback(ownerCallback({ data: "post:publish", callbackQueryId: "cb-pub" }));

  assert.equal(store.current, null);
  assert.equal(api.copyCalls.length, 2);
  assert.equal(api.copyCalls[1]!.toChatId, CHANNEL);
});

test("copyPost error on publish keeps the draft", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(store, flow);
  await flow.handleCallback(ownerCallback({ data: "post:done" }));

  api.copyPostError = new Error("telegram failed");
  await flow.handleCallback(ownerCallback({ data: "post:publish" }));

  assert.equal(store.current?.step, "preview");
});

test("copyPost error on preview keeps the draft at choose_next", async () => {
  const { flow, store, api } = createFlow();
  await advanceToChooseNext(store, flow);

  api.copyPostError = new Error("preview failed");
  await flow.handleCallback(ownerCallback({ data: "post:done" }));

  assert.equal(store.current?.step, "choose_next");
});

test("cancel deletes an active draft and returns true", async () => {
  const { flow, store } = createFlow();

  await flow.start(ownerInput());
  const cancelled = await flow.cancel(ownerInput());

  assert.equal(cancelled, true);
  assert.equal(store.current, null);
});

test("cancel without draft returns false", async () => {
  const { flow } = createFlow();
  assert.equal(await flow.cancel(ownerInput()), false);
});

test("repeat start replaces an unfinished draft", async () => {
  const { flow, store } = createFlow();

  await flow.start(ownerInput());
  await flow.handleCallback(ownerCallback({ data: channelCallback() }));
  await flow.start(ownerInput());

  assert.equal(store.current?.step, "select_channel");
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
  assert.equal(
    await flow.handleMessage(ownerMessage({ text: "hello" })),
    false,
  );
});

function expectUrlKeyboard(buttons: { text: string; url: string }[]) {
  return {
    inline_keyboard: buttons.map((button) => [{ text: button.text, url: button.url }]),
  };
}
