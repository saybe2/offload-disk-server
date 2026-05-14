/*
 * TEMPORARY MIGRATION — converts thumbnails uploaded one-per-file (unencrypted)
 * into the new encrypted bundle format. Safe to remove this entire file plus
 * the call site in index.ts once every archive has been migrated.
 *
 * Migration runbook:
 *   1. Deploy this build to all running instances.
 *   2. Wait for `[thumb-bundle-migration]` log lines to stop reporting work.
 *   3. Verify Mongo:
 *        db.archives.countDocuments({ "files.thumbnail.messageId": { $nin: [null, ""] } })
 *      should return 0.
 *   4. Delete src/services/thumbnailBundleMigration.ts and remove the import
 *      and startThumbnailBundleMigration() call from src/index.ts.
 */

import fs from "fs";
import path from "path";
import { Archive, type ArchiveDoc } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { config } from "../config.js";
import {
  archiveBundleIsStale,
  buildAndUploadBundleForArchive,
  isPermanentBundleFailure,
  thumbLocalPath
} from "./thumbnailBundle.js";
import { downloadToFile, deleteWebhookMessage, fetchWebhookMessage } from "./discord.js";
import {
  buildTelegramFileUrl,
  deleteTelegramMessage
} from "./telegram.js";

let ticker: NodeJS.Timeout | null = null;
let busy = false;
let disabled = false;
const failureCooldown = new Map<string, number>();

const SCAN_LIMIT = 50;
const POLL_MS = 15_000;
const RETRY_AFTER_MS = 5 * 60_000;

function log(message: string) {
  console.log(`[thumb-bundle-migration] ${new Date().toISOString()} ${message}`);
}

export function isMigrationDisabled() {
  return disabled;
}

function resolveProvider(thumb: any): "discord" | "telegram" {
  if (String(thumb?.provider || "").toLowerCase() === "telegram") return "telegram";
  if (String(thumb?.webhookId || "").toLowerCase() === "telegram") return "telegram";
  return "discord";
}

function resolveMirrorProvider(thumb: any): "discord" | "telegram" | null {
  const raw = String(thumb?.mirrorProvider || "").toLowerCase();
  if (raw === "discord" || raw === "telegram") return raw;
  if (String(thumb?.mirrorWebhookId || "").toLowerCase() === "telegram") return "telegram";
  return null;
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

async function tryDownloadCopy(
  provider: "discord" | "telegram",
  url: string,
  messageId: string,
  webhookId: string,
  telegramFileId: string,
  destPath: string
) {
  let workingUrl = url;
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await downloadToFile(workingUrl, destPath);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!refreshed && /download_failed:(401|403|404)/.test(message)) {
        try {
          if (provider === "telegram") {
            workingUrl = await buildTelegramFileUrl(telegramFileId);
          } else {
            workingUrl = await refreshDiscordUrl(webhookId, messageId);
          }
          refreshed = true;
          continue;
        } catch {
          return false;
        }
      }
      if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return false;
    }
  }
  return false;
}

type LegacyRestoreResult =
  | { ok: true; localPath: string }
  | { ok: false; reason: "no_thumb_meta" | "download_failed" };

async function ensureLocalThumbFromLegacy(
  archive: ArchiveDoc,
  fileIndex: number
): Promise<LegacyRestoreResult> {
  const file: any = archive.files?.[fileIndex];
  if (!file?.thumbnail) return { ok: false, reason: "no_thumb_meta" };
  const localPath = thumbLocalPath(archive.id, fileIndex);
  if (fs.existsSync(localPath)) {
    return { ok: true, localPath };
  }
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  const thumb = file.thumbnail;
  const primaryProvider = resolveProvider(thumb);
  const primaryUrl = String(thumb?.url || "").trim();
  const primaryMessageId = String(thumb?.messageId || "").trim();
  if (primaryUrl && primaryMessageId) {
    const ok = await tryDownloadCopy(
      primaryProvider,
      primaryUrl,
      primaryMessageId,
      String(thumb?.webhookId || ""),
      String(thumb?.telegramFileId || ""),
      localPath
    );
    if (ok) {
      return { ok: true, localPath };
    }
  }

  const mirrorProvider = resolveMirrorProvider(thumb);
  const mirrorUrl = String(thumb?.mirrorUrl || "").trim();
  const mirrorMessageId = String(thumb?.mirrorMessageId || "").trim();
  if (mirrorProvider && mirrorUrl && mirrorMessageId) {
    const ok = await tryDownloadCopy(
      mirrorProvider,
      mirrorUrl,
      mirrorMessageId,
      String(thumb?.mirrorWebhookId || ""),
      String(thumb?.mirrorTelegramFileId || ""),
      localPath
    );
    if (ok) {
      return { ok: true, localPath };
    }
  }

  return { ok: false, reason: "download_failed" };
}

async function deleteLegacyCopy(
  provider: "discord" | "telegram",
  messageId: string,
  webhookId: string,
  telegramChatId: string,
  hookById: Map<string, string>
) {
  if (!messageId) return;
  if (provider === "telegram") {
    const chatId = telegramChatId || config.telegramChatId || "";
    if (!chatId) return;
    try {
      await deleteTelegramMessage(chatId, messageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Treat already-deleted as success.
      if (!/telegram_delete_failed:(400|404)/.test(message)) {
        throw err;
      }
    }
    return;
  }
  const hookUrl = hookById.get(webhookId);
  if (!hookUrl) return;
  try {
    await deleteWebhookMessage(hookUrl, messageId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/webhook_delete_failed:(404|410)/.test(message)) {
      throw err;
    }
  }
}

async function deleteAllLegacyCopiesForFile(thumb: any, hookById: Map<string, string>) {
  const primaryProvider = resolveProvider(thumb);
  const primaryMessageId = String(thumb?.messageId || "");
  if (primaryMessageId) {
    await deleteLegacyCopy(
      primaryProvider,
      primaryMessageId,
      String(thumb?.webhookId || ""),
      String(thumb?.telegramChatId || ""),
      hookById
    );
  }
  const mirrorProvider = resolveMirrorProvider(thumb);
  const mirrorMessageId = String(thumb?.mirrorMessageId || "");
  if (mirrorProvider && mirrorMessageId) {
    await deleteLegacyCopy(
      mirrorProvider,
      mirrorMessageId,
      String(thumb?.mirrorWebhookId || ""),
      String(thumb?.mirrorTelegramChatId || ""),
      hookById
    );
  }
}

async function clearLegacyProviderFields(archiveId: string, fileIndex: number) {
  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.thumbnail.provider`]: null,
        [`files.${fileIndex}.thumbnail.url`]: "",
        [`files.${fileIndex}.thumbnail.messageId`]: "",
        [`files.${fileIndex}.thumbnail.webhookId`]: "",
        [`files.${fileIndex}.thumbnail.telegramFileId`]: "",
        [`files.${fileIndex}.thumbnail.telegramChatId`]: "",
        [`files.${fileIndex}.thumbnail.mirrorProvider`]: null,
        [`files.${fileIndex}.thumbnail.mirrorUrl`]: "",
        [`files.${fileIndex}.thumbnail.mirrorMessageId`]: "",
        [`files.${fileIndex}.thumbnail.mirrorWebhookId`]: "",
        [`files.${fileIndex}.thumbnail.mirrorTelegramFileId`]: "",
        [`files.${fileIndex}.thumbnail.mirrorTelegramChatId`]: "",
        [`files.${fileIndex}.thumbnail.mirrorPending`]: false,
        [`files.${fileIndex}.thumbnail.mirrorError`]: ""
      }
    }
  );
}

function bundleContainsFile(archive: any, fileIndex: number) {
  const entries = archive?.thumbnailBundle?.entries;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry: any) => Number(entry?.fileIndex) === fileIndex);
}

async function migrateArchive(archiveId: string): Promise<{ migratedFiles: number; deferred: boolean }> {
  const archive = await Archive.findById(archiveId);
  if (!archive) return { migratedFiles: 0, deferred: false };
  if (archive.deletedAt || archive.trashedAt) return { migratedFiles: 0, deferred: false };

  const legacyIndices: number[] = [];
  for (let i = 0; i < archive.files.length; i += 1) {
    const messageId = String((archive.files[i] as any)?.thumbnail?.messageId || "").trim();
    if (messageId) {
      legacyIndices.push(i);
    }
  }
  if (legacyIndices.length === 0) {
    return { migratedFiles: 0, deferred: false };
  }

  log(`start ${archiveId} legacy=${legacyIndices.length}`);

  // Step 1: pull each legacy thumbnail into local cache so the bundle can be built.
  const restoredIndices: number[] = [];
  for (const idx of legacyIndices) {
    const restoreResult = await ensureLocalThumbFromLegacy(archive, idx);
    if (restoreResult.ok) {
      restoredIndices.push(idx);
      // Mark the local thumbnail as registered so the bundle picks it up.
      const stat = await fs.promises.stat(restoreResult.localPath).catch(() => null);
      const updates: Record<string, unknown> = {
        [`files.${idx}.thumbnail.localPath`]: restoreResult.localPath
      };
      if (stat?.size && stat.size > 0) {
        updates[`files.${idx}.thumbnail.size`] = stat.size;
      }
      if (!(archive.files[idx] as any)?.thumbnail?.updatedAt) {
        updates[`files.${idx}.thumbnail.updatedAt`] = new Date();
      }
      await Archive.updateOne({ _id: archive.id }, { $set: updates });
    } else {
      log(`legacy download failed ${archiveId} file=${idx}`);
    }
  }

  if (restoredIndices.length === 0) {
    log(`abort ${archiveId} no_restorable_thumbnails`);
    return { migratedFiles: 0, deferred: true };
  }

  // Step 2: rebuild and upload the encrypted bundle.
  const fresh = await Archive.findById(archive.id);
  if (!fresh) return { migratedFiles: 0, deferred: false };
  if (archiveBundleIsStale(fresh) || !fresh.thumbnailBundle?.messageId) {
    try {
      await buildAndUploadBundleForArchive(fresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanentBundleFailure(message)) {
        await Archive.updateOne(
          { _id: archive.id },
          { $set: { "thumbnailBundle.rebuildError": message.slice(0, 500), "thumbnailBundle.needsRebuild": false } }
        );
        log(`bundle permanent failure ${archiveId} ${message}`);
        return { migratedFiles: 0, deferred: true };
      }
      log(`bundle build failed ${archiveId} ${message}`);
      await Archive.updateOne(
        { _id: archive.id },
        { $set: { "thumbnailBundle.needsRebuild": true, "thumbnailBundle.rebuildError": message.slice(0, 500) } }
      );
      return { migratedFiles: 0, deferred: true };
    }
  }

  // Step 3: drop the legacy copies from Discord/Telegram now that the bundle is safe.
  const reloaded = await Archive.findById(archive.id);
  if (!reloaded) return { migratedFiles: 0, deferred: false };
  const hooks = await Webhook.find().lean();
  const hookById = new Map(hooks.map((h: any) => [String(h._id), String(h.url || "")]));

  let migratedFiles = 0;
  for (const idx of legacyIndices) {
    const fileThumb: any = reloaded.files?.[idx]?.thumbnail;
    if (!fileThumb) continue;
    const stillLegacy = String(fileThumb?.messageId || "").trim();
    if (!stillLegacy) {
      continue;
    }
    if (!bundleContainsFile(reloaded, idx)) {
      // Bundle does not include this file (maybe local thumb missing). Skip deletion to avoid loss.
      continue;
    }
    try {
      await deleteAllLegacyCopiesForFile(fileThumb, hookById);
      await clearLegacyProviderFields(reloaded.id, idx);
      migratedFiles += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`legacy delete failed ${archiveId} file=${idx} ${message}`);
    }
  }

  log(`done ${archiveId} migrated=${migratedFiles}/${legacyIndices.length}`);
  return { migratedFiles, deferred: migratedFiles < legacyIndices.length };
}

export async function migrateThumbnailsForArchive(archiveId: string) {
  return migrateArchive(archiveId);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const candidates = await Archive.find({
      deletedAt: null,
      trashedAt: null,
      "files.thumbnail.messageId": { $exists: true, $nin: [null, ""] }
    })
      .sort({ updatedAt: 1, createdAt: 1 })
      .select("_id")
      .limit(SCAN_LIMIT)
      .lean();

    let processedAny = false;
    for (const candidate of candidates) {
      const id = String(candidate._id);
      const waitUntil = failureCooldown.get(id) || 0;
      if (waitUntil > now) continue;
      try {
        const result = await migrateArchive(id);
        processedAny = true;
        if (result.deferred) {
          failureCooldown.set(id, Date.now() + RETRY_AFTER_MS);
        } else if (result.migratedFiles === 0) {
          failureCooldown.set(id, Date.now() + RETRY_AFTER_MS);
        } else {
          failureCooldown.delete(id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`error ${id} ${message}`);
        failureCooldown.set(id, Date.now() + RETRY_AFTER_MS);
      }
    }

    if (!processedAny) {
      // Nothing matched the legacy query — migration is effectively done for now.
      // Keep polling at a slow cadence in case other instances upload data again.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`tick error ${message}`);
  } finally {
    busy = false;
  }
}

export function startThumbnailBundleMigration() {
  if (disabled) return;
  if (ticker) return;
  ticker = setInterval(() => {
    void tick();
  }, POLL_MS);
  // Run an immediate first sweep on startup.
  void tick();
  log(`started poll=${POLL_MS}ms scanLimit=${SCAN_LIMIT}`);
}

export function stopThumbnailBundleMigration() {
  disabled = true;
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
