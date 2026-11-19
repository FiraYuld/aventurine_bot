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

export type JoinCardAction = "confirm" | "unconfirm" | "refresh";
/** `j` = discussion chat / channel join log, `t` = tournament chat. */
export type JoinCardPrefix = "j" | "t";
const JOIN_ACTION_CODE: Record<JoinCardAction, string> = { confirm: "o", unconfirm: "r", refresh: "p" };

/** callback_data of the other join-card buttons: `j|t:o|r|p:<userId>`. */
export function joinCardCallbackData(action: JoinCardAction, userId: number, prefix: JoinCardPrefix = "j"): string {
  return `${prefix}:${JOIN_ACTION_CODE[action]}:${userId}`;
}

export function parseJoinCardCallback(
  data: string,
): { prefix: JoinCardPrefix; action: JoinCardAction; userId: number } | null {
  const m = /^([jt]):([orp]):(\d+)$/.exec(data);
  if (!m) return null;
  const userId = Number(m[3]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const action: JoinCardAction = m[2] === "o" ? "confirm" : m[2] === "r" ? "unconfirm" : "refresh";
  return { prefix: m[1] as JoinCardPrefix, action, userId };
}

/**
 * Fresh join card: ban, "✅ Свой" (a real person: hides the ban button, so it can't be
 * pressed by accident) and 🔄 profile refresh.
 */
export function joinLogKeyboard(userId: number, prefix: JoinCardPrefix = "j"): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔨 Забанить", `${prefix}:b:${userId}`)
    .text("✅ Свой", joinCardCallbackData("confirm", userId, prefix))
    .row()
    .text("🔄 Профиль", joinCardCallbackData("refresh", userId, prefix));
}

/** After "✅ Свой": no ban button, only undo and refresh. */
export function joinConfirmedKeyboard(userId: number, prefix: JoinCardPrefix = "j"): InlineKeyboard {
  return new InlineKeyboard()
    .text("↩️ Отменить «Свой»", joinCardCallbackData("unconfirm", userId, prefix))
    .text("🔄 Профиль", joinCardCallbackData("refresh", userId, prefix));
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
  // "Скуп <игры>", "Продать акк тут 👉 …" (tournament chat spam, Nov 2026).
  [/скуп|выкуп\S*\s+акк|прода\S*\s+(?:сво\S*\s+)?акк|продажа\s+акк|buy\s+accounts?/iu, "скуп аккаунтов"],
  [/казино|casino|ставк|букмекер|\bbet\b|1xbet|слот/iu, "казино/ставки"],
  [/заработ|доход|инвест|крипт|crypto|арбитраж|p2p|трейд/iu, "заработок/крипта"],
  [/знакомств|dating|девушк.{0,10}(рядом|город)|встреч/iu, "знакомства"],
  // "Секретный Переходник": a redirect channel in the profile, typical for 18+ bots.
  [/переходник/iu, "канал-переходник"],
];

export function findHints(texts: ReadonlyArray<string | undefined>): string[] {
  const joined = texts.filter(Boolean).join("\n");
  const out: string[] = [];
  for (const [re, label] of HINT_PATTERNS) {
    if (re.test(joined)) out.push(label);
  }
  return out;
}

/**
 * User IDs grow over time; 8 billion+ are accounts registered roughly in 2025–2026.
 * Replay over two weeks of join cards (Nov 2026): 17 of 19 banned spam accounts were ≥ 8 bn,
 * 4 of 39 untouched joiners too. Real newcomers exist — a hint, not a verdict.
 */
export const NEW_ACCOUNT_ID_FROM = 8_000_000_000;

const TG_LINK_IN_BIO_RE = /(?:t\.me|telegram\.me)\/\S+/iu;

/**
 * Channel-join botnet seen in Nov 2026: a "Katya" name variant ("Катюша ❤️",
 * "Katyusha darling 🖤", "Катенька лапочка 😍"…), no username, no bio, no profile channel.
 */
const KATYA_NAME_RE = /^\s*(?:кат[юяеи]|катер|katy|katj|ekaterin)/iu;

/** Profile-shape markers (need structured fields, not just text). Informational only. */
export function findProfileHints(info: Pick<JoinLogInfo, "user" | "bio" | "profileReadable" | "personalChannel">): string[] {
  const out: string[] = [];
  if (info.user.id >= NEW_ACCOUNT_ID_FROM) out.push("новый аккаунт");
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

type ProfileInfo = Pick<JoinLogInfo, "user" | "bio" | "profileReadable" | "personalChannel">;

/** Bio, profile channel and hints (shared by the join card and the 🔄 refresh). */
function profileLines(info: ProfileInfo): string[] {
  const u = info.user;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  const lines: string[] = [];
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
  return lines;
}

/**
 * 🔄 button: the Katya network joins with an empty profile and fills it in later
 * (links, a channel), so moderators can re-read the profile on demand.
 */
export function profileRefreshHtml(info: ProfileInfo, at: Date = new Date()): string {
  const u = info.user;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "(без имени)";
  const time = at.toISOString().slice(11, 16);
  return [
    `🔄 <b>Профиль сейчас</b> (${time} UTC)`,
    `Имя: ${escapeHtml(name)}${u.username ? ` · @${escapeHtml(u.username)}` : " · без username"}`,
    ...profileLines(info),
  ].join("\n");
}

export function confirmedFooterHtml(by?: User): string {
  const name = by ? [by.first_name, by.last_name].filter(Boolean).join(" ").trim() || "модератор" : "модератор";
  return `✅ <b>Свой</b> — проверил(а) ${escapeHtml(name)}.`;
}

/** Removes the "✅ Свой" footer added by confirmedFooterHtml (undo). */
export function stripConfirmedFooter(html: string): string {
  return html.replace(/\n\n✅ <b>Свой<\/b> — [^\n]*/gu, "");
}

/** Removes an earlier 🔄 section, so repeated refreshes don't pile up. */
export function stripProfileRefresh(html: string): string {
  return html.replace(/\n\n🔄 <b>Профиль сейчас<\/b>[\s\S]*?(?=\n\n|$)/gu, "");
}

export interface JoinCardEntry {
  messageId: number;
  html: string;
}

export interface JoinCardDeps {
  api: {
    editMessageText(chatId: number, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  };
  getCard(userId: number): Promise<JoinCardEntry | null>;
  setCard(userId: number, entry: JoinCardEntry): Promise<void>;
  moderationChatId: number;
}

/**
 * ✅ Свой / ↩️ undo / 🔄 refresh on a join card (`messageId` = the card the button is on).
 * `fallbackHtml` is used when the stored card expired or belongs to another message.
 */
export async function applyJoinCardAction(
  deps: JoinCardDeps,
  opts: {
    prefix: JoinCardPrefix;
    action: JoinCardAction;
    userId: number;
    messageId: number;
    fallbackHtml: string;
    by?: User;
    currentMarkup?: unknown;
    readProfile?: () => Promise<ProfileInfo>;
    now?: Date;
  },
): Promise<void> {
  const stored = await deps.getCard(opts.userId).catch(() => null);
  const base = stored && stored.messageId === opts.messageId ? stored.html : opts.fallbackHtml;
  let html: string;
  let markup: unknown;
  if (opts.action === "confirm") {
    html = `${stripConfirmedFooter(base)}\n\n${confirmedFooterHtml(opts.by)}`;
    markup = joinConfirmedKeyboard(opts.userId, opts.prefix);
  } else if (opts.action === "unconfirm") {
    html = stripConfirmedFooter(base);
    markup = joinLogKeyboard(opts.userId, opts.prefix);
  } else {
    if (!opts.readProfile) throw new Error("readProfile is required for refresh");
    const profile = await opts.readProfile();
    html = `${stripProfileRefresh(base)}\n\n${profileRefreshHtml(profile, opts.now)}`;
    markup = opts.currentMarkup;
  }
  try {
    await deps.api.editMessageText(deps.moderationChatId, opts.messageId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: markup,
    });
  } catch (err) {
    const d = err && typeof err === "object" && "description" in err ? String(err.description) : "";
    if (!/message is not modified/i.test(d)) throw err;
  }
  await deps.setCard(opts.userId, { messageId: opts.messageId, html });
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

  lines.push(...profileLines(info));

  return lines.join("\n");
}
