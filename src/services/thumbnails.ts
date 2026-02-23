import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import sharp from "sharp";
import { Archive, type ArchiveDoc } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { config } from "../config.js";
import { downloadToFile, fetchWebhookMessage, uploadBufferToWebhook } from "./discord.js";
import { restoreArchiveFileToFile, restoreArchiveToFile } from "./restore.js";

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
    lower.includes("vipsjpeg: invalid sos parameters") ||
    lower.includes("invalid sos parameters") ||
    lower.includes("input file contains unsupported image format") ||
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

function isImage(fileName: string) {
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
  if (detectedKind === "image") return true;
  if (detectedKind === "video") return true;
  if (detectedKind && detectedKind !== "image" && detectedKind !== "video") return false;
  return isImage(fileName) || isVideo(fileName, detectedKind);
}

function thumbTargetPath(archiveId: string, fileIndex: number) {
  return path.join(config.cacheDir, "thumbs", `${archiveId}_${fileIndex}.webp`);
}

async function repairThumbUrl(
  archiveId: string,
  fileIndex: number,
  webhookId: string,
  messageId: string
) {
  const hook = await Webhook.findById(webhookId).lean();
  if (!hook?.url) {
    return null;
  }
  const payload = await fetchWebhookMessage(hook.url, messageId);
  const freshUrl = payload.attachments?.[0]?.url;
  if (!freshUrl) {
    return null;
  }
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { [`files.${fileIndex}.thumbnail.url`]: freshUrl, [`files.${fileIndex}.thumbnail.updatedAt`]: new Date() } }
  );
  return freshUrl;
}

async function tryRestoreThumbFromDiscord(
  archive: ArchiveDoc,
  fileIndex: number,
  localPath: string
) {
  const thumb = archive.files?.[fileIndex]?.thumbnail;
  const url = thumb?.url || "";
  const webhookId = thumb?.webhookId || "";
  const messageId = thumb?.messageId || "";
  if (!url || !webhookId || !messageId) {
    return false;
  }

  try {
    await downloadToFile(url, localPath);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/download_failed:404/.test(message)) {
      return false;
    }
    const repaired = await repairThumbUrl(archive.id, fileIndex, webhookId, messageId);
    if (!repaired) {
      return false;
    }
    await downloadToFile(repaired, localPath);
    return true;
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
  if (detectedKind === "image" || isImage(fileName)) {
    await sharp(sourcePath).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality }).toFile(outPath);
    return;
  }
  if (detectedKind === "video" || isVideo(fileName, detectedKind)) {
    const frame = await spawnFfmpegFrame(sourcePath);
    await sharp(frame).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality }).toFile(outPath);
    return;
  }
  throw new Error("thumbnail_unsupported");
}

async function uploadThumbBackup(archiveId: string, fileIndex: number, localPath: string) {
  const hooks = await Webhook.find({ enabled: true }).lean();
  if (hooks.length === 0) {
    return null;
  }
  const pick = hooks[Math.abs(fileIndex) % hooks.length];
  const buffer = await fs.promises.readFile(localPath);
  const content = `thumb archive:${archiveId} file:${fileIndex}`;
  const result = await uploadBufferToWebhook(buffer, `thumb_${archiveId}_${fileIndex}.webp`, pick.url, content);
  return { url: result.url, messageId: result.messageId, webhookId: pick._id.toString() };
}

async function persistThumbMeta(archiveId: string, fileIndex: number, localPath: string): Promise<ThumbnailResult> {
  const stat = await fs.promises.stat(localPath);
  const backup = await uploadThumbBackup(archiveId, fileIndex, localPath);
  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.thumbnail.contentType`]: "image/webp",
        [`files.${fileIndex}.thumbnail.size`]: stat.size,
        [`files.${fileIndex}.thumbnail.localPath`]: localPath,
        [`files.${fileIndex}.thumbnail.url`]: backup?.url || "",
        [`files.${fileIndex}.thumbnail.messageId`]: backup?.messageId || "",
        [`files.${fileIndex}.thumbnail.webhookId`]: backup?.webhookId || "",
        [`files.${fileIndex}.thumbnail.updatedAt`]: new Date(),
        [`files.${fileIndex}.thumbnail.failedAt`]: null,
        [`files.${fileIndex}.thumbnail.error`]: ""
      }
    }
  );
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
  try {
    await generateThumbFromFile(sourcePath, fileName, localPath, detectedKind);
  } catch (err) {
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
  return persistThumbMeta(archive.id, fileIndex, localPath);
}

export async function ensureArchiveThumbnailFromSource(archive: ArchiveDoc, fileIndex: number) {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  if (file.thumbnail?.failedAt) {
    throw makePermanentThumbnailFailure(file.thumbnail.error || "marked_failed");
  }
  const fileName = (file.originalName || file.name || "").trim();
  if (!supportsThumbnail(fileName, file.detectedKind)) {
    throw new Error("thumbnail_unsupported");
  }
  if (!file.path) {
    throw new Error("source_missing");
  }

  const localPath = thumbTargetPath(archive.id, fileIndex);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  if (fs.existsSync(localPath)) {
    const stat = await fs.promises.stat(localPath);
    return { filePath: localPath, contentType: "image/webp", size: stat.size };
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
  if (file.thumbnail?.failedAt) {
    throw makePermanentThumbnailFailure(file.thumbnail.error || "marked_failed");
  }
  const fileName = (file.originalName || file.name || "").trim();
  if (!supportsThumbnail(fileName, file.detectedKind)) {
    throw new Error("thumbnail_unsupported");
  }

  const localPath = thumbTargetPath(archive.id, fileIndex);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  if (fs.existsSync(localPath)) {
    const stat = await fs.promises.stat(localPath);
    return { filePath: localPath, contentType: "image/webp", size: stat.size };
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

  if (await tryRestoreThumbFromDiscord(archive, fileIndex, localPath)) {
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
