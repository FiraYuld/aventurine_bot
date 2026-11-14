import type { Api, Bot } from "grammy";
import type { User } from "grammy/types";
import { config } from "../config.js";
import { buildJoinLogHtml, isJoin, type JoinLogInfo, type PersonalChannelInfo } from "../join-log.js";

const INSIDE = new Set(["creator", "administrator", "member"]);

async function isInside(api: Api, chatId: number, userId: number): Promise<boolean | undefined> {
  try {
    const m = await api.getChatMember(chatId, userId);
    return INSIDE.has(m.status) || (m.status === "restricted" && m.is_member);
  } catch {
    return undefined;
  }
}

/** Reads bio + linked personal channel of a user. Never throws. */
async function readProfile(
  api: Api,
  user: User,
): Promise<Pick<JoinLogInfo, "bio" | "profileReadable" | "personalChannel">> {
  try {
    const full = await api.getChat(user.id);
    const bio = "bio" in full ? full.bio : undefined;
    const pcChat = "personal_chat" in full ? full.personal_chat : undefined;
    let personalChannel: PersonalChannelInfo | undefined;
    if (pcChat) {
      personalChannel = {
        id: pcChat.id,
        title: "title" in pcChat ? pcChat.title : undefined,
        username: "username" in pcChat ? pcChat.username : undefined,
      };
      try {
        const pcFull = await api.getChat(pcChat.id);
        if ("description" in pcFull && pcFull.description) {
          personalChannel.description = pcFull.description;
        }
      } catch {
        // private or inaccessible channel: title from personal_chat is enough
      }
    }
    return { bio, profileReadable: true, personalChannel };
  } catch (err) {
    console.error("[join-log] getChat(user) failed", { userId: user.id, err });
    return { profileReadable: false };
  }
}

export function registerJoinLog(bot: Bot): void {
  bot.on("chat_member", async (ctx) => {
    const upd = ctx.chatMember;
    const chatId = upd.chat.id;
    const place = chatId === config.chatId ? "chat" : chatId === config.channelId ? "channel" : null;
    if (!place) return;
    if (!isJoin(upd.old_chat_member, upd.new_chat_member)) return;

    const user = upd.new_chat_member.user;
    try {
      const otherId = place === "chat" ? config.channelId : config.chatId;
      const [profile, alsoInOther] = await Promise.all([
        readProfile(ctx.api, user),
        isInside(ctx.api, otherId, user.id),
      ]);

      const text = buildJoinLogHtml({
        user,
        place,
        placeTitle: "title" in upd.chat && upd.chat.title ? upd.chat.title : String(chatId),
        alsoInOther,
        viaInviteLinkName: upd.invite_link?.name ?? (upd.invite_link ? "без названия" : undefined),
        viaJoinRequest: upd.via_join_request,
        viaFolder: upd.via_chat_folder_invite_link,
        ...profile,
      });

      await ctx.api.sendMessage(config.moderationChatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        disable_notification: true,
      });
    } catch (err) {
      console.error("[join-log] failed", { chatId, userId: user.id, err });
    }
  });
}
