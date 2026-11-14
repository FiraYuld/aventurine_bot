import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMember, User } from "grammy/types";
import {
  buildJoinLogHtml,
  findHints,
  isBan,
  isJoin,
  joinBanCallbackData,
  parseJoinBanCallback,
} from "../../src/join-log.js";

const user: User = { id: 777, is_bot: false, first_name: "Paris", last_name: "Ow-Yang" };

const left = { status: "left", user } as ChatMember;
const kicked = { status: "kicked", user, until_date: 0 } as ChatMember;
const member = { status: "member", user } as ChatMember;
const restrictedIn = { status: "restricted", user, is_member: true } as ChatMember;
const restrictedOut = { status: "restricted", user, is_member: false } as ChatMember;

test("detects joins only", () => {
  assert.equal(isJoin(left, member), true);
  assert.equal(isJoin(kicked, member), true);
  assert.equal(isJoin(left, restrictedIn), true);
  assert.equal(isJoin(restrictedOut, restrictedIn), true);
  assert.equal(isJoin(member, left), false, "leave");
  assert.equal(isJoin(member, restrictedIn), false, "restricted while inside");
  assert.equal(isJoin(left, kicked), false, "ban of a non-member");
});

test("hints flag typical spam profile wording", () => {
  assert.deepEqual(findHints(["Девочки 18+ 🔞", undefined]), ["18+"]);
  assert.deepEqual(findHints(["Заработок на крипте"]), ["заработок/крипта"]);
  assert.deepEqual(findHints(["Сонный уголок", "любит котиков"]), []);
});

test("log entry shows id, profile channel and hints, HTML-escaped", () => {
  const html = buildJoinLogHtml({
    user: { ...user, first_name: "<b>Paris</b>" },
    place: "chat",
    placeTitle: "Сонный Чат",
    alsoInOther: true,
    profileReadable: true,
    bio: "пиши в лс",
    personalChannel: { id: -100555, title: "Сливы 18+", username: "hot_chan", description: "только для взрослых" },
  });

  assert.match(html, /Вход в чат/);
  assert.match(html, /<code>777<\/code>/);
  assert.match(html, /&lt;b&gt;Paris&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Paris<\/b>/);
  assert.match(html, /Также в канале: да/);
  assert.match(html, /Канал в профиле: Сливы 18\+ · @hot_chan/);
  assert.match(html, /Признаки: 18\+/);
  // One-tap profile link for moderators.
  assert.match(html, /<a href="tg:\/\/user\?id=777">&lt;b&gt;Paris&lt;\/b&gt; Ow-Yang<\/a>/);
});

test("ban detection and join-log button callback", () => {
  assert.equal(isBan(member, kicked), true);
  assert.equal(isBan(left, kicked), true, "ban of someone who already left");
  assert.equal(isBan(kicked, kicked), false);
  assert.equal(isBan(member, left), false, "voluntary leave");

  assert.equal(joinBanCallbackData(777), "j:b:777");
  assert.equal(parseJoinBanCallback("j:b:777"), 777);
  assert.equal(parseJoinBanCallback("b:777:1"), null);
  assert.equal(parseJoinBanCallback("j:b:-5"), null);
});

test("unreadable profile is reported, not hidden", () => {
  const html = buildJoinLogHtml({
    user,
    place: "channel",
    placeTitle: "Сонный Уголок",
    profileReadable: false,
  });
  assert.match(html, /Вход в канал/);
  assert.match(html, /Профиль: не удалось прочитать/);
});
