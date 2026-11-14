import type { ChatMember, User } from "grammy/types";
import { escapeHtml } from "./logger.js";

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
  [/18\s*\+|\bxxx\b|porn|порн|onlyfans|онлифанс|эрот|интим|nude|nsfw|сливы|slivy|секс|sex/iu, "18+"],
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

export interface PersonalChannelInfo {
  id: number;
  title?: string;
  username?: string;
  description?: string;
}

export interface JoinLogInfo {
  user: User;
  /** Where the user joined. */
  place: "chat" | "channel";
  placeTitle: string;
  /** Is the user also inside the other place (chat ↔ channel)? undefined = unknown. */
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

  const where = info.place === "chat" ? "в чат" : "в канал";
  lines.push(`👤 <b>Вход ${where}</b> «${escapeHtml(info.placeTitle)}»`);
  lines.push("");
  lines.push(
    `Имя: ${escapeHtml(name)}` +
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
    const other = info.place === "chat" ? "канале" : "чате";
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
  if (hints.length > 0) lines.push(`⚠️ Признаки: ${hints.join(", ")}`);

  return lines.join("\n");
}
