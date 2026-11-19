import { InlineKeyboard } from "grammy";
import type { ChatMember, User } from "grammy/types";
import { escapeHtml } from "./logger.js";

/** callback_data of the join-log Ban button: `j:b:<userId>`. */
export function joinBanCallbackData(userId: number): string {
  return `j:b:${userId}`;
}

export function parseJoinBanCallback(data: string): number | null {
  const m = /^j:b:(\d+)$/.exec(data);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function joinLogKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard().text("🔨 Забанить", joinBanCallbackData(userId));
}

/** True when the update moves the user from "not banned" to "banned" (kicked). */
export function isBan(oldMember: ChatMember, newMember: ChatMember): boolean {
  return oldMember.status !== "kicked" && newMember.status === "kicked";
}

/**
 * Join log (observation mode): every join to the discussion chat or the channel is
 * reported to the moderation chat with the profile signals spam accounts tend to have
 * (a linked personal channel, a bio, odd names). Nothing is banned here — the goal is to
 * collect real examples and tune rules before any automatic action.
 */

function isInside(m: ChatMember): boolean {
  switch (m.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return m.is_member;
    default:
      return false;
  }
}

/** True when the update moves the user from "not in chat" to "in chat". */
export function isJoin(oldMember: ChatMember, newMember: ChatMember): boolean {
  return !isInside(oldMember) && isInside(newMember);
}

/**
 * Informational markers only (shown in the log, no action). Matched case-insensitively
 * against names, bio and the linked channel's title/description.
 */
const HINT_PATTERNS: Array<[RegExp, string]> = [
  [
    /18\s*\+|\bxxx\b|porn|порн|onlyfans|онлифанс|эрот|интим|nude|nsfw|сливы|slivy|секс|sex|see\s*more\s*of\s*me/iu,
    "18+",
  ],
  // "Скуп геншина,ZZZ,Хонкай", "Продать акк тут 👉 …" (tournament chat spam, Nov 2026).
  [/скуп|выкуп\S*\s+акк|прода\S*\s+(?:сво\S*\s+)?акк|продажа\s+акк|buy\s+accounts?/iu, "скуп аккаунтов"],
  [/казино|casino|ставк|букмекер|\bbet\b|1xbet|слот/iu, "казино/ставки"],
  [/заработ|доход|инвест|крипт|crypto|арбитраж|p2p|трейд/iu, "заработок/крипта"],
  [/знакомств|dating|девушк.{0,10}(рядом|город)|встреч/iu, "знакомства"],
];

export function findHints(texts: ReadonlyArray<string | undefined>): string[] {
  const joined = texts.filter(Boolean).join("\n");
  const out: string[] = [];
  for (const [re, label] of HINT_PATTERNS) {
    if (re.test(joined)) out.push(label);
  }
  return out;
}

const TG_LINK_IN_BIO_RE = /(?:t\.me|telegram\.me)\/\S+/iu;

/**
 * Channel-join botnet seen in Nov 2026: a "Katya" name variant ("Катюша ❤️",
 * "Katyusha darling 🖤", "Катенька лапочка 😍"…), no username, no bio, no profile channel.
 */
const KATYA_NAME_RE = /^\s*(?:кат[юяеи]|катер|katy|katj|ekaterin)/iu;

/** Profile-shape markers (need structured fields, not just text). Informational only. */
export function findProfileHints(info: Pick<JoinLogInfo, "user" | "bio" | "profileReadable" | "personalChannel">): string[] {
  const out: string[] = [];
  if (info.bio && TG_LINK_IN_BIO_RE.test(info.bio)) out.push("ссылка на Telegram в описании");
  const emptyProfile = info.profileReadable && !info.bio && !info.personalChannel && !info.user.username;
  if (emptyProfile && KATYA_NAME_RE.test(info.user.first_name)) out.push("похож на сеть «Кать» (пустой профиль)");
  return out;
}

export interface PersonalChannelInfo {
  id: number;
  title?: string;
  username?: string;
  description?: string;
}

export interface JoinLogInfo {
  user: User;
  /** Where the user joined. */
  place: "chat" | "channel" | "tournament";
  placeTitle: string;
  /** Is the user also inside the other place (chat ↔ channel; tournament → channel)? undefined = unknown. */
  alsoInOther?: boolean;
  viaInviteLinkName?: string;
  viaJoinRequest?: boolean;
  viaFolder?: boolean;
  /** undefined = profile could not be read. */
  bio?: string;
  profileReadable: boolean;
  personalChannel?: PersonalChannelInfo;
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}

export function buildJoinLogHtml(info: JoinLogInfo): string {
  const u = info.user;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "(без имени)";
  const lines: string[] = [];

  const where =
    info.place === "chat" ? "в чат" : info.place === "tournament" ? "в чат турниров" : "в канал";
  lines.push(`👤 <b>Вход ${where}</b> «${escapeHtml(info.placeTitle)}»`);
  lines.push("");
  // Profile link, so moderators can open the account in one tap.
  lines.push(
    `Имя: <a href="tg://user?id=${u.id}">${escapeHtml(name)}</a>` +
      (u.username ? ` · @${escapeHtml(u.username)}` : " · без username") +
      (u.is_bot ? " · <b>бот</b>" : "") +
      (u.is_premium ? " · premium" : ""),
  );
  lines.push(`ID: <code>${u.id}</code>`);

  const how: string[] = [];
  if (info.viaInviteLinkName) how.push(`по ссылке «${escapeHtml(info.viaInviteLinkName)}»`);
  if (info.viaJoinRequest) how.push("по заявке");
  if (info.viaFolder) how.push("через папку");
  if (how.length > 0) lines.push(`Как: ${how.join(", ")}`);

  if (info.alsoInOther !== undefined) {
    const other = info.place === "channel" ? "чате" : "канале";
    lines.push(`Также в ${other}: ${info.alsoInOther ? "да" : "нет"}`);
  }

  if (!info.profileReadable) {
    lines.push("Профиль: не удалось прочитать");
  } else {
    lines.push(`Описание: ${info.bio ? escapeHtml(clip(info.bio, 200)) : "—"}`);
    const pc = info.personalChannel;
    if (pc) {
      const handle = pc.username ? ` · @${escapeHtml(pc.username)}` : "";
      lines.push(`📢 Канал в профиле: ${escapeHtml(pc.title ?? String(pc.id))}${handle}`);
      if (pc.description) lines.push(`   ${escapeHtml(clip(pc.description, 200))}`);
    } else {
      lines.push("Канал в профиле: —");
    }
  }

  const hints = findHints([
    name,
    u.username,
    info.bio,
    info.personalChannel?.title,
    info.personalChannel?.username,
    info.personalChannel?.description,
  ]);
  hints.push(...findProfileHints(info));
  if (hints.length > 0) lines.push(`⚠️ Признаки: ${hints.join(", ")}`);

  return lines.join("\n");
}
