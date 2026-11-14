import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "grammy/types";
import {
  buildVpnCardHtml,
  hasVpnNickname,
  parseVpnCallback,
  vpnCallbackData,
} from "../../src/vpn-nickname.js";

const u = (first_name: string, extra: Partial<User> = {}): User => ({
  id: 1,
  is_bot: false,
  first_name,
  ...extra,
});

test("detects latin and cyrillic vpn nick variants", () => {
  assert.equal(hasVpnNickname(u("Free VPN")), true);
  assert.equal(hasVpnNickname(u("FreeVPN")), true);
  assert.equal(hasVpnNickname(u("впн бот")), true);
  assert.equal(hasVpnNickname(u("V.P.N Shop")), true);
  assert.equal(hasVpnNickname(u("В-П-Н")), true);
  assert.equal(hasVpnNickname(u("Ann", { username: "cheap_vpn_bot" })), true);
  assert.equal(hasVpnNickname(u("Ann", { last_name: "Быстрый ВПН" })), true);
  assert.equal(hasVpnNickname(u("Обычный юзер")), false);
  assert.equal(hasVpnNickname(u("vapen")), false);
  assert.equal(hasVpnNickname(u("fira", { username: "FiraYuld" })), false);
});

test("vpn callback data round-trips and stays short", () => {
  const data = vpnCallbackData("ban", 8491620936, 1997041);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(parseVpnCallback(data), { action: "ban", userId: 8491620936, messageId: 1997041 });
  assert.deepEqual(parseVpnCallback(vpnCallbackData("keep", 42, 99)), { action: "keep", userId: 42, messageId: 99 });
  assert.equal(parseVpnCallback("b:42:99"), null);
});

test("card links the message and escapes the name", () => {
  const html = buildVpnCardHtml(u("<b>VPN</b>"), -1001897444038, 55);
  assert.match(html, /VPN \/ ВПН в нике/);
  assert.match(html, /&lt;b&gt;VPN&lt;\/b&gt;/);
  assert.match(html, /t\.me\/c\/1897444038\/55/);
});
