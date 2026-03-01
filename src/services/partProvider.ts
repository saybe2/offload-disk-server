import { Archive } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { fetchWebhookMessage, uploadBufferToWebhook, deleteWebhookMessage } from "./discord.js";
import { buildTelegramFileUrl, deleteTelegramMessage, isTelegramReady, uploadBufferToTelegram } from "./telegram.js";
import { config } from "../config.js";

export type PartProvider = "discord" | "telegram";

type UploadResult = {
  provider: PartProvider;
  url: string;
  messageId: string;
  webhookId: string;
  telegramFileId?: string;
  telegramChatId?: string;
};

export function resolvePartProvider(part: any): PartProvider {
  if (part?.provider === "telegram") return "telegram";
  return "discord";
}

export async function uploadPartWithFallback(
  buffer: Buffer,
  filename: string,
  content: string,
  discordWebhook?: { id: string; url: string }
): Promise<UploadResult> {
  let discordError: Error | null = null;
  if (discordWebhook?.url) {
    try {
      const uploaded = await uploadBufferToWebhook(buffer, filename, discordWebhook.url, content);
      return {
        provider: "discord",
        url: uploaded.url,
        messageId: uploaded.messageId,
        webhookId: discordWebhook.id
      };
    } catch (err) {
      discordError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (isTelegramReady()) {
    const tg = await uploadBufferToTelegram(buffer, filename, content);
    return {
      provider: "telegram",
      url: tg.url,
      messageId: tg.messageId,
      webhookId: "telegram",
      telegramFileId: tg.fileId,
      telegramChatId: tg.chatId
    };
  }

  if (discordError) {
    throw discordError;
  }
  throw new Error("no_storage_provider_available");
}

export async function refreshPartUrl(archiveId: string, part: any) {
  const provider = resolvePartProvider(part);
  if (provider === "telegram") {
    const fileId = String(part?.telegramFileId || "");
    if (!fileId) {
      throw new Error("missing_telegram_file_id");
    }
    const freshUrl = await buildTelegramFileUrl(fileId);
    await Archive.updateOne(
      { _id: archiveId, "parts.messageId": part.messageId, "parts.index": part.index },
      { $set: { "parts.$.url": freshUrl } }
    );
    part.url = freshUrl;
    return freshUrl;
  }

  const webhookId = part?.webhookId ? String(part.webhookId) : "";
  const messageId = String(part?.messageId || "");
  if (!webhookId || !messageId) {
    throw new Error("missing_webhook_metadata");
  }
  const hook = await Webhook.findById(webhookId).lean();
  if (!hook?.url) {
    throw new Error("missing_webhook");
  }
  const payload = await fetchWebhookMessage(hook.url, messageId);
  const freshUrl = payload.attachments?.[0]?.url;
  if (!freshUrl) {
    throw new Error("missing_attachment_url");
  }
  await Archive.updateOne(
    { _id: archiveId, "parts.messageId": messageId, "parts.index": part.index },
    { $set: { "parts.$.url": freshUrl } }
  );
  part.url = freshUrl;
  return freshUrl;
}

export async function deletePartRemote(part: any, hookById: Map<string, string>) {
  const provider = resolvePartProvider(part);
  if (provider === "telegram") {
    const chatId = String(part?.telegramChatId || config.telegramChatId || "");
    if (!chatId) return;
    await deleteTelegramMessage(chatId, String(part.messageId));
    return;
  }
  const hookUrl = hookById.get(String(part.webhookId || ""));
  if (!hookUrl) return;
  await deleteWebhookMessage(hookUrl, String(part.messageId || ""));
}

