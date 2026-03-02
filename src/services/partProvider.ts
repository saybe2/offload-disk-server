import { Archive } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { fetchWebhookMessage, uploadBufferToWebhook, deleteWebhookMessage } from "./discord.js";
import { buildTelegramFileUrl, deleteTelegramMessage, isTelegramReady, uploadBufferToTelegram } from "./telegram.js";
import { config } from "../config.js";

export type PartProvider = "discord" | "telegram";

export type ProviderCopy = {
  provider: PartProvider;
  url: string;
  messageId: string;
  webhookId: string;
  telegramFileId?: string;
  telegramChatId?: string;
};

export type MirroredUploadResult = {
  primary: ProviderCopy;
  mirrorTarget?: PartProvider;
  mirrorResultPromise?: Promise<ProviderCopy | null>;
};

const providerInFlight: Record<PartProvider, number> = {
  discord: 0,
  telegram: 0
};
let lastChosenProvider: PartProvider = "telegram";

function toProviderCopyFromDiscord(result: { url: string; messageId: string }, webhookId: string): ProviderCopy {
  return {
    provider: "discord",
    url: result.url,
    messageId: result.messageId,
    webhookId
  };
}

function toProviderCopyFromTelegram(result: { url: string; messageId: string; fileId: string; chatId: string }): ProviderCopy {
  return {
    provider: "telegram",
    url: result.url,
    messageId: result.messageId,
    webhookId: "telegram",
    telegramFileId: result.fileId,
    telegramChatId: result.chatId
  };
}

export function resolvePartProvider(part: any): PartProvider {
  if (part?.provider === "telegram") return "telegram";
  return "discord";
}

export function hasMirrorTarget(part: any) {
  return part?.mirrorProvider === "discord" || part?.mirrorProvider === "telegram";
}

async function uploadToDiscord(buffer: Buffer, filename: string, content: string, webhook: { id: string; url: string }) {
  const uploaded = await uploadBufferToWebhook(buffer, filename, webhook.url, content);
  return toProviderCopyFromDiscord(uploaded, webhook.id);
}

async function uploadToTelegram(buffer: Buffer, filename: string, content: string) {
  const uploaded = await uploadBufferToTelegram(buffer, filename, content);
  return toProviderCopyFromTelegram(uploaded);
}

function pickPrimaryProvider(available: PartProvider[]) {
  if (available.length <= 1) {
    return available[0];
  }
  const [a, b] = available;
  const loadA = providerInFlight[a];
  const loadB = providerInFlight[b];
  if (loadA === loadB) {
    const chosen = lastChosenProvider === a ? b : a;
    lastChosenProvider = chosen;
    return chosen;
  }
  const chosen = loadA < loadB ? a : b;
  lastChosenProvider = chosen;
  return chosen;
}

async function uploadViaProvider(
  provider: PartProvider,
  buffer: Buffer,
  filename: string,
  content: string,
  discordWebhook?: { id: string; url: string }
) {
  providerInFlight[provider] += 1;
  try {
    if (provider === "telegram") {
      return await uploadToTelegram(buffer, filename, content);
    }
    if (!discordWebhook?.url) {
      throw new Error("discord_webhook_missing");
    }
    return await uploadToDiscord(buffer, filename, content, discordWebhook);
  } finally {
    providerInFlight[provider] = Math.max(0, providerInFlight[provider] - 1);
  }
}

function toRecordFromCopy(copy: ProviderCopy) {
  return {
    provider: copy.provider,
    url: copy.url,
    messageId: copy.messageId,
    webhookId: copy.webhookId,
    telegramFileId: copy.telegramFileId || "",
    telegramChatId: copy.telegramChatId || ""
  };
}

function toMirrorUpdateSet(copy: ProviderCopy, pending: boolean, error = "") {
  return {
    "parts.$.mirrorProvider": copy.provider,
    "parts.$.mirrorUrl": copy.url,
    "parts.$.mirrorMessageId": copy.messageId,
    "parts.$.mirrorWebhookId": copy.webhookId,
    "parts.$.mirrorTelegramFileId": copy.telegramFileId || "",
    "parts.$.mirrorTelegramChatId": copy.telegramChatId || "",
    "parts.$.mirrorPending": pending,
    "parts.$.mirrorError": error
  };
}

export async function uploadPartMirrored(
  buffer: Buffer,
  filename: string,
  content: string,
  discordWebhook?: { id: string; url: string }
): Promise<MirroredUploadResult> {
  const available: PartProvider[] = [];
  if (discordWebhook?.url) {
    available.push("discord");
  }
  if (isTelegramReady()) {
    available.push("telegram");
  }
  if (available.length === 0) {
    throw new Error("no_storage_provider_available");
  }

  if (available.length === 1) {
    const primary = await uploadViaProvider(available[0], buffer, filename, content, discordWebhook);
    return { primary };
  }

  const primaryProvider = pickPrimaryProvider(available);
  const mirrorTarget = available.find((provider) => provider !== primaryProvider);
  if (!mirrorTarget) {
    const primary = await uploadViaProvider(primaryProvider, buffer, filename, content, discordWebhook);
    return { primary };
  }

  try {
    const primary = await uploadViaProvider(primaryProvider, buffer, filename, content, discordWebhook);
    return {
      primary,
      mirrorTarget
    };
  } catch (err) {
    const fallback = await uploadViaProvider(mirrorTarget, buffer, filename, content, discordWebhook);
    return {
      primary: fallback,
      mirrorTarget: primaryProvider
    };
  }
}

export function getProviderInFlightState() {
  return {
    discord: providerInFlight.discord,
    telegram: providerInFlight.telegram
  };
}

export async function saveMirrorResult(
  archiveId: string,
  partIndex: number,
  mirror: ProviderCopy | null,
  mirrorTarget?: PartProvider,
  errorMessage = ""
) {
  if (mirror) {
    await Archive.updateOne(
      { _id: archiveId, "parts.index": partIndex },
      { $set: toMirrorUpdateSet(mirror, false, "") }
    );
    return;
  }
  if (!mirrorTarget) {
    return;
  }
  await Archive.updateOne(
    { _id: archiveId, "parts.index": partIndex },
    {
      $set: {
        "parts.$.mirrorProvider": mirrorTarget,
        "parts.$.mirrorPending": true,
        "parts.$.mirrorError": errorMessage || "mirror_failed"
      }
    }
  );
}

async function refreshDiscordUrl(webhookId: string, messageId: string) {
  const hook = await Webhook.findById(webhookId).lean();
  if (!hook?.url) {
    throw new Error("missing_webhook");
  }
  const payload = await fetchWebhookMessage(hook.url, messageId);
  const freshUrl = payload.attachments?.[0]?.url;
  if (!freshUrl) {
    throw new Error("missing_attachment_url");
  }
  return freshUrl;
}

async function refreshTelegramUrl(fileId: string) {
  if (!fileId) {
    throw new Error("missing_telegram_file_id");
  }
  return buildTelegramFileUrl(fileId);
}

export async function refreshPartUrl(archiveId: string, part: any) {
  const provider = resolvePartProvider(part);
  const messageId = String(part?.messageId || "");
  const freshUrl =
    provider === "telegram"
      ? await refreshTelegramUrl(String(part?.telegramFileId || ""))
      : await refreshDiscordUrl(String(part?.webhookId || ""), messageId);

  await Archive.updateOne(
    { _id: archiveId, "parts.index": part.index },
    { $set: { "parts.$.url": freshUrl } }
  );
  part.url = freshUrl;
  return freshUrl;
}

export async function refreshMirrorPartUrl(archiveId: string, part: any) {
  const mirrorProvider = part?.mirrorProvider as PartProvider | undefined;
  if (!mirrorProvider) {
    throw new Error("missing_mirror_provider");
  }
  const freshUrl =
    mirrorProvider === "telegram"
      ? await refreshTelegramUrl(String(part?.mirrorTelegramFileId || ""))
      : await refreshDiscordUrl(String(part?.mirrorWebhookId || ""), String(part?.mirrorMessageId || ""));

  await Archive.updateOne(
    { _id: archiveId, "parts.index": part.index },
    { $set: { "parts.$.mirrorUrl": freshUrl } }
  );
  part.mirrorUrl = freshUrl;
  return freshUrl;
}

export async function uploadMirrorForPart(
  part: any,
  encrypted: Buffer,
  content: string,
  preferredWebhook?: { id: string; url: string }
) {
  const target = part?.mirrorProvider as PartProvider | undefined;
  if (!target) {
    return null;
  }
  if (target === "telegram") {
    return uploadToTelegram(encrypted, `part_${part.index}`, content);
  }
  const webhook = preferredWebhook;
  if (!webhook?.url) {
    throw new Error("mirror_missing_discord_webhook");
  }
  return uploadToDiscord(encrypted, `part_${part.index}`, content, webhook);
}

export async function deletePartRemote(part: any, hookById: Map<string, string>) {
  const deletions: Promise<void>[] = [];
  const primaryProvider = resolvePartProvider(part);
  if (primaryProvider === "telegram") {
    const chatId = String(part?.telegramChatId || config.telegramChatId || "");
    if (chatId && part?.messageId) {
      deletions.push(deleteTelegramMessage(chatId, String(part.messageId)));
    }
  } else {
    const hookUrl = hookById.get(String(part?.webhookId || ""));
    if (hookUrl && part?.messageId) {
      deletions.push(deleteWebhookMessage(hookUrl, String(part.messageId)));
    }
  }

  const mirrorProvider = part?.mirrorProvider as PartProvider | undefined;
  if (mirrorProvider === "telegram") {
    const chatId = String(part?.mirrorTelegramChatId || config.telegramChatId || "");
    if (chatId && part?.mirrorMessageId) {
      deletions.push(deleteTelegramMessage(chatId, String(part.mirrorMessageId)));
    }
  } else if (mirrorProvider === "discord") {
    const hookUrl = hookById.get(String(part?.mirrorWebhookId || ""));
    if (hookUrl && part?.mirrorMessageId) {
      deletions.push(deleteWebhookMessage(hookUrl, String(part.mirrorMessageId)));
    }
  }

  await Promise.allSettled(deletions);
}

export function toPartDocument(
  primary: ProviderCopy,
  mirrorTarget?: PartProvider
) {
  return {
    ...toRecordFromCopy(primary),
    mirrorProvider: mirrorTarget || null,
    mirrorUrl: "",
    mirrorMessageId: "",
    mirrorWebhookId: "",
    mirrorTelegramFileId: "",
    mirrorTelegramChatId: "",
    mirrorPending: !!mirrorTarget,
    mirrorError: ""
  };
}
