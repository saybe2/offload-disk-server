import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import sharp from "sharp";
import { Archive, type ArchiveDoc } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { config } from "../config.js";
import { downloadToFile, fetchWebhookMessage } from "./discord.js";
import { restoreArchiveFileToFile, restoreArchiveToFile } from "./restore.js";
import { noteThumbnailDone, noteThumbnailError, noteThumbnailStarted } from "./analytics.js";
import { canServerRenderHeif, renderImageToWebp } from "./imageRerender.js";
import { buildTelegramFileUrl } from "./telegram.js";
import { restoreThumbnailsFromBundleToCache } from "./thumbnailBundle.js";

const imageExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif"]);
const videoExt = new Set([".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".wmv", ".flv", ".mpeg", ".mpg", ".m2ts", ".3gp", ".ogv", ".vob", ".ts"]);
const inFlight = new Map<string, Promise<ThumbnailResult>>();
const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

export interface ThumbnailResult {
  filePath: string;
  contentType: string;
  size: number;
}

const THUMB_PERMANENT_PREFIX = "thumbnail_permanent_failure:";

function toMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err || "");
}

export function isPermanentThumbnailFailureMessage(message: string) {
  if (!message) return false;
  if (message.startsWith(THUMB_PERMANENT_PREFIX)) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes("part_crypto_missing") ||
    lower.includes("file_not_found") ||
    lower.includes("bundle stream parse error") ||
    lower.includes("zip parse guard invalid signature") ||
    lower.includes("download_failed:404") ||
    lower.includes("vipsjpeg: invalid sos parameters") ||
    lower.includes("invalid sos parameters") ||
    lower.includes("input file contains unsupported image format") ||
    lower.includes("heif: error while loading plugin") ||
    lower.includes("support for this compression format has not been built in") ||
    lower.includes("thumbnail_heif_unsupported_runtime") ||
    lower.includes("corrupt jpeg") ||
    lower.includes("invalid data found when processing input")
  );
}

function makePermanentThumbnailFailure(message: string) {
  return new Error(`${THUMB_PERMANENT_PREFIX}${message}`.slice(0, 1200));
}

function extOf(fileName: string) {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isHeif(fileName: string) {
  const ext = extOf(fileName);
  return ext === ".heic" || ext === ".heif";
}

export function canRetryThumbnailFailure(fileName: string, message: string) {
  if (!isHeif(fileName)) return false;
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("thumbnail_heif_unsupported_runtime") ||
    lower.includes("heif: error while loading plugin") ||
    lower.includes("support for this compression format has not been built in")
  );
}

async function clearThumbnailFailure(archiveId: string, fileIndex: number) {
  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.thumbnail.failedAt`]: null,
        [`files.${fileIndex}.thumbnail.error`]: "",
        [`files.${fileIndex}.thumbnail.updatedAt`]: null
      }
    }
  );
}

function isImage(fileName: string) {
  if (isHeif(fileName) && !canServerRenderHeif()) return false;
  return imageExt.has(extOf(fileName));
}

function isVideo(fileName: string, detectedKind?: string) {
  if (detectedKind === "video") return true;
  if (detectedKind && detectedKind !== "video") return false;
  const ext = extOf(fileName);
  if (ext === ".ts") return false;
  return videoExt.has(ext);
}

export function supportsThumbnail(fileName: string, detectedKind?: string) {
  if (isHeif(fileName) && !canServerRenderHeif()) return false;
  if (detectedKind === "image") return true;
  if (detectedKind === "video") return true;
  if (detectedKind && detectedKind !== "image" && detectedKind !== "video") return false;
  return isImage(fileName) || isVideo(fileName, detectedKind);
}

function thumbTargetPath(archiveId: string, fileIndex: number) {
  return path.join(config.cacheDir, "thumbs", `${archiveId}_${fileIndex}.webp`);
}

type ThumbCopy = {
  provider: "discord" | "telegram";
  url: string;
  messageId: string;
  webhookId: string;
  telegramFileId: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isDownloadAuthExpired(message: string) {
  return /download_failed:(401|403|404)/.test(message);
}

function isDownloadTransient(message: string) {
  if (/download_failed:(429|5\d\d)/.test(message)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message);
}

function resolveThumbProvider(thumb: any): "discord" | "telegram" {
  if (String(thumb?.provider || "").toLowerCase() === "telegram") return "telegram";
  if (String(thumb?.webhookId || "").toLowerCase() === "telegram") return "telegram";
  return "discord";
}

function resolveThumbMirrorProvider(thumb: any): "discord" | "telegram" | null {
  const raw = String(thumb?.mirrorProvider || "").toLowerCase();
  if (raw === "discord" || raw === "telegram") return raw;
  if (String(thumb?.mirrorWebhookId || "").toLowerCase() === "telegram") return "telegram";
  return null;
}

async function refreshDiscordThumbUrl(webhookId: string, messageId: string) {
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

async function refreshPrimaryThumbUrl(archiveId: string, fileIndex: number, thumb: any) {
  const provider = resolveThumbProvider(thumb);
  const freshUrl =
    provider === "telegram"
      ? await buildTelegramFileUrl(String(thumb?.telegramFileId || ""))
      : await refreshDiscordThumbUrl(String(thumb?.webhookId || ""), String(thumb?.messageId || ""));
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { [`files.${fileIndex}.thumbnail.url`]: freshUrl, [`files.${fileIndex}.thumbnail.updatedAt`]: new Date() } }
  );
  thumb.url = freshUrl;
  return freshUrl;
}

async function refreshMirrorThumbUrl(archiveId: string, fileIndex: number, thumb: any) {
  const provider = resolveThumbMirrorProvider(thumb);
  if (!provider) {
    throw new Error("missing_mirror_provider");
  }
  const freshUrl =
    provider === "telegram"
      ? await buildTelegramFileUrl(String(thumb?.mirrorTelegramFileId || ""))
      : await refreshDiscordThumbUrl(
          String(thumb?.mirrorWebhookId || ""),
          String(thumb?.mirrorMessageId || "")
        );
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { [`files.${fileIndex}.thumbnail.mirrorUrl`]: freshUrl, [`files.${fileIndex}.thumbnail.updatedAt`]: new Date() } }
  );
  thumb.mirrorUrl = freshUrl;
  return freshUrl;
}

async function downloadThumbCopy(
  copy: ThumbCopy,
  localPath: string,
  refreshUrl?: () => Promise<string>
) {
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await downloadToFile(copy.url, localPath);
      return true;
    } catch (err) {
      const message = toMessage(err);
      if (!refreshed && refreshUrl && isDownloadAuthExpired(message)) {
        copy.url = await refreshUrl();
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
  return false;
}

async function tryRestoreThumbFromBundle(archive: ArchiveDoc, fileIndex: number, localPath: string) {
  const bundle = (archive as any)?.thumbnailBundle;
  if (!bundle?.iv || !bundle?.authTag) {
    return false;
  }
  try {
    const result = await restoreThumbnailsFromBundleToCache(archive, fileIndex);
    if (result.targetExists) {
      return true;
    }
    return fs.existsSync(localPath);
  } catch {
    return false;
  }
}

async function tryRestoreThumbFromRemote(
  archive: ArchiveDoc,
  fileIndex: number,
  localPath: string
) {
  if (await tryRestoreThumbFromBundle(archive, fileIndex, localPath)) {
    return true;
  }

  // Legacy fallback: archives whose thumbnails were uploaded one-per-file
  // before the bundle migration ran still carry the old provider details.
  const thumb = archive.files?.[fileIndex]?.thumbnail;
  if (!thumb) {
    return false;
  }

  const primaryCopy: ThumbCopy | null =
    thumb.url && thumb.messageId
      ? {
          provider: resolveThumbProvider(thumb),
          url: String(thumb.url || ""),
          messageId: String(thumb.messageId || ""),
          webhookId: String(thumb.webhookId || ""),
          telegramFileId: String(thumb.telegramFileId || "")
        }
      : null;

  if (primaryCopy) {
    try {
      return await downloadThumbCopy(primaryCopy, localPath, () => refreshPrimaryThumbUrl(archive.id, fileIndex, thumb));
    } catch {
      // try mirror below
    }
  }

  const mirrorProvider = resolveThumbMirrorProvider(thumb);
  const mirrorCopy: ThumbCopy | null =
    mirrorProvider && thumb.mirrorUrl && thumb.mirrorMessageId
      ? {
          provider: mirrorProvider,
          url: String(thumb.mirrorUrl || ""),
          messageId: String(thumb.mirrorMessageId || ""),
          webhookId: String(thumb.mirrorWebhookId || ""),
          telegramFileId: String(thumb.mirrorTelegramFileId || "")
        }
      : null;

  if (!mirrorCopy) {
    return false;
  }
  try {
    return await downloadThumbCopy(mirrorCopy, localPath, () => refreshMirrorThumbUrl(archive.id, fileIndex, thumb));
  } catch {
    return false;
  }
}

function spawnFfmpegFrameOnce(inputPath: string, seekSeconds: number) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg_missing");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const vf = `scale=${Math.max(64, config.thumbnailSizePx)}:-2:force_original_aspect_ratio=decrease`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-ss",
      `${seekSeconds}`,
      "-frames:v",
      "1",
      "-vf",
      vf,
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1"
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const output = Buffer.concat(chunks);
      if (code === 0 && output.length > 0) {
        resolve(output);
        return;
      }
      reject(new Error(`ffmpeg_failed:${code}:${stderr.slice(-400)}`));
    });
  });
}

async function spawnFfmpegFrame(inputPath: string) {
  let lastError: Error | null = null;
  for (const seek of [1, 0, 2, 3]) {
    try {
      const frame = await spawnFfmpegFrameOnce(inputPath, seek);
      if (frame.length > 0) {
        return frame;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError || new Error("ffmpeg_failed:no_frame");
}

async function generateThumbFromFile(sourcePath: string, fileName: string, outPath: string, detectedKind?: string) {
  const size = Math.max(64, config.thumbnailSizePx);
  const quality = Math.max(30, Math.min(95, config.thumbnailQuality));
  if (isHeif(fileName) && !canServerRenderHeif()) {
    throw new Error("thumbnail_heif_unsupported_runtime");
  }
  if (detectedKind === "image" || isImage(fileName)) {
    await renderImageToWebp(sourcePath, fileName, outPath, size, quality);
    return;
  }
  if (detectedKind === "video" || isVideo(fileName, detectedKind)) {
    const frame = await spawnFfmpegFrame(sourcePath);
    await sharp(frame).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality }).toFile(outPath);
    return;
  }
  throw new Error("thumbnail_unsupported");
}

async function persistThumbMeta(archiveId: string, fileIndex: number, localPath: string): Promise<ThumbnailResult> {
  const stat = await fs.promises.stat(localPath);
  // New thumbnails are stored only as encrypted bundles. Per-file provider fields
  // are cleared so the migration knows this entry no longer has a stand-alone upload.
  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.thumbnail.contentType`]: "image/webp",
        [`files.${fileIndex}.thumbnail.size`]: stat.size,
        [`files.${fileIndex}.thumbnail.localPath`]: localPath,
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
        [`files.${fileIndex}.thumbnail.mirrorError`]: "",
        [`files.${fileIndex}.thumbnail.updatedAt`]: new Date(),
        [`files.${fileIndex}.thumbnail.failedAt`]: null,
        [`files.${fileIndex}.thumbnail.error`]: "",
        "thumbnailBundle.needsRebuild": true
      }
    }
  );
  return { filePath: localPath, contentType: "image/webp", size: stat.size };
}

async function hydrateThumbMetaFromLocal(
  archiveId: string,
  fileIndex: number,
  localPath: string,
  existingUpdatedAt?: Date | null
): Promise<ThumbnailResult> {
  const stat = await fs.promises.stat(localPath);
  if (!existingUpdatedAt) {
    await Archive.updateOne(
      { _id: archiveId },
      {
        $set: {
          [`files.${fileIndex}.thumbnail.contentType`]: "image/webp",
          [`files.${fileIndex}.thumbnail.size`]: stat.size,
          [`files.${fileIndex}.thumbnail.localPath`]: localPath,
          [`files.${fileIndex}.thumbnail.updatedAt`]: new Date(),
          [`files.${fileIndex}.thumbnail.failedAt`]: null,
          [`files.${fileIndex}.thumbnail.error`]: "",
          "thumbnailBundle.needsRebuild": true
        }
      }
    );
  }
  return { filePath: localPath, contentType: "image/webp", size: stat.size };
}

async function generateThumbUsingSource(
  archive: ArchiveDoc,
  fileIndex: number,
  fileName: string,
  sourcePath: string,
  localPath: string,
  detectedKind?: string
) {
  noteThumbnailStarted();
  const startedAt = Date.now();
  try {
    await generateThumbFromFile(sourcePath, fileName, localPath, detectedKind);
  } catch (err) {
    noteThumbnailError();
    const message = toMessage(err);
    if (isPermanentThumbnailFailureMessage(message)) {
      await Archive.updateOne(
        { _id: archive.id },
        {
          $set: {
            [`files.${fileIndex}.thumbnail.failedAt`]: new Date(),
            [`files.${fileIndex}.thumbnail.error`]: message.slice(0, 500),
            [`files.${fileIndex}.thumbnail.updatedAt`]: null
          }
        }
      );
      throw makePermanentThumbnailFailure(message);
    }
    throw err;
  }
  const result = await persistThumbMeta(archive.id, fileIndex, localPath);
  noteThumbnailDone(result.size, Date.now() - startedAt);
  return result;
}

export async function ensureArchiveThumbnailFromSource(archive: ArchiveDoc, fileIndex: number) {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  const fileName = (file.originalName || file.name || "").trim();
  if (file.thumbnail?.failedAt) {
    const failure = file.thumbnail.error || "marked_failed";
    if (canRetryThumbnailFailure(fileName, failure) && canServerRenderHeif()) {
      await clearThumbnailFailure(archive.id, fileIndex);
    } else {
      throw makePermanentThumbnailFailure(failure);
    }
  }
  if (!supportsThumbnail(fileName, file.detectedKind)) {
    throw new Error("thumbnail_unsupported");
  }
  if (!file.path) {
    throw new Error("source_missing");
  }

  const localPath = thumbTargetPath(archive.id, fileIndex);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  if (fs.existsSync(localPath)) {
    return hydrateThumbMetaFromLocal(archive.id, fileIndex, localPath, file.thumbnail?.updatedAt || null);
  }
  if (!fs.existsSync(file.path)) {
    throw new Error("source_missing");
  }

  return generateThumbUsingSource(archive, fileIndex, fileName, file.path, localPath, file.detectedKind);
}

async function ensureThumbnailInternal(archive: ArchiveDoc, fileIndex: number): Promise<ThumbnailResult> {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  const fileName = (file.originalName || file.name || "").trim();
  if (file.thumbnail?.failedAt) {
    const failure = file.thumbnail.error || "marked_failed";
    if (canRetryThumbnailFailure(fileName, failure) && canServerRenderHeif()) {
      await clearThumbnailFailure(archive.id, fileIndex);
    } else {
      throw makePermanentThumbnailFailure(failure);
    }
  }
  if (!supportsThumbnail(fileName, file.detectedKind)) {
    throw new Error("thumbnail_unsupported");
  }

  const localPath = thumbTargetPath(archive.id, fileIndex);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  if (fs.existsSync(localPath)) {
    return hydrateThumbMetaFromLocal(archive.id, fileIndex, localPath, file.thumbnail?.updatedAt || null);
  }

  if (file.path && fs.existsSync(file.path)) {
    try {
      return await generateThumbUsingSource(archive, fileIndex, fileName, file.path, localPath, file.detectedKind);
    } catch (err) {
      if (isPermanentThumbnailFailureMessage(toMessage(err))) {
        throw err;
      }
      // Fallback to Discord restore path if direct source-based generation failed.
    }
  }

  if (await tryRestoreThumbFromRemote(archive, fileIndex, localPath)) {
    const stat = await fs.promises.stat(localPath);
    return { filePath: localPath, contentType: "image/webp", size: stat.size };
  }

  const tempDir = path.join(config.cacheDir, "thumb_work", `${archive.id}_${fileIndex}_${Math.random().toString(36).slice(2, 8)}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const sourcePath = path.join(tempDir, file.name || `${fileIndex}_${Date.now()}`);
  try {
    if (archive.isBundle) {
      await restoreArchiveFileToFile(archive, fileIndex, sourcePath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(archive, sourcePath, config.cacheDir, config.masterKey);
    }
    return await generateThumbUsingSource(archive, fileIndex, fileName, sourcePath, localPath, file.detectedKind);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureArchiveThumbnail(archive: ArchiveDoc, fileIndex: number) {
  const key = `${archive.id}:${fileIndex}`;
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const promise = ensureThumbnailInternal(archive, fileIndex).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
