import mongoose from "mongoose";
import { connectDb } from "../db.js";
import { Archive } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { config } from "../config.js";
import { deleteWebhookMessage } from "../services/discord.js";
import { deleteTelegramMessage } from "../services/telegram.js";

type DeleteOutcome = "deleted" | "missing" | "failed" | "skipped";

type Stats = {
  archivesScanned: number;
  filesScanned: number;
  referencesFound: number;
  referencesDeleted: number;
  referencesMissing: number;
  referencesFailed: number;
  referencesSkipped: number;
  archivesUpdated: number;
  filesUpdated: number;
};

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const includeDeleted = args.has("--include-deleted");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Math.trunc(Number(limitArg.split("=")[1] || "0"))) : 0;

function nowIso() {
  return new Date().toISOString();
}

function log(message: string) {
  console.log(`[purge-subtitle-backups] ${nowIso()} ${message}`);
}

function isDiscordMissingError(message: string) {
  return /webhook_delete_failed:404:/i.test(message) || /Unknown Message/i.test(message);
}

function isTelegramMissingError(message: string) {
  return /telegram_delete_failed:400:/i.test(message) && /message to delete not found/i.test(message);
}

async function deleteDiscordRef(
  webhookUrl: string | undefined,
  messageId: string
): Promise<{ outcome: DeleteOutcome; error?: string }> {
  if (!webhookUrl || !messageId) {
    return { outcome: "skipped", error: "missing_webhook_or_message" };
  }
  try {
    await deleteWebhookMessage(webhookUrl, messageId);
    return { outcome: "deleted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "");
    if (isDiscordMissingError(message)) {
      return { outcome: "missing" };
    }
    return { outcome: "failed", error: message.slice(0, 400) };
  }
}

async function deleteTelegramRef(
  chatId: string | undefined,
  messageId: string
): Promise<{ outcome: DeleteOutcome; error?: string }> {
  if (!chatId || !messageId) {
    return { outcome: "skipped", error: "missing_chat_or_message" };
  }
  try {
    await deleteTelegramMessage(chatId, messageId);
    return { outcome: "deleted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "");
    if (isTelegramMissingError(message)) {
      return { outcome: "missing" };
    }
    return { outcome: "failed", error: message.slice(0, 400) };
  }
}

async function run() {
  await connectDb();
  const webhooks = await Webhook.find({}).lean();
  const webhookById = new Map<string, string>();
  for (const item of webhooks) {
    webhookById.set(String(item._id), String(item.url || ""));
  }

  const stats: Stats = {
    archivesScanned: 0,
    filesScanned: 0,
    referencesFound: 0,
    referencesDeleted: 0,
    referencesMissing: 0,
    referencesFailed: 0,
    referencesSkipped: 0,
    archivesUpdated: 0,
    filesUpdated: 0
  };

  const processedRefs = new Map<string, { outcome: DeleteOutcome; error?: string }>();

  const query: Record<string, unknown> = includeDeleted ? {} : { deletedAt: null };
  const cursor = Archive.find(query).cursor();

  let scanned = 0;
  for await (const archive of cursor) {
    if (limit > 0 && scanned >= limit) break;
    scanned += 1;
    stats.archivesScanned += 1;

    let archiveDirty = false;
    let archiveUpdatedFiles = 0;
    const files = Array.isArray((archive as any).files) ? (archive as any).files : [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      stats.filesScanned += 1;
      const file: any = files[fileIndex];
      const subtitle = file?.subtitle;
      if (!subtitle) continue;

      let fileDirty = false;
      const cleanPrimary = () => {
        subtitle.provider = null;
        subtitle.url = "";
        subtitle.messageId = "";
        subtitle.webhookId = "";
        subtitle.telegramFileId = "";
        subtitle.telegramChatId = "";
      };
      const cleanMirror = () => {
        subtitle.mirrorProvider = null;
        subtitle.mirrorUrl = "";
        subtitle.mirrorMessageId = "";
        subtitle.mirrorWebhookId = "";
        subtitle.mirrorTelegramFileId = "";
        subtitle.mirrorTelegramChatId = "";
        subtitle.mirrorPending = false;
        subtitle.mirrorError = "";
      };

      const processRef = async (
        provider: string,
        messageId: string,
        webhookId: string,
        telegramChatId: string
      ) => {
        stats.referencesFound += 1;
        const refKey = `${provider}:${webhookId || telegramChatId}:${messageId}`;
        const cached = processedRefs.get(refKey);
        if (cached) {
          return cached;
        }
        let result: { outcome: DeleteOutcome; error?: string };
        if (!apply) {
          result = { outcome: "deleted" };
        } else if (provider === "discord") {
          const webhookUrl = webhookById.get(webhookId) || "";
          result = await deleteDiscordRef(webhookUrl, messageId);
        } else if (provider === "telegram") {
          const chatId = telegramChatId || config.telegramChatId || "";
          result = await deleteTelegramRef(chatId, messageId);
        } else {
          result = { outcome: "skipped", error: "unknown_provider" };
        }
        processedRefs.set(refKey, result);
        return result;
      };

      const primaryProvider = String(subtitle.provider || "");
      const primaryMessageId = String(subtitle.messageId || "");
      if (primaryProvider && primaryMessageId) {
        const primaryResult = await processRef(
          primaryProvider,
          primaryMessageId,
          String(subtitle.webhookId || ""),
          String(subtitle.telegramChatId || "")
        );
        if (primaryResult.outcome === "deleted" || primaryResult.outcome === "missing") {
          cleanPrimary();
          fileDirty = true;
        }
        if (primaryResult.outcome === "deleted") stats.referencesDeleted += 1;
        if (primaryResult.outcome === "missing") stats.referencesMissing += 1;
        if (primaryResult.outcome === "failed") stats.referencesFailed += 1;
        if (primaryResult.outcome === "skipped") stats.referencesSkipped += 1;
      }

      const mirrorProvider = String(subtitle.mirrorProvider || "");
      const mirrorMessageId = String(subtitle.mirrorMessageId || "");
      if (mirrorProvider && mirrorMessageId) {
        const mirrorResult = await processRef(
          mirrorProvider,
          mirrorMessageId,
          String(subtitle.mirrorWebhookId || ""),
          String(subtitle.mirrorTelegramChatId || "")
        );
        if (mirrorResult.outcome === "deleted" || mirrorResult.outcome === "missing") {
          cleanMirror();
          fileDirty = true;
        }
        if (mirrorResult.outcome === "deleted") stats.referencesDeleted += 1;
        if (mirrorResult.outcome === "missing") stats.referencesMissing += 1;
        if (mirrorResult.outcome === "failed") stats.referencesFailed += 1;
        if (mirrorResult.outcome === "skipped") stats.referencesSkipped += 1;
      }

      if (fileDirty) {
        archiveDirty = true;
        archiveUpdatedFiles += 1;
      }
    }

    if (archiveDirty) {
      (archive as any).markModified("files");
      if (apply) {
        await archive.save();
      }
      stats.archivesUpdated += 1;
      stats.filesUpdated += archiveUpdatedFiles;
      log(`${apply ? "updated" : "would update"} archive=${archive.id} files=${archiveUpdatedFiles}`);
    }
  }

  log(
    `done mode=${apply ? "apply" : "dry-run"} archives=${stats.archivesScanned} files=${stats.filesScanned} refs_found=${stats.referencesFound} deleted=${stats.referencesDeleted} missing=${stats.referencesMissing} failed=${stats.referencesFailed} skipped=${stats.referencesSkipped} archives_updated=${stats.archivesUpdated} files_updated=${stats.filesUpdated}`
  );
}

run()
  .catch((err) => {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[purge-subtitle-backups] ${nowIso()} fatal ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
