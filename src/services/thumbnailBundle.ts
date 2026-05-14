import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Archive, type ArchiveDoc, type ArchiveThumbnailBundleEntry } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { config } from "../config.js";
import { deriveKey } from "./crypto.js";
import {
  deleteWebhookMessage,
  fetchWebhookMessage,
  uploadBufferToWebhook
} from "./discord.js";
import {
  buildTelegramFileUrl,
  deleteTelegramMessage,
  isTelegramReady,
  uploadBufferToTelegram
} from "./telegram.js";
import { outboundFetch } from "./outbound.js";

const MAGIC = Buffer.from("TBND", "ascii");
const HEADER_BYTES = 16;
const ENTRY_BYTES = 16;
const VERSION = 1;
const BUNDLE_PERMANENT_PREFIX = "thumbnail_bundle_permanent_failure:";

export type ThumbnailBundleEntry = ArchiveThumbnailBundleEntry;

type ProviderCopy = {
  provider: "discord" | "telegram";
  url: string;
  messageId: string;
  webhookId: string;
  telegramFileId: string;
  telegramChatId: string;
};

function thumbLocalPath(archiveId: string, fileIndex: number) {
  return path.join(config.cacheDir, "thumbs", `${archiveId}_${fileIndex}.webp`);
}

function toMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err || "");
}

export function isPermanentBundleFailure(message: string) {
  return !!message && message.startsWith(BUNDLE_PERMANENT_PREFIX);
}

function makePermanentBundleFailure(message: string) {
  return new Error(`${BUNDLE_PERMANENT_PREFIX}${message}`.slice(0, 1200));
}

function isDownloadAuthExpired(message: string) {
  return /download_failed:(401|403|404)/.test(message);
}

function isDownloadTransient(message: string) {
  if (/download_failed:(429|5\d\d)/.test(message)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function pickWebhook(webhooks: Array<{ _id: any; id?: string; url: string }>, archiveId: string) {
  if (webhooks.length === 0) return null;
  let acc = 0;
  for (const ch of archiveId) acc = (acc + ch.charCodeAt(0)) >>> 0;
  return webhooks[acc % webhooks.length];
}

export function encodeBundlePlaintext(
  entries: Array<{ fileIndex: number; data: Buffer }>
) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(VERSION, 4);
  header.writeUInt32BE(entries.length, 8);
  // 4 bytes reserved at offset 12

  const table = Buffer.alloc(ENTRY_BYTES * entries.length);
  let cursor = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const size = entry.data.length;
    table.writeInt32BE(entry.fileIndex, i * ENTRY_BYTES + 0);
    table.writeUInt32BE(cursor, i * ENTRY_BYTES + 4);
    table.writeUInt32BE(size, i * ENTRY_BYTES + 8);
    // 4 bytes reserved at +12
    cursor += size;
  }

  const payload = Buffer.concat(entries.map((e) => e.data));
  return Buffer.concat([header, table, payload]);
}

export type BundleParseEntry = {
  fileIndex: number;
  offset: number;
  size: number;
};

export function parseBundlePlaintext(buffer: Buffer) {
  if (buffer.length < HEADER_BYTES) {
    throw new Error("thumbnail_bundle_truncated_header");
  }
  if (!MAGIC.equals(buffer.subarray(0, 4))) {
    throw new Error("thumbnail_bundle_bad_magic");
  }
  const version = buffer.readUInt32BE(4);
  if (version !== VERSION) {
    throw new Error(`thumbnail_bundle_bad_version:${version}`);
  }
  const count = buffer.readUInt32BE(8);
  if (count > 1_000_000) {
    throw new Error(`thumbnail_bundle_bad_count:${count}`);
  }
  const tableBytes = ENTRY_BYTES * count;
  if (buffer.length < HEADER_BYTES + tableBytes) {
    throw new Error("thumbnail_bundle_truncated_table");
  }
  const entries: BundleParseEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = HEADER_BYTES + i * ENTRY_BYTES;
    entries.push({
      fileIndex: buffer.readInt32BE(base + 0),
      offset: buffer.readUInt32BE(base + 4),
      size: buffer.readUInt32BE(base + 8)
    });
  }
  const payloadStart = HEADER_BYTES + tableBytes;
  for (const entry of entries) {
    if (payloadStart + entry.offset + entry.size > buffer.length) {
      throw new Error("thumbnail_bundle_truncated_payload");
    }
  }
  return { entries, payloadStart };
}

function encryptBuffer(plain: Buffer, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64")
  };
}

function decryptBuffer(encrypted: Buffer, ivB64: string, authTagB64: string, key: Buffer) {
  if (!ivB64 || !authTagB64) {
    throw new Error("thumbnail_bundle_unencrypted");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function uploadBundleToWebhook(
  buffer: Buffer,
  filename: string,
  webhook: { _id: any; id?: string; url: string },
  archiveId: string
): Promise<ProviderCopy> {
  const result = await uploadBufferToWebhook(
    buffer,
    filename,
    webhook.url,
    `archive:${archiveId} thumbnail_bundle`
  );
  return {
    provider: "discord",
    url: result.url,
    messageId: result.messageId,
    webhookId: String(webhook._id || webhook.id || ""),
    telegramFileId: "",
    telegramChatId: ""
  };
}

async function uploadBundleToTelegram(
  buffer: Buffer,
  filename: string,
  archiveId: string
): Promise<ProviderCopy> {
  const uploaded = await uploadBufferToTelegram(
    buffer,
    filename,
    `archive:${archiveId} thumbnail_bundle`
  );
  return {
    provider: "telegram",
    url: uploaded.url,
    messageId: uploaded.messageId,
    webhookId: "telegram",
    telegramFileId: uploaded.fileId,
    telegramChatId: uploaded.chatId
  };
}

async function uploadBundleEverywhere(
  encrypted: Buffer,
  filename: string,
  archiveId: string
) {
  const webhooks = await Webhook.find({ enabled: true }).lean();
  const tgReady = isTelegramReady();
  const copies: ProviderCopy[] = [];

  if (webhooks.length > 0) {
    const pick = pickWebhook(webhooks as any, archiveId);
    if (pick) {
      try {
        copies.push(await uploadBundleToWebhook(encrypted, filename, pick as any, archiveId));
      } catch {
        // continue to telegram
      }
    }
  }

  if (tgReady) {
    try {
      copies.push(await uploadBundleToTelegram(encrypted, filename, archiveId));
    } catch {
      // keep discord copy if it succeeded
    }
  }

  if (copies.length === 0) {
    return null;
  }
  const primary = copies.find((c) => c.provider === "discord") || copies[0];
  const mirror = copies.find((c) => c.provider !== primary.provider) || null;
  return { primary, mirror };
}

async function deleteCopyFromRemote(
  provider: "discord" | "telegram",
  messageId: string,
  webhookId: string,
  telegramChatId: string
) {
  if (!messageId) return;
  if (provider === "telegram") {
    const chatId = telegramChatId || config.telegramChatId || "";
    if (!chatId) return;
    try {
      await deleteTelegramMessage(chatId, messageId);
    } catch {
      // best-effort
    }
    return;
  }
  if (!webhookId) return;
  const hook = await Webhook.findById(webhookId).lean();
  if (!hook?.url) return;
  try {
    await deleteWebhookMessage(hook.url, messageId);
  } catch {
    // best-effort
  }
}

export async function deleteBundleFromRemote(bundle: {
  provider?: string;
  messageId?: string;
  webhookId?: string;
  telegramChatId?: string;
  mirrorProvider?: string;
  mirrorMessageId?: string;
  mirrorWebhookId?: string;
  mirrorTelegramChatId?: string;
}) {
  const provider = (bundle.provider as "discord" | "telegram" | undefined) || undefined;
  if (provider && bundle.messageId) {
    await deleteCopyFromRemote(
      provider,
      String(bundle.messageId || ""),
      String(bundle.webhookId || ""),
      String(bundle.telegramChatId || "")
    );
  }
  const mirrorProvider = (bundle.mirrorProvider as "discord" | "telegram" | undefined) || undefined;
  if (mirrorProvider && bundle.mirrorMessageId) {
    await deleteCopyFromRemote(
      mirrorProvider,
      String(bundle.mirrorMessageId || ""),
      String(bundle.mirrorWebhookId || ""),
      String(bundle.mirrorTelegramChatId || "")
    );
  }
}

function localThumbnailEligible(file: any) {
  if (file?.deletedAt) return false;
  if (!file?.thumbnail?.updatedAt) return false;
  if (file?.thumbnail?.failedAt) return false;
  return true;
}

async function readLocalThumbnailsForArchive(archive: ArchiveDoc) {
  const items: Array<{ fileIndex: number; data: Buffer; contentType: string }> = [];
  for (let i = 0; i < archive.files.length; i += 1) {
    const file: any = archive.files[i];
    if (!localThumbnailEligible(file)) continue;
    const filePath = String(file?.thumbnail?.localPath || "").trim() || thumbLocalPath(archive.id, i);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = await fs.promises.readFile(filePath);
      if (data.length === 0) continue;
      items.push({
        fileIndex: i,
        data,
        contentType: String(file?.thumbnail?.contentType || "image/webp") || "image/webp"
      });
    } catch {
      // skip unreadable thumbs
    }
  }
  return items;
}

export type BuildAndUploadResult = {
  uploaded: boolean;
  reason?: string;
};

export async function buildAndUploadBundleForArchive(archive: ArchiveDoc): Promise<BuildAndUploadResult> {
  const items = await readLocalThumbnailsForArchive(archive);
  const oldBundle = (archive.thumbnailBundle as any) || null;

  if (items.length === 0) {
    if (oldBundle?.messageId) {
      // No local thumbnails left; drop the remote bundle to avoid stale data.
      await deleteBundleFromRemote(oldBundle).catch(() => undefined);
      await Archive.updateOne(
        { _id: archive.id },
        {
          $set: {
            "thumbnailBundle.provider": null,
            "thumbnailBundle.url": "",
            "thumbnailBundle.messageId": "",
            "thumbnailBundle.webhookId": "",
            "thumbnailBundle.telegramFileId": "",
            "thumbnailBundle.telegramChatId": "",
            "thumbnailBundle.mirrorProvider": null,
            "thumbnailBundle.mirrorUrl": "",
            "thumbnailBundle.mirrorMessageId": "",
            "thumbnailBundle.mirrorWebhookId": "",
            "thumbnailBundle.mirrorTelegramFileId": "",
            "thumbnailBundle.mirrorTelegramChatId": "",
            "thumbnailBundle.mirrorPending": false,
            "thumbnailBundle.mirrorError": "",
            "thumbnailBundle.iv": "",
            "thumbnailBundle.authTag": "",
            "thumbnailBundle.encryptedSize": 0,
            "thumbnailBundle.plainSize": 0,
            "thumbnailBundle.entries": [],
            "thumbnailBundle.needsRebuild": false,
            "thumbnailBundle.rebuildError": "",
            "thumbnailBundle.updatedAt": new Date()
          }
        }
      );
    } else {
      await Archive.updateOne(
        { _id: archive.id },
        { $set: { "thumbnailBundle.needsRebuild": false, "thumbnailBundle.rebuildError": "" } }
      );
    }
    return { uploaded: false, reason: "no_local_thumbnails" };
  }

  const plain = encodeBundlePlaintext(items.map((it) => ({ fileIndex: it.fileIndex, data: it.data })));
  const key = deriveKey(config.masterKey);
  const { encrypted, iv, authTag } = encryptBuffer(plain, key);
  const filename = `thumbbundle_${archive.id}.bin`;

  // Discord webhook limit is around 10 MiB. If we exceed it, log a warning;
  // upload may still succeed via Telegram alone (limit 50 MiB for bots).
  const webhookMax = Math.floor(config.webhookMaxMiB * 1024 * 1024);
  if (encrypted.length > webhookMax) {
    // Continue, but Telegram mirror is required.
    if (!isTelegramReady()) {
      throw makePermanentBundleFailure(
        `bundle_too_large_for_discord:${encrypted.length}>${webhookMax}_no_telegram`
      );
    }
  }

  const uploaded = await uploadBundleEverywhere(encrypted, filename, archive.id);
  if (!uploaded) {
    throw new Error("bundle_upload_failed_no_providers");
  }

  const entries: ThumbnailBundleEntry[] = items.map((it) => ({
    fileIndex: it.fileIndex,
    size: it.data.length,
    contentType: it.contentType
  }));

  await Archive.updateOne(
    { _id: archive.id },
    {
      $set: {
        "thumbnailBundle.provider": uploaded.primary.provider,
        "thumbnailBundle.url": uploaded.primary.url,
        "thumbnailBundle.messageId": uploaded.primary.messageId,
        "thumbnailBundle.webhookId": uploaded.primary.webhookId,
        "thumbnailBundle.telegramFileId": uploaded.primary.telegramFileId,
        "thumbnailBundle.telegramChatId": uploaded.primary.telegramChatId,
        "thumbnailBundle.mirrorProvider": uploaded.mirror?.provider || null,
        "thumbnailBundle.mirrorUrl": uploaded.mirror?.url || "",
        "thumbnailBundle.mirrorMessageId": uploaded.mirror?.messageId || "",
        "thumbnailBundle.mirrorWebhookId": uploaded.mirror?.webhookId || "",
        "thumbnailBundle.mirrorTelegramFileId": uploaded.mirror?.telegramFileId || "",
        "thumbnailBundle.mirrorTelegramChatId": uploaded.mirror?.telegramChatId || "",
        "thumbnailBundle.mirrorPending": false,
        "thumbnailBundle.mirrorError": "",
        "thumbnailBundle.iv": iv,
        "thumbnailBundle.authTag": authTag,
        "thumbnailBundle.encryptedSize": encrypted.length,
        "thumbnailBundle.plainSize": plain.length,
        "thumbnailBundle.entries": entries,
        "thumbnailBundle.needsRebuild": false,
        "thumbnailBundle.rebuildError": "",
        "thumbnailBundle.updatedAt": new Date()
      }
    }
  );

  // Delete the previous remote bundle copies, if any, so storage doesn't pile up.
  if (oldBundle?.messageId) {
    await deleteBundleFromRemote(oldBundle).catch(() => undefined);
  }

  return { uploaded: true };
}

export function markBundleNeedsRebuild(archiveId: string) {
  return Archive.updateOne(
    { _id: archiveId },
    { $set: { "thumbnailBundle.needsRebuild": true } }
  ).catch(() => undefined);
}

async function fetchBuffer(url: string) {
  const res = await outboundFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`download_failed:${res.status}:${text}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function refreshDiscordBundleUrl(webhookId: string, messageId: string) {
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

async function refreshBundlePrimaryUrl(archiveId: string, bundle: any) {
  const provider = String(bundle?.provider || "").toLowerCase();
  const freshUrl =
    provider === "telegram"
      ? await buildTelegramFileUrl(String(bundle?.telegramFileId || ""))
      : await refreshDiscordBundleUrl(String(bundle?.webhookId || ""), String(bundle?.messageId || ""));
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { "thumbnailBundle.url": freshUrl } }
  );
  bundle.url = freshUrl;
  return freshUrl;
}

async function refreshBundleMirrorUrl(archiveId: string, bundle: any) {
  const provider = String(bundle?.mirrorProvider || "").toLowerCase();
  if (provider !== "telegram" && provider !== "discord") {
    throw new Error("missing_mirror_provider");
  }
  const freshUrl =
    provider === "telegram"
      ? await buildTelegramFileUrl(String(bundle?.mirrorTelegramFileId || ""))
      : await refreshDiscordBundleUrl(String(bundle?.mirrorWebhookId || ""), String(bundle?.mirrorMessageId || ""));
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { "thumbnailBundle.mirrorUrl": freshUrl } }
  );
  bundle.mirrorUrl = freshUrl;
  return freshUrl;
}

async function downloadBundleCopy(
  url: string,
  refreshUrl: () => Promise<string>
) {
  let refreshed = false;
  let currentUrl = url;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchBuffer(currentUrl);
    } catch (err) {
      const message = toMessage(err);
      if (!refreshed && isDownloadAuthExpired(message)) {
        currentUrl = await refreshUrl();
        refreshed = true;
        continue;
      }
      if (isDownloadTransient(message) && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error("bundle_download_exhausted");
}

export async function downloadAndDecryptBundle(archive: ArchiveDoc): Promise<Buffer | null> {
  const bundle = (archive.thumbnailBundle as any) || null;
  if (!bundle?.iv || !bundle?.authTag) {
    return null;
  }
  const primaryUrl = String(bundle?.url || "");
  const primaryMessageId = String(bundle?.messageId || "");
  const mirrorUrl = String(bundle?.mirrorUrl || "");
  const mirrorMessageId = String(bundle?.mirrorMessageId || "");
  const key = deriveKey(config.masterKey);

  let encrypted: Buffer | null = null;
  if (primaryUrl && primaryMessageId) {
    try {
      encrypted = await downloadBundleCopy(primaryUrl, () => refreshBundlePrimaryUrl(archive.id, bundle));
    } catch {
      encrypted = null;
    }
  }
  if (!encrypted && mirrorUrl && mirrorMessageId) {
    try {
      encrypted = await downloadBundleCopy(mirrorUrl, () => refreshBundleMirrorUrl(archive.id, bundle));
    } catch {
      encrypted = null;
    }
  }
  if (!encrypted) {
    return null;
  }
  return decryptBuffer(encrypted, String(bundle.iv), String(bundle.authTag), key);
}

export async function restoreThumbnailsFromBundleToCache(
  archive: ArchiveDoc,
  requestedFileIndex?: number
): Promise<{ restored: number; targetExists: boolean }> {
  const plain = await downloadAndDecryptBundle(archive);
  if (!plain) {
    return { restored: 0, targetExists: false };
  }
  const parsed = parseBundlePlaintext(plain);
  const thumbsDir = path.join(config.cacheDir, "thumbs");
  await fs.promises.mkdir(thumbsDir, { recursive: true });

  let restored = 0;
  let targetExists = false;
  for (const entry of parsed.entries) {
    const dst = thumbLocalPath(archive.id, entry.fileIndex);
    const begin = parsed.payloadStart + entry.offset;
    const slice = plain.subarray(begin, begin + entry.size);
    try {
      await fs.promises.writeFile(dst, slice);
      restored += 1;
      if (entry.fileIndex === requestedFileIndex) {
        targetExists = true;
      }
    } catch {
      // best-effort write
    }
  }
  return { restored, targetExists };
}

export function archiveBundleIsStale(archive: any) {
  const bundle = archive?.thumbnailBundle;
  if (!bundle) return false;
  if (bundle.needsRebuild) return true;
  const bundleAt = bundle.updatedAt ? new Date(bundle.updatedAt).getTime() : 0;
  let mostRecent = 0;
  for (const file of archive?.files || []) {
    const ts = file?.thumbnail?.updatedAt;
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (t > mostRecent) mostRecent = t;
  }
  if (mostRecent === 0) return false;
  return mostRecent > bundleAt;
}

export { thumbLocalPath };
