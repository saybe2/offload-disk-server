import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import archiver from "archiver";
import multer from "multer";
import busboy from "busboy";
import crypto from "crypto";
import { nanoid } from "nanoid";
import mime from "mime-types";
import { checkDiskSpace } from "../services/disk.js";
import { requireAuth } from "../auth.js";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { Share } from "../models/Share.js";
import { User } from "../models/User.js";
import { config, computed } from "../config.js";
import {
  restoreArchiveFileToFile,
  restoreArchiveToFile,
  streamArchiveFileToResponse,
  streamArchiveRangeToResponse,
  streamArchiveToResponse
} from "../services/restore.js";
import { uniqueParts } from "../services/parts.js";
import { log } from "../logger.js";
import { getDescendantFolderIds } from "../services/folders.js";
import { Webhook } from "../models/Webhook.js";
import { deriveKey } from "../services/crypto.js";
import { fetchWebhookMessage, uploadBufferToWebhook, uploadToWebhook } from "../services/discord.js";
import { sanitizeFilename } from "../utils/names.js";
import { bumpDownloadCounts } from "../services/downloadCounts.js";
import { bumpPreviewCount } from "../services/previewCounts.js";
import {
  ensureArchiveThumbnail,
  ensureArchiveThumbnailFromSource,
  isPermanentThumbnailFailureMessage,
  supportsThumbnail
} from "../services/thumbnails.js";
import { queueArchiveThumbnails } from "../services/thumbnailWorker.js";
import { detectFileTypeFromName, detectFileTypeFromSample, detectStoredFileType } from "../services/fileType.js";
import {
  isPreviewAllowedForFile,
  isPreviewContentTypeAllowed,
  resolvePreviewContentType
} from "../services/preview.js";
import { remuxTsToMp4 } from "../services/videoPreview.js";
import { outboundFetch } from "../services/outbound.js";

const upload = multer({
  dest: path.join(config.cacheDir, "uploads_tmp"),
  limits: config.uploadMaxFiles > 0 ? { files: config.uploadMaxFiles } : undefined
});

export const apiRouter = Router();

function sanitizeName(name: string) {
  return sanitizeFilename(name);
}

const CP1252_MAP: Record<number, number> = {
  0x20AC: 0x80,
  0x201A: 0x82,
  0x0192: 0x83,
  0x201E: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02C6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8A,
  0x2039: 0x8B,
  0x0152: 0x8C,
  0x017D: 0x8E,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201C: 0x93,
  0x201D: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02DC: 0x98,
  0x2122: 0x99,
  0x0161: 0x9A,
  0x203A: 0x9B,
  0x0153: 0x9C,
  0x017E: 0x9E,
  0x0178: 0x9F
};

function decodeCp1252ToUtf8(input: string) {
  const bytes: number[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0x3f;
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    const mapped = CP1252_MAP[code];
    bytes.push(mapped ?? 0x3f);
  }
  return Buffer.from(bytes).toString("utf8");
}

function normalizeFilename(name: string) {
  if (!name) return name;
  const looksMojibake = /[ÃÐÑ]/.test(name);
  if (!looksMojibake) return name;
  const decodedLatin1 = Buffer.from(name, "latin1").toString("utf8");
  const decodedCp1252 = decodeCp1252ToUtf8(name);
  const candidates = [decodedLatin1, decodedCp1252];
  const hasCyrillic = (value: string) => /[\u0400-\u04FF]/.test(value);
  const countReplacement = (value: string) => (value.match(/�/g) || []).length;

  let best = name;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (!candidate || candidate === name) continue;
    const replacements = countReplacement(candidate);
    const score = replacements * 10 - (hasCyrillic(candidate) ? 1 : 0);
    if (hasCyrillic(candidate) && replacements === 0) {
      return candidate;
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (hasCyrillic(best) && !best.includes("�")) return best;
  return name;
}

function makeDisplayName(names: string[]) {
  if (names.length === 1) {
    return normalizeFilename(names[0]).replace(/[\\/]/g, "_");
  }
  return `Bundle (${names.length} files)`;
}

function isTransientError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed/i.test(message)) return true;
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message)) return true;
  const match = message.match(/webhook_upload_failed:(\d{3})/);
  if (match) {
    const code = Number(match[1]);
    if (code === 429) return true;
    if (code >= 500 && code <= 599) return true;
  }
  return false;
}

async function refreshPartUrl(archiveId: string, part: any) {
  const webhookId = part.webhookId ? String(part.webhookId) : null;
  const messageId = part.messageId;
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
    { _id: archiveId, "parts.messageId": messageId },
    { $set: { "parts.$.url": freshUrl } }
  );
  part.url = freshUrl;
  return freshUrl;
}

async function uploadWithRetry(partPath: string, webhookUrl: string, content: string) {
  let attempt = 0;
  while (true) {
    try {
      return await uploadToWebhook(partPath, webhookUrl, content);
    } catch (err) {
      attempt += 1;
      if (!isTransientError(err) || attempt > config.uploadRetryMax) {
        throw err;
      }
      const delay = Math.min(config.uploadRetryMaxMs, config.uploadRetryBaseMs * Math.pow(2, attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function uploadBufferWithRetry(buffer: Buffer, filename: string, webhookUrl: string, content: string) {
  let attempt = 0;
  while (true) {
    try {
      return await uploadBufferToWebhook(buffer, filename, webhookUrl, content);
    } catch (err) {
      attempt += 1;
      if (!isTransientError(err) || attempt > config.uploadRetryMax) {
        throw err;
      }
      const delay = Math.min(config.uploadRetryMaxMs, config.uploadRetryBaseMs * Math.pow(2, attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function splitUploads<T extends { size: number }>(files: T[]) {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;

  for (const file of files) {
    if (file.size >= computed.bundleSingleFileBytes) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentSize = 0;
      }
      groups.push([file]);
      continue;
    }

    if (currentSize + file.size > computed.bundleMaxBytes && current.length > 0) {
      groups.push(current);
      current = [file];
      currentSize = file.size;
      continue;
    }

    current.push(file);
    currentSize += file.size;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function isFileDeleted(file: any) {
  return !!file?.deletedAt;
}

function isPreviewSupportedForFile(archive: any, file: any) {
  if (!file || isFileDeleted(file)) return false;
  const fileSize = Number(file.size || 0);
  const previewMaxBytes = Math.max(1, Math.floor(config.previewMaxMiB * 1024 * 1024));
  if (fileSize > previewMaxBytes) return false;
  const fileName = file.originalName || file.name || archive?.displayName || archive?.name || "";
  const contentType = (mime.lookup(fileName) as string) || "";
  return isPreviewAllowedForFile(fileName, contentType);
}

function withPreviewSupport(archive: any) {
  const files = Array.isArray(archive?.files)
    ? archive.files.map((file: any) => ({
        ...file,
        previewSupported: isPreviewSupportedForFile(archive, file)
      }))
    : [];
  return { ...archive, files };
}

function activeBundleFileIndices(archive: any) {
  const indices: number[] = [];
  const files = Array.isArray(archive?.files) ? archive.files : [];
  for (let i = 0; i < files.length; i += 1) {
    if (!isFileDeleted(files[i])) {
      indices.push(i);
    }
  }
  return indices;
}

function hasActiveFiles(archive: any) {
  if (!Array.isArray(archive?.files) || archive.files.length === 0) return false;
  return archive.files.some((file: any) => !isFileDeleted(file));
}

apiRouter.post("/upload", requireAuth, upload.any(), async (req, res) => {
  let aborted = false;
  let stagingDir: string | null = null;
  let tempPaths: string[] = [];

  const cleanup = async () => {
    const paths = tempPaths.slice();
    tempPaths = [];
    await Promise.all(
      paths.map((p) => fs.promises.unlink(p).catch(() => undefined))
    );
    if (stagingDir) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      stagingDir = null;
    }
  };

  req.on("aborted", () => {
    aborted = true;
    cleanup();
    log("api", "upload aborted by client");
  });

  req.on("close", () => {
    if (!aborted) {
      log("api", `upload stream closed bytes=${req.socket?.bytesRead || 0}`);
    }
  });

  req.on("end", () => {
    log("api", "upload request fully received");
  });

  const files = (req.files as Express.Multer.File[]) || [];
  tempPaths = files.map((f) => f.path);
  if (files.length === 0) {
    return res.status(400).json({ error: "no_files" });
  }

  if (aborted || req.aborted) {
    await cleanup();
    return;
  }

  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  log("api", `upload start files=${files.length} size=${totalSize}`);
  if (user.quotaBytes > 0 && user.usedBytes + totalSize > user.quotaBytes) {
    for (const f of files) {
      await fs.promises.unlink(f.path).catch(() => undefined);
    }
    return res.status(413).json({ error: "quota_exceeded" });
  }

  const disk = await checkDiskSpace(config.cacheDir);
  const freeGb = disk.free / (1024 * 1024 * 1024);
  if (freeGb < config.diskHardLimitGb) {
    for (const f of files) {
      await fs.promises.unlink(f.path).catch(() => undefined);
    }
    return res.status(507).json({ error: "disk_full" });
  }

  if (aborted || req.aborted) {
    await cleanup();
    return;
  }

  const folderId = (req.body.folderId as string) || null;
  const pathListRaw = (req.body.paths as string | string[] | undefined) || [];
  const nameListRaw = (req.body.names as string | string[] | undefined) || [];
  const pathList = Array.isArray(pathListRaw) ? pathListRaw : [pathListRaw];
  const nameList = Array.isArray(nameListRaw) ? nameListRaw : [nameListRaw];
  const hasPaths = pathList.length === files.length && pathList.some((p) => p && p.trim().length > 0);
  const hasNames = nameList.length === files.length && nameList.some((n) => n && n.trim().length > 0);
  let folderRef: any = null;
  let basePriority = 2;
  if (folderId) {
    const folder = await Folder.findById(folderId);
    if (!folder || (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId)) {
      return res.status(400).json({ error: "invalid_folder" });
    }
    folderRef = folder._id;
    basePriority = folder.priority ?? 2;
  }
  const archiveIds: string[] = [];

  const folderCache = new Map<string, any>();
  const getOrCreateFolder = async (baseId: string | null, segments: string[]) => {
    let parentId = baseId;
    for (const segment of segments) {
      const name = segment.trim();
      if (!name) continue;
      const key = `${parentId || "root"}:${name}`;
      let folder = folderCache.get(key);
      if (!folder) {
        folder = await Folder.findOne({ userId: user.id, parentId, name });
        if (!folder) {
          folder = await Folder.create({ userId: user.id, name, parentId, priority: 2 });
        }
        folderCache.set(key, folder);
      }
      if (!folder) {
        continue;
      }
      parentId = folder._id;
    }
    return parentId;
  };

  const extractFolderSegments = (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts;
  };

  const items = [] as { file: Express.Multer.File; folderId: any; clientName?: string }[];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const clientName = hasNames ? nameList[i] : undefined;
    let targetFolderId = folderRef;
    if (hasPaths) {
      const rel = pathList[i] || "";
      const segments = extractFolderSegments(rel);
      if (segments.length > 0) {
        targetFolderId = await getOrCreateFolder(folderRef ? folderRef.toString() : null, segments);
      }
    }
    items.push({ file, folderId: targetFolderId, clientName });
  }

  const groupsByFolder = new Map<string, { folderId: any; items: { file: Express.Multer.File; folderId: any; clientName?: string }[] }>();
  for (const item of items) {
    const key = item.folderId ? item.folderId.toString() : "root";
    const bucket = groupsByFolder.get(key);
    if (bucket) {
      bucket.items.push(item);
    } else {
      groupsByFolder.set(key, { folderId: item.folderId, items: [item] });
    }
  }

  const groupedUploads: { folderId: any; items: { file: Express.Multer.File; folderId: any; clientName?: string }[] }[] = [];
  for (const bucket of groupsByFolder.values()) {
    const split = splitUploads(bucket.items.map((i) => ({ size: i.file.size, item: i })));
    for (const group of split) {
      groupedUploads.push({ folderId: bucket.folderId, items: group.map((g: any) => g.item) });
    }
  }

  for (const [groupIndex, group] of groupedUploads.entries()) {
    const isBundle = group.items.length > 1;
    const ordered = isBundle
      ? [...group.items].sort((a, b) => a.file.size - b.file.size)
      : group.items;
    const displayName = makeDisplayName(ordered.map((item) => item.clientName || item.file.originalname));
    const downloadName = isBundle
      ? `bundle_${Date.now()}_${groupIndex}.zip`
      : normalizeFilename(ordered[0].clientName || ordered[0].file.originalname).replace(/[\\/]/g, "_");
    const archiveName = sanitizeName(downloadName);
    stagingDir = path.join(
      config.cacheDir,
      "uploads",
      new Date().toISOString().slice(0, 10),
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${groupIndex}`
    );
    await fs.promises.mkdir(stagingDir, { recursive: true });

    const archiveFiles = [] as {
      path: string;
      name: string;
      originalName: string;
      size: number;
      contentModifiedAt: Date;
      detectedKind: string;
      detectedTypeLabel: string;
    }[];
    for (const [index, item] of ordered.entries()) {
      const file = item.file;
      const safeOriginal = normalizeFilename(item.clientName || file.originalname);
      const safeName = `${index}_${sanitizeName(safeOriginal)}`;
      const dest = path.join(stagingDir, safeName);
      await fs.promises.rename(file.path, dest);
      const detectedType = await detectStoredFileType(dest, safeOriginal);
      archiveFiles.push({
        path: dest,
        name: safeName,
        originalName: safeOriginal,
        size: file.size,
        contentModifiedAt: new Date(),
        detectedKind: detectedType.kind,
        detectedTypeLabel: detectedType.label
      });
    }

    if (aborted || req.aborted) {
      await cleanup();
      return;
    }

    const groupSize = ordered.reduce((sum, f) => sum + f.file.size, 0);

    const archive = await Archive.create({
      userId: user.id,
      name: archiveName,
      displayName,
      downloadName,
      isBundle,
      encryptionVersion: 2,
      folderId: group.folderId,
      priority: basePriority,
      priorityOverride: false,
      status: "queued",
      contentModifiedAt: new Date(),
      originalSize: groupSize,
      encryptedSize: 0,
      uploadedBytes: 0,
      uploadedParts: 0,
      totalParts: 0,
      chunkSizeBytes: computed.chunkSizeBytes,
      stagingDir,
      files: archiveFiles,
      parts: []
    });
    queueArchiveThumbnails(archive.id);
    archiveIds.push(archive.id);
    stagingDir = null;
  }

  user.usedBytes += totalSize;
  await user.save();

  log("api", `upload queued archives=${archiveIds.length} files=${files.length} size=${totalSize}`);
  return res.json({ ok: true, archiveIds });
});

apiRouter.post("/upload-stream", requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const webhooks = await Webhook.find({ enabled: true });
  if (webhooks.length === 0) {
    return res.status(400).json({ error: "no_webhooks" });
  }

  let folderId: string | null = typeof req.query.folderId === "string" ? req.query.folderId : null;
  let relativePath: string | null = typeof req.query.path === "string" ? req.query.path : null;
  let clientName: string | null = null;
  let archiveId: string | null = null;
  let receiveDone: Promise<{ originalSize: number }> | null = null;
  let uploadDone: Promise<void> | null = null;
  let receiveError: Error | null = null;
  let clientAborted = false;
  let activeFile: NodeJS.ReadableStream | null = null;
  let activeRawWrite: fs.WriteStream | null = null;

  const bb = busboy({ headers: req.headers, limits: { files: 1 } });

  const abortStream = (reason: string) => {
    if (clientAborted) return;
    clientAborted = true;
    receiveError = new Error(reason);
    try {
      const destroyFn = (activeFile as any)?.destroy;
      if (typeof destroyFn === "function") {
        destroyFn.call(activeFile, new Error(reason));
      }
    } catch {}
    try {
      if (activeFile && activeRawWrite) {
        try {
          (activeFile as any).unpipe?.(activeRawWrite);
        } catch {}
      }
      activeRawWrite?.destroy();
    } catch {}
  };

  req.on("aborted", () => {
    abortStream("client_aborted");
    log("stream", "upload aborted by client");
  });

  bb.on("error", (err: Error) => {
    receiveError = err;
    log("stream", `busboy error ${err.message}`);
  });

  bb.on("field", (name: string, value: string) => {
    if (name === "folderId") {
      folderId = value || null;
    }
    if (name === "paths") {
      relativePath = value || null;
    }
    if (name === "names") {
      clientName = value || null;
    }
  });

  bb.on("file", (name: string, file: NodeJS.ReadableStream, info: { filename?: string }) => {
    const rawFilename = (clientName || info?.filename || "file").toString();
    const filename = normalizeFilename(rawFilename);
    const safeName = filename.replace(/[\\/]/g, "_");

    activeFile = file;
    file.pause();

    receiveDone = (async () => {
      if (clientAborted) {
        throw new Error("client_aborted");
      }
      const useDisk = config.streamUseDisk;
      let folderRef: any = null;
      let basePriority = 2;
      if (folderId) {
        const folder = await Folder.findById(folderId);
        if (!folder || (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId)) {
          throw new Error("invalid_folder");
        }
        folderRef = folder._id;
        basePriority = folder.priority ?? 2;
      }
      if (relativePath) {
        const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
        segments.pop();
        let parentId = folderRef ? folderRef.toString() : null;
        for (const segment of segments) {
          const name = segment.trim();
          if (!name) continue;
          let folder = await Folder.findOne({ userId: user.id, parentId, name });
          if (!folder) {
            folder = await Folder.create({ userId: user.id, name, parentId, priority: 2 });
          }
          parentId = folder._id.toString();
          folderRef = folder._id;
        }
      }

      const stagingDir = path.join(
        config.cacheDir,
        "uploads",
        new Date().toISOString().slice(0, 10),
        `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_stream`
      );
      await fs.promises.mkdir(stagingDir, { recursive: true });

      const rawPath = path.join(stagingDir, `0_${sanitizeName(filename)}`);
      const rawWrite = useDisk ? fs.createWriteStream(rawPath) : null;
      activeRawWrite = rawWrite;

      const initialDetectedType = detectFileTypeFromName(safeName);
      const archive = await Archive.create({
        userId: user.id,
        name: sanitizeName(safeName),
        displayName: safeName,
        downloadName: safeName,
        isBundle: false,
        encryptionVersion: 2,
        folderId: folderRef,
        priority: basePriority,
        priorityOverride: false,
        status: "processing",
        originalSize: 0,
        encryptedSize: 0,
        uploadedBytes: 0,
        uploadedParts: 0,
        totalParts: 0,
        chunkSizeBytes: computed.chunkSizeBytes,
        stagingDir,
        files: [{
          path: rawPath,
          name: path.basename(rawPath),
          originalName: safeName,
          size: 0,
          contentModifiedAt: new Date(),
          detectedKind: initialDetectedType.kind,
          detectedTypeLabel: initialDetectedType.label
        }],
        parts: []
      });

      archiveId = archive.id;
      log("stream", `upload start archive=${archive.id} user=${user.id} name=${safeName}`);

      const workDir = path.join(config.cacheDir, "work", `stream_${archive.id}`);
      if (useDisk) {
        await fs.promises.mkdir(workDir, { recursive: true });
      }

      const key = deriveKey(config.masterKey);
      let encryptedBytes = 0;
      let partIndex = 0;
      let originalSize = 0;
      let typeSample = Buffer.alloc(0);
      let failed: Error | null = null;
      let uploadedPartsCount = 0;

      let active = 0;
      const pending: { index: number; buffer: Buffer; size: number; plainSize: number; hash: string; iv: string; authTag: string }[] = [];
      let uploadsFinishedResolve: (() => void) | null = null;
      const uploadsFinished = new Promise<void>((resolve) => {
        uploadsFinishedResolve = resolve;
      });
      const resolveUploadsFinished = () => {
        if (uploadsFinishedResolve) {
          uploadsFinishedResolve();
          uploadsFinishedResolve = null;
        }
      };
      let finishedAdding = false;

      const scheduleUploads = () => {
        if (failed) return;
        while (active < config.uploadPartsConcurrency && pending.length > 0) {
          const part = pending.shift()!;
          active += 1;
          (async () => {
            const webhook = webhooks[part.index % webhooks.length];
            const content = `archive:${archive.id} part:${part.index}`;
            const result = await uploadBufferWithRetry(part.buffer, `part_${part.index}`, webhook.url, content);
            const partDoc = {
              index: part.index,
              size: part.size,
              plainSize: part.plainSize,
              hash: part.hash,
              url: result.url,
              messageId: result.messageId,
              webhookId: webhook.id,
              iv: part.iv,
              authTag: part.authTag
            };
            await Archive.updateOne({ _id: archive.id }, { $push: { parts: partDoc }, $inc: { uploadedBytes: part.size, uploadedParts: 1 } });
            uploadedPartsCount += 1;
            if (uploadedPartsCount % 10 === 0) {
              log("stream", `upload progress archive=${archive.id} parts=${uploadedPartsCount}`);
            }
          })()
            .catch((err) => {
              failed = err instanceof Error ? err : new Error("upload_failed");
              log("stream", `upload error archive=${archive.id} err=${failed.message}`);
            })
            .finally(() => {
              active -= 1;
              if (finishedAdding && active === 0 && pending.length === 0) {
                resolveUploadsFinished();
              } else {
                scheduleUploads();
              }
            });
        }
      };

      const maxPending = Math.max(2, config.uploadPartsConcurrency * 2);
      const waitForPendingSpace = async () => {
        while (!failed && pending.length >= maxPending) {
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      const enqueuePart = async (plain: Buffer, index: number) => {
        const partIv = crypto.randomBytes(12);
        const partCipher = crypto.createCipheriv("aes-256-gcm", key, partIv);
        const encrypted = Buffer.concat([partCipher.update(plain), partCipher.final()]);
        const hash = crypto.createHash("sha256").update(encrypted).digest("hex");
        pending.push({
          index,
          buffer: encrypted,
          size: encrypted.length,
          plainSize: plain.length,
          hash,
          iv: partIv.toString("base64"),
          authTag: partCipher.getAuthTag().toString("base64")
        });
        scheduleUploads();
        await waitForPendingSpace();
      };

      file.on("error", (err) => {
        failed = err instanceof Error ? err : new Error("stream_failed");
      });

      const writeRawChunk = async (chunk: Buffer) => {
        if (!rawWrite) return;
        const ok = rawWrite.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onErr = (err: Error) => {
              cleanup();
              reject(err);
            };
            const cleanup = () => {
              rawWrite.off("drain", onDrain);
              rawWrite.off("error", onErr);
            };
            rawWrite.once("drain", onDrain);
            rawWrite.once("error", onErr);
          });
        }
      };

      if (rawWrite) {
        rawWrite.on("error", (err) => {
          if (clientAborted) return;
          failed = err instanceof Error ? err : new Error("write_failed");
          log("stream", `write error archive=${archive.id} err=${failed.message}`);
        });
      }
      file.resume();

      let buffer = Buffer.alloc(0);
      for await (const chunk of file) {
        if (failed) break;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
        originalSize += data.length;
        if (typeSample.length < 188 * 12) {
          const remaining = 188 * 12 - typeSample.length;
          typeSample = Buffer.concat([typeSample, data.subarray(0, remaining)]);
        }
        if (rawWrite) {
          await writeRawChunk(data);
          if (failed) break;
        }
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= computed.chunkSizeBytes) {
          const part = buffer.subarray(0, computed.chunkSizeBytes);
          buffer = buffer.subarray(computed.chunkSizeBytes);
          encryptedBytes += part.length;
          await enqueuePart(part, partIndex);
          partIndex += 1;
        }
      }

      if (rawWrite) {
        await new Promise<void>((resolve) => rawWrite.end(() => resolve()));
      }

      if (!failed && buffer.length > 0) {
        encryptedBytes += buffer.length;
        await enqueuePart(buffer, partIndex);
        partIndex += 1;
      }

      finishedAdding = true;
      log("stream", `upload queued archive=${archive.id} parts=${partIndex}`);
      if (active === 0 && pending.length === 0) {
        resolveUploadsFinished();
      }

      let detectedType = initialDetectedType;
      if (useDisk) {
        detectedType = await detectStoredFileType(rawPath, safeName);
      } else if (typeSample.length > 0) {
        detectedType = detectFileTypeFromSample(safeName, typeSample);
      }

      await Archive.updateOne(
        { _id: archive.id },
        {
          $set: {
            iv: "",
            authTag: "",
            encryptionVersion: 2,
            encryptedSize: encryptedBytes,
            totalParts: partIndex,
            originalSize,
            "files.0.size": originalSize,
            "files.0.detectedKind": detectedType.kind,
            "files.0.detectedTypeLabel": detectedType.label
          }
        }
      );
      if (useDisk) {
        queueArchiveThumbnails(archive.id);
      }

      await User.updateOne({ _id: user.id }, { $inc: { usedBytes: originalSize } });

      uploadDone = uploadsFinished.then(async () => {
        if (failed) {
          await Archive.updateOne({ _id: archive.id }, { $set: { status: "error", error: failed?.message || "upload_failed" } });
          log("stream", `upload failed archive=${archive.id} err=${failed?.message || "upload_failed"}`);
          return;
        }
        if (useDisk) {
          const sourceName = archive.files?.[0]?.originalName || archive.files?.[0]?.name || archive.displayName || archive.name;
          if (supportsThumbnail(sourceName, detectedType.kind)) {
            try {
              await ensureArchiveThumbnailFromSource(archive, 0);
              log("stream", `thumbnail ready archive=${archive.id}`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log("stream", `thumbnail skip archive=${archive.id} err=${message}`);
            }
          }
        }
        await Archive.updateOne({ _id: archive.id }, { $set: { status: "ready", error: "" } });
        log("stream", `upload ready archive=${archive.id} parts=${uploadedPartsCount}`);
        if (config.cacheDeleteAfterUpload) {
          await fs.promises.rm(stagingDir, { recursive: true, force: true });
          if (useDisk) {
            await fs.promises.rm(workDir, { recursive: true, force: true });
          }
        }
      });

      return { originalSize };
    })().catch((err) => {
      receiveError = err instanceof Error ? err : new Error("stream_failed");
      return { originalSize: 0 };
    });
  });

  bb.on("finish", async () => {
    if (!receiveDone) {
      return res.status(400).json({ error: "no_files" });
    }

    const result = await receiveDone;
    if (clientAborted || req.aborted) {
      if (archiveId) {
        await Archive.updateOne({ _id: archiveId }, { $set: { status: "error", error: receiveError?.message || "client_aborted" } });
      }
      return;
    }
    if (receiveError) {
      if (archiveId) {
        await Archive.updateOne({ _id: archiveId }, { $set: { status: "error", error: receiveError.message } });
      }
      return res.status(500).json({ error: "upload_failed" });
    }

    const quotaBytes = user.quotaBytes || 0;
    if (quotaBytes > 0 && user.usedBytes + result.originalSize > quotaBytes) {
      if (archiveId) {
        await Archive.updateOne({ _id: archiveId }, { $set: { status: "error", error: "quota_exceeded", deleteRequestedAt: new Date() } });
      }
      return res.status(413).json({ error: "quota_exceeded" });
    }

    return res.json({ ok: true, archiveIds: archiveId ? [archiveId] : [] });
  });

  req.pipe(bb);
});

apiRouter.get("/archives", requireAuth, async (req, res) => {
  const isTrash = req.query.trash === "1";
  const folderId = (req.query.folderId as string) || null;
  const rootOnly = req.query.root === "1";
  const baseFilter = req.session.role === "admin" ? {} : { userId: req.session.userId };
  const filter = {
    ...baseFilter,
    deletedAt: null,
    trashedAt: isTrash ? { $ne: null } : null
  } as Record<string, unknown>;
  if (!isTrash) {
    filter.trashedAt = null;
  }
  if (folderId) {
    filter.folderId = folderId;
  } else if (rootOnly && !isTrash) {
    filter.folderId = null;
  }
  const archives = await Archive.find(filter).sort({ createdAt: -1 }).lean();
  return res.json({ archives: archives.map((archive) => withPreviewSupport(archive)) });
});

apiRouter.get("/archives/:id/download", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }

  try {
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : null;
    const canUseRange = !!rangeHeader && !archive.isBundle;
    log("download", canUseRange ? `start ${archive.id} range=${rangeHeader}` : `start ${archive.id}`);
    if (archive.isBundle) {
      const activeIndices = activeBundleFileIndices(archive);
      if (activeIndices.length === 0) {
        return res.status(404).json({ error: "no_active_files" });
      }

      const hasDeleted = activeIndices.length !== (archive.files?.length || 0);
      if (!hasDeleted) {
        await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
        const countTargets = activeIndices.map((fileIndex) => ({ archiveId: archive.id, fileIndex }));
        await bumpDownloadCounts(countTargets);
        return;
      }

      const downloadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const tempDir = path.join(config.cacheDir, "selection", `bundle_${downloadId}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      res.setHeader("Content-Type", "application/zip");
      const bundleName = archive.displayName || archive.downloadName || archive.name || "bundle";
      const zipName = bundleName.toLowerCase().endsWith(".zip") ? bundleName : `${bundleName}.zip`;
      const safeZipName = sanitizeName(zipName);
      res.setHeader("Content-Disposition", `attachment; filename="${safeZipName}"`);

      const zip = archiver("zip", { zlib: { level: 0 } });
      zip.on("error", () => {
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy();
        }
      });
      zip.pipe(res);
      res.on("close", async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      });

      const nameCounts = new Map<string, number>();
      const countTargets: { archiveId: string; fileIndex: number }[] = [];
      let writeIndex = 0;
      for (const fileIndex of activeIndices) {
        const file = archive.files?.[fileIndex];
        if (!file) continue;
        const original = (file.originalName || file.name || `file_${fileIndex}`).replace(/[\\/]/g, "_");
        const n = (nameCounts.get(original) || 0) + 1;
        nameCounts.set(original, n);
        let finalName = original;
        if (n > 1) {
          const extIndex = original.lastIndexOf(".");
          finalName = extIndex > 0
            ? `${original.slice(0, extIndex)} (${n})${original.slice(extIndex)}`
            : `${original} (${n})`;
        }
        const outPath = path.join(tempDir, `${writeIndex}_${sanitizeName(finalName)}`);
        writeIndex += 1;
        await restoreArchiveFileToFile(archive, fileIndex, outPath, config.cacheDir, config.masterKey);
        zip.file(outPath, { name: finalName });
        countTargets.push({ archiveId: archive.id, fileIndex });
      }
      await zip.finalize();
      await bumpDownloadCounts(countTargets);
      return;
    }

    if (archive.files?.[0] && isFileDeleted(archive.files[0])) {
      return res.status(404).json({ error: "file_deleted" });
    }

    if (canUseRange) {
      await streamArchiveRangeToResponse(archive, rangeHeader!, res, config.cacheDir, config.masterKey);
      return;
    }
    await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
    await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: 0 }]);
  } catch (err) {
    log("download", `error ${archive.id} ${(err as Error).message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    return res.status(500).json({ error: "restore_failed" });
  }
});

apiRouter.post("/archives/download-zip", requireAuth, async (req, res) => {
  let items = (req.body?.items as { archiveId: string; fileIndex?: number }[]) || [];
  if ((!items || items.length === 0) && req.body?.payload) {
    try {
      const parsed = JSON.parse(req.body.payload);
      items = parsed.items || [];
    } catch {
      return res.status(400).json({ error: "bad_payload" });
    }
  }
  if (!items || items.length === 0) {
    return res.status(400).json({ error: "missing_items" });
  }

  const ids = [...new Set(items.map((i) => i.archiveId))];
  const archives = await Archive.find({ _id: { $in: ids } });
  if (req.session.role !== "admin") {
    const forbidden = archives.find((a) => a.userId.toString() !== req.session.userId);
    if (forbidden) return res.status(403).json({ error: "forbidden" });
  }
  const archiveMap = new Map(archives.map((a) => [a._id.toString(), a]));
  const notReady = items.find((i) => archiveMap.get(i.archiveId)?.status !== "ready");
  if (notReady) {
    return res.status(409).json({ error: "not_ready" });
  }

  const downloadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = path.join(config.cacheDir, "selection", downloadId);
  await fs.promises.mkdir(tempDir, { recursive: true });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=\"selection_${Date.now()}.zip\"`);

  const zip = archiver("zip", { zlib: { level: 0 } });
  zip.on("error", () => {
    res.status(500).end();
  });
  zip.pipe(res);
  res.on("close", async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  try {
    const downloadTargets: { archiveId: string; fileIndex: number }[] = [];
    let index = 0;
    const nameCounts = new Map<string, number>();
    for (const item of items) {
      const archive = archiveMap.get(item.archiveId);
      if (!archive) continue;
      const fileIndex = Number.isInteger(item.fileIndex) ? (item.fileIndex as number) : 0;
      const targetIndex = archive.isBundle ? fileIndex : 0;
      const targetFile = archive.files?.[targetIndex];
      if (!targetFile || isFileDeleted(targetFile)) {
        continue;
      }

      let outputName = archive.downloadName || archive.name;
      if (archive.isBundle && archive.files?.[fileIndex]) {
        outputName = targetFile.originalName || targetFile.name;
      }

      const baseName = outputName;
      const currentCount = (nameCounts.get(baseName) || 0) + 1;
      nameCounts.set(baseName, currentCount);
      let finalName = baseName;
      if (currentCount > 1) {
        const extIndex = baseName.lastIndexOf(".");
        if (extIndex > 0) {
          finalName = `${baseName.slice(0, extIndex)} (${currentCount})${baseName.slice(extIndex)}`;
        } else {
          finalName = `${baseName} (${currentCount})`;
        }
      }

      const safeName = sanitizeName(finalName);
      const outputPath = path.join(tempDir, `${index}_${safeName}`);
      index += 1;

      if (archive.isBundle && archive.files?.length > 1) {
        await restoreArchiveFileToFile(archive, fileIndex, outputPath, config.cacheDir, config.masterKey);
        downloadTargets.push({ archiveId: archive.id, fileIndex });
      } else {
        await restoreArchiveToFile(archive, outputPath, config.cacheDir, config.masterKey);
        downloadTargets.push({ archiveId: archive.id, fileIndex: 0 });
      }

      zip.file(outputPath, { name: finalName });
    }

    await zip.finalize();
    await bumpDownloadCounts(downloadTargets);
  } finally {
    // cleanup handled on close
  }
});

apiRouter.get("/archives/:id/files/:index/download", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "bad_index" });
  }
  const targetIndex = archive.isBundle ? index : 0;
  const targetFile = archive.files?.[targetIndex];
  if (targetFile && isFileDeleted(targetFile)) {
    return res.status(404).json({ error: "file_deleted" });
  }

  try {
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : null;
  const canUseRange = !!rangeHeader && !archive.isBundle;
    log(
      "download",
      canUseRange ? `start ${archive.id} file=${index} range=${rangeHeader}` : `start ${archive.id} file=${index}`
    );
    if (!archive.isBundle) {
      if (canUseRange) {
        await streamArchiveRangeToResponse(archive, rangeHeader!, res, config.cacheDir, config.masterKey);
        return;
      }
      await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
      await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: 0 }]);
      return;
    }
    await streamArchiveFileToResponse(archive, index, res, config.cacheDir, config.masterKey);
    await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: index }]);
  } catch (err) {
    log("download", `error ${archive.id} file=${index} ${(err as Error).message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    return res.status(500).json({ error: "restore_failed" });
  }
});

apiRouter.get("/archives/:id/files/:index/thumbnail", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  let index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "bad_index" });
  }
  if (!archive.isBundle) {
    index = 0;
  }
  const file = archive.files?.[index];
  if (!file) {
    return res.status(404).json({ error: "file_not_found" });
  }
  if (isFileDeleted(file)) {
    return res.status(404).json({ error: "file_deleted" });
  }
  const fileName = file.originalName || file.name || archive.displayName || archive.name;
  if (!supportsThumbnail(fileName, file.detectedKind)) {
    return res.status(415).json({ error: "unsupported_thumbnail_type" });
  }

  try {
    const thumb = archive.status === "ready"
      ? await ensureArchiveThumbnail(archive, index)
      : await ensureArchiveThumbnailFromSource(archive, index);
    res.setHeader("Content-Type", thumb.contentType);
    res.setHeader("Content-Length", thumb.size);
    res.setHeader("Cache-Control", "private, max-age=3600");
    return fs.createReadStream(thumb.filePath).pipe(res);
  } catch (err) {
    const message = (err as Error).message || "thumbnail_failed";
    if (isPermanentThumbnailFailureMessage(message)) {
      return res.status(415).json({ error: "thumbnail_unavailable" });
    }
    log("thumb", `error ${archive.id} file=${index} ${message}`);
    if (message === "file_not_found") {
      return res.status(404).json({ error: "file_not_found" });
    }
    if (message === "source_missing") {
      return res.status(404).json({ error: "thumbnail_source_missing" });
    }
    return res.status(500).json({ error: "thumbnail_failed" });
  }
});

apiRouter.get("/archives/:id/preview", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }

  let fileIndex = 0;
  if (typeof req.query.fileIndex === "string" && req.query.fileIndex.length > 0) {
    fileIndex = Number(req.query.fileIndex);
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      return res.status(400).json({ error: "bad_index" });
    }
  }
  if (!archive.isBundle) {
    fileIndex = 0;
  }

  const file = archive.files?.[fileIndex];
  if (!file) {
    return res.status(404).json({ error: "file_not_found" });
  }
  if (isFileDeleted(file)) {
    return res.status(404).json({ error: "file_deleted" });
  }

  const previewMaxBytes = Math.max(1, Math.floor(config.previewMaxMiB * 1024 * 1024));
  const fileSize = Number(file.size || 0);
  if (fileSize > previewMaxBytes) {
    return res.status(413).json({ error: "preview_too_large", maxBytes: previewMaxBytes });
  }

  const fileName = (file.originalName || file.name || archive.downloadName || archive.name).replace(/[\\/]/g, "_");
  const ext = path.extname(fileName).toLowerCase();
  const detectedKind = String(file.detectedKind || "").toLowerCase();
  let detectedType = (mime.lookup(fileName) as string) || "application/octet-stream";
  if (detectedKind === "code" || (!detectedKind && ext === ".ts")) {
    detectedType = ext === ".md" || ext === ".markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
  }
  if (!isPreviewAllowedForFile(fileName, detectedType)) {
    return res.status(415).json({ error: "unsupported_preview_type" });
  }
  let contentType = resolvePreviewContentType(fileName, detectedType);

  const tempDir = path.join(config.cacheDir, "preview", `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const outputPath = path.join(tempDir, `${fileIndex}_${sanitizeName(fileName)}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    if (archive.isBundle) {
      await restoreArchiveFileToFile(archive, fileIndex, outputPath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(archive, outputPath, config.cacheDir, config.masterKey);
    }
    let servePath = outputPath;
    if (detectedKind === "video" && ext === ".ts") {
      const mp4Path = path.join(tempDir, `${fileIndex}_${sanitizeName(fileName)}.mp4`);
      const remuxed = await remuxTsToMp4(outputPath, mp4Path);
      if (remuxed) {
        servePath = mp4Path;
        contentType = "video/mp4";
      }
    }
    const body = await fs.promises.readFile(servePath);
    const encodedName = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, "%2A");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", body.length);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodedName}`);
    res.setHeader("Cache-Control", "private, max-age=60");
    void bumpPreviewCount(archive.id, fileIndex).catch(() => undefined);
    return res.end(body);
  } catch (err) {
    log("preview", `error ${archive.id} file=${fileIndex} ${(err as Error).message}`);
    return res.status(500).json({ error: "preview_failed" });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

apiRouter.get("/archives/:id/parts", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id).lean();
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }

  const parts = uniqueParts(archive.parts || []).map((part) => ({
    index: part.index,
    size: part.size,
    plainSize: part.plainSize || part.size,
    hash: part.hash,
    url: part.url,
    iv: part.iv || "",
    authTag: part.authTag || ""
  }));

  return res.json({
    archiveId: archive._id,
    status: archive.status,
    encryptionVersion: archive.encryptionVersion || 1,
    isBundle: archive.isBundle,
    chunkSizeBytes: archive.chunkSizeBytes || computed.chunkSizeBytes,
    iv: archive.iv,
    authTag: archive.authTag,
    originalSize: archive.originalSize,
    encryptedSize: archive.encryptedSize,
    downloadName: archive.downloadName,
    displayName: archive.displayName,
    files: (archive.files || []).map((file: any) => ({
      originalName: file.originalName || file.name,
      size: file.size
    })),
    parts
  });
});

apiRouter.post("/archives/:id/parts/:index/refresh", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "bad_index" });
  }
  const part = uniqueParts(archive.parts || []).find((p) => p.index === index);
  if (!part) {
    return res.status(404).json({ error: "part_not_found" });
  }

  try {
    const url = await refreshPartUrl(archive.id, part);
    return res.json({ ok: true, url });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message || "refresh_failed" });
  }
});

apiRouter.get("/archives/:id/parts/:index/relay", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) {
    return res.status(404).json({ error: "not_found" });
  }
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "bad_index" });
  }
  const part = uniqueParts(archive.parts || []).find((p) => p.index === index);
  if (!part?.url) {
    return res.status(404).json({ error: "part_not_found" });
  }

  const fetchWithRetry = async () => {
    let response = await outboundFetch(part.url);
    if (response.status === 404) {
      try {
        await refreshPartUrl(archive.id, part);
        response = await outboundFetch(part.url);
      } catch {
        // fall through with original response
      }
    }
    return response;
  };

  const response = await fetchWithRetry();
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    return res.status(502).json({ error: `relay_failed:${response.status}:${text}` });
  }

  res.setHeader("Content-Type", "application/octet-stream");
  if (part.size) {
    res.setHeader("Content-Length", part.size);
  }
  res.setHeader("Cache-Control", "no-store");

  try {
    const body = Readable.fromWeb(response.body as any);
    await pipeline(body, res);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ error: "relay_error" });
    }
  }
});

apiRouter.post("/archives/:id/files/:index/trash", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id);
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }
  if (!archive.isBundle || !Array.isArray(archive.files) || archive.files.length < 2) {
    return res.status(400).json({ error: "not_bundle" });
  }
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= archive.files.length) {
    return res.status(400).json({ error: "bad_index" });
  }
  if (isFileDeleted(archive.files[index])) {
    return res.status(409).json({ error: "already_deleted" });
  }

  archive.files[index].deletedAt = new Date();
  const remaining = activeBundleFileIndices(archive).length;
  if (remaining <= 0) {
    archive.trashedAt = new Date();
    archive.deleteTotalParts = uniqueParts(archive.parts || []).length;
    archive.deletedParts = 0;
  }
  await archive.save();
  log("api", `bundle file trash ${archive.id} file=${index} remaining=${remaining}`);
  return res.json({ ok: true, remaining, archiveTrashed: remaining <= 0 });
});

apiRouter.post("/archives/:id/trash", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id).lean();
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  await Archive.updateOne(
    { _id: req.params.id },
    { $set: { trashedAt: new Date(), deleteTotalParts: uniqueParts(archive.parts).length, deletedParts: 0 } }
  );
  log("api", `trash ${req.params.id}`);
  return res.json({ ok: true });
});

apiRouter.post("/archives/:id/restore", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id).lean();
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  await Archive.updateOne(
    { _id: req.params.id },
    { $set: { trashedAt: null, deleteRequestedAt: null, deleting: false, deletedParts: 0 } }
  );
  log("api", `restore ${req.params.id}`);
  return res.json({ ok: true });
});

apiRouter.post("/archives/:id/purge", requireAuth, async (req, res) => {
  const archive = await Archive.findById(req.params.id).lean();
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  await Archive.updateOne(
    { _id: req.params.id },
    { $set: { deleteRequestedAt: new Date(), deleteTotalParts: uniqueParts(archive.parts).length, deletedParts: 0 } }
  );
  log("api", `purge ${req.params.id}`);
  return res.json({ ok: true });
});

apiRouter.patch("/archives/:id/move", requireAuth, async (req, res) => {
  const { folderId } = req.body as { folderId?: string | null };
  const archive = await Archive.findById(req.params.id).lean();
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (folderId) {
    const folder = await Folder.findById(folderId);
    if (!folder || (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId)) {
      return res.status(400).json({ error: "invalid_folder" });
    }
    await Archive.updateOne({ _id: req.params.id }, { $set: { folderId: folder._id } });
  } else {
    await Archive.updateOne({ _id: req.params.id }, { $set: { folderId: null } });
  }
  return res.json({ ok: true });
});

apiRouter.get("/folders", requireAuth, async (req, res) => {
  const filter = req.session.role === "admin" ? {} : { userId: req.session.userId };
  const folders = await Folder.find(filter).sort({ name: 1 }).lean();
  res.json({ folders });
});

apiRouter.post("/folders", requireAuth, async (req, res) => {
  const { name, parentId } = req.body as { name?: string; parentId?: string | null };
  if (!name) return res.status(400).json({ error: "missing_name" });
  const safeName = sanitizeFilename(name.trim());
  let parentRef: any = null;
  if (parentId) {
    const parent = await Folder.findById(parentId);
    if (!parent || (req.session.role !== "admin" && parent.userId.toString() !== req.session.userId)) {
      return res.status(400).json({ error: "invalid_parent" });
    }
    parentRef = parent._id;
  }
  try {
    const folder = await Folder.create({ userId: req.session.userId, name: safeName, parentId: parentRef, priority: 2 });
    log("api", `folder create ${folder.id} name=${safeName}`);
    res.json({ id: folder.id });
  } catch (err: any) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "folder_exists" });
    }
    throw err;
  }
});

apiRouter.patch("/folders/:id", requireAuth, async (req, res) => {
  const { priority, name, parentId } = req.body as { priority?: number; name?: string; parentId?: string | null };
  const folder = await Folder.findById(req.params.id);
  if (!folder) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (typeof name === "string" && name.trim().length > 0) {
    const safeName = sanitizeFilename(name.trim());
    if (safeName !== folder.name) {
      folder.name = safeName;
    }
  }
  if (typeof priority === "number") {
    folder.priority = priority;
    await Archive.updateMany(
      { folderId: folder._id, priorityOverride: false },
      { $set: { priority } }
    );
    log("api", `folder priority ${folder.id}=${priority}`);
  }
  if (parentId !== undefined) {
    const nextParentId = parentId ? parentId.toString() : null;
    if (nextParentId && nextParentId === folder._id.toString()) {
      return res.status(400).json({ error: "invalid_parent" });
    }
    if (nextParentId) {
      const parent = await Folder.findById(nextParentId);
      if (!parent || (req.session.role !== "admin" && parent.userId.toString() !== req.session.userId)) {
        return res.status(400).json({ error: "invalid_parent" });
      }
      const descendants = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
      if (descendants.includes(nextParentId)) {
        return res.status(400).json({ error: "invalid_parent" });
      }
      folder.parentId = parent._id;
    } else {
      folder.parentId = null;
    }
  }
  try {
    await folder.save();
  } catch (err: any) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "folder_exists" });
    }
    throw err;
  }
  return res.json({ ok: true });
});

apiRouter.delete("/folders/:id", requireAuth, async (req, res) => {
  const folder = await Folder.findById(req.params.id).lean();
  if (!folder) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }

  const descendantIds = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
  const archives = await Archive.find({
    userId: folder.userId,
    folderId: { $in: descendantIds },
    trashedAt: null,
    deletedAt: null
  }).lean();
  const now = new Date();
  await Promise.all(
    archives.map((archive) => (
      Archive.updateOne(
        { _id: archive._id },
        { $set: { trashedAt: now, deleteTotalParts: uniqueParts(archive.parts).length, deletedParts: 0 } }
      )
    ))
  );

  const archiveIds = archives.map((a) => a._id);
  await Share.deleteMany({
    userId: folder.userId,
    $or: [
      { folderId: { $in: descendantIds } },
      ...(archiveIds.length > 0 ? [{ archiveId: { $in: archiveIds } }] : [])
    ]
  });
  await Folder.deleteMany({ _id: { $in: descendantIds } });
  log("api", `folder delete ${folder._id} archives=${archives.length}`);
  return res.json({ ok: true });
});

apiRouter.get("/folders/:id/info", requireAuth, async (req, res) => {
  const folder = await Folder.findById(req.params.id).lean();
  if (!folder) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  const descendants = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
  const archives = await Archive.find({
    folderId: { $in: descendants },
    trashedAt: null,
    deletedAt: null
  }).lean();
  const totalSize = archives.reduce((sum, a) => sum + (a.originalSize || 0), 0);
  const totalArchives = archives.length;
  const totalFiles = archives.reduce((sum, a) => sum + activeBundleFileIndices(a).length, 0);
  const totalParts = archives.reduce((sum, a) => {
    if ((a.totalParts || 0) > 0) {
      return sum + (a.totalParts || 0);
    }
    return sum + uniqueParts(a.parts || []).length;
  }, 0);
  res.json({ totalSize, totalArchives, totalFiles, totalParts });
});

apiRouter.get("/folders/:id/download", requireAuth, async (req, res) => {
  const folder = await Folder.findById(req.params.id).lean();
  if (!folder) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }

  const descendants = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
  const archives = await Archive.find({
    folderId: { $in: descendants },
    trashedAt: null,
    deletedAt: null
  }).lean();
  const notReady = archives.find((a) => a.status !== "ready");
  if (notReady) {
    return res.status(409).json({ error: "not_ready" });
  }

  const folderDocs = await Folder.find({ _id: { $in: descendants } }).lean();
  const folderMap = new Map(folderDocs.map((f) => [f._id.toString(), f]));

  const buildRelativePath = (folderId: string) => {
    const parts: string[] = [];
    let current = folderMap.get(folderId) || null;
    while (current && current._id.toString() !== folder._id.toString()) {
      parts.unshift(current.name);
      const parentId = current.parentId ? current.parentId.toString() : null;
      current = parentId ? folderMap.get(parentId) || null : null;
    }
    return parts.join("/");
  };

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=\"${sanitizeName(folder.name)}.zip\"`);

  const zip = archiver("zip", { zlib: { level: 0 } });
  zip.on("error", () => {
    res.status(500).end();
  });
  zip.pipe(res);

  const tempDir = path.join(config.cacheDir, "folder_dl", `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  res.on("close", async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  try {
    const downloadTargets: { archiveId: string; fileIndex: number }[] = [];
    let index = 0;
    for (const archive of archives) {
      const relPath = archive.folderId ? buildRelativePath(archive.folderId.toString()) : "";
      if (archive.isBundle && archive.files?.length > 1) {
        const activeIndices = activeBundleFileIndices(archive);
        for (const i of activeIndices) {
          const file = archive.files[i];
          const outputName = file.originalName || file.name;
          const safeName = sanitizeName(outputName);
          const outputPath = path.join(tempDir, `${index}_${safeName}`);
          index += 1;
          await restoreArchiveFileToFile(archive as any, i, outputPath, config.cacheDir, config.masterKey);
          const entryName = relPath ? `${relPath}/${outputName}` : outputName;
          zip.file(outputPath, { name: entryName });
          downloadTargets.push({ archiveId: archive._id.toString(), fileIndex: i });
        }
      } else {
        const file = archive.files?.find((f: any) => !isFileDeleted(f));
        if (!file) {
          continue;
        }
        const outputName = file?.originalName || file?.name || archive.downloadName || archive.name;
        const safeName = sanitizeName(outputName);
        const outputPath = path.join(tempDir, `${index}_${safeName}`);
        index += 1;
        await restoreArchiveToFile(archive as any, outputPath, config.cacheDir, config.masterKey);
        const entryName = relPath ? `${relPath}/${outputName}` : outputName;
        zip.file(outputPath, { name: entryName });
        downloadTargets.push({ archiveId: archive._id.toString(), fileIndex: 0 });
      }
    }

    await zip.finalize();
    await bumpDownloadCounts(downloadTargets);
  } finally {
    // cleanup on close
  }
});

apiRouter.post("/shares", requireAuth, async (req, res) => {
  const { archiveId, folderId, expiresAt } = req.body as {
    archiveId?: string;
    folderId?: string;
    expiresAt?: string | null;
  };
  if (!archiveId && !folderId) {
    return res.status(400).json({ error: "missing_target" });
  }

  let type: "archive" | "folder";
  let archiveRef: any = null;
  let folderRef: any = null;

  if (archiveId) {
    const archive = await Archive.findById(archiveId).lean();
    if (!archive) return res.status(404).json({ error: "not_found" });
    if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
      return res.status(403).json({ error: "forbidden" });
    }
    type = "archive";
    archiveRef = archive._id;
  } else {
    const folder = await Folder.findById(folderId);
    if (!folder) return res.status(404).json({ error: "not_found" });
    if (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId) {
      return res.status(403).json({ error: "forbidden" });
    }
    type = "folder";
    folderRef = folder._id;
  }

  let expiry: Date | null = null;
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: "bad_expires" });
    }
    expiry = parsed;
  }

  const token = nanoid(16);
  const share = await Share.create({
    token,
    userId: req.session.userId,
    type,
    archiveId: archiveRef,
    folderId: folderRef,
    expiresAt: expiry
  });
  res.json({ id: share.id, token: share.token, expiresAt: share.expiresAt });
});

apiRouter.get("/shares", requireAuth, async (req, res) => {
  const onlyActive = req.query.active === "1";
  const filter: Record<string, unknown> = { userId: req.session.userId };
  if (onlyActive) {
    filter.$or = [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }];
  }
  const shares = await Share.find(filter).sort({ createdAt: -1 }).lean();

  const archiveIds = shares.filter((s) => s.archiveId).map((s) => s.archiveId);
  const folderIds = shares.filter((s) => s.folderId).map((s) => s.folderId);
  const archives = await Archive.find({ _id: { $in: archiveIds } })
    .select("displayName name status isBundle files.originalName files.name files.size files.detectedKind files.deletedAt")
    .lean();
  const folders = await Folder.find({ _id: { $in: folderIds } })
    .select("name")
    .lean();

  const archiveMap = new Map(archives.map((a) => [a._id.toString(), a]));
  const folderMap = new Map(folders.map((f) => [f._id.toString(), f]));

  const payload = shares.map((s) => {
    let name = "Shared item";
    let archiveId: string | null = null;
    let folderId: string | null = null;
    let archiveStatus: string | null = null;
    let archiveIsBundle = false;
    let archiveFirstFileName = "";
    let archiveFirstFileKind = "";
    let previewSupported = false;
    if (s.archiveId) {
      archiveId = s.archiveId.toString();
      const a = archiveMap.get(archiveId) as any;
      name = a?.displayName || a?.name || name;
      archiveStatus = a?.status || null;
      archiveIsBundle = !!a?.isBundle;
      const firstFile = Array.isArray(a?.files)
        ? a.files.find((f: any) => !isFileDeleted(f))
        : null;
      archiveFirstFileName = firstFile?.originalName || firstFile?.name || "";
      archiveFirstFileKind = firstFile?.detectedKind || "";
      previewSupported = !!(a && firstFile && isPreviewSupportedForFile(a, firstFile));
    } else if (s.folderId) {
      folderId = s.folderId.toString();
      const f = folderMap.get(folderId);
      name = f?.name || name;
    }
    return {
      id: s._id,
      token: s.token,
      type: s.type,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      name,
      archiveId,
      folderId,
      archiveStatus,
      archiveIsBundle,
      archiveFirstFileName,
      archiveFirstFileKind,
      previewSupported
    };
  });

  res.json({ shares: payload });
});

apiRouter.delete("/shares/:id", requireAuth, async (req, res) => {
  const share = await Share.findById(req.params.id);
  if (!share) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && share.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  await Share.deleteOne({ _id: share._id });
  res.json({ ok: true });
});

apiRouter.patch("/archives/:id/priority", requireAuth, async (req, res) => {
  const { priority } = req.body as { priority?: number };
  const archive = await Archive.findById(req.params.id);
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (typeof priority !== "number") {
    return res.status(400).json({ error: "missing_priority" });
  }
  await Archive.updateOne(
    { _id: req.params.id },
    { $set: { priority, priorityOverride: true } }
  );
  log("api", `file priority ${req.params.id}=${priority}`);
  return res.json({ ok: true });
});

apiRouter.patch("/archives/:id/rename", requireAuth, async (req, res) => {
  const { name, fileIndex } = req.body as { name?: string; fileIndex?: number };
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "missing_name" });
  }
  const safeName = sanitizeFilename(name);
  const archive = await Archive.findById(req.params.id);
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }

  if (typeof fileIndex === "number") {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || !archive.files?.[fileIndex]) {
      return res.status(400).json({ error: "bad_index" });
    }
    if (isFileDeleted(archive.files[fileIndex])) {
      return res.status(404).json({ error: "file_deleted" });
    }
    archive.files[fileIndex].originalName = safeName;
    archive.files[fileIndex].contentModifiedAt = new Date();
    if (!archive.isBundle && fileIndex === 0) {
      archive.displayName = safeName;
      archive.downloadName = safeName;
      archive.contentModifiedAt = new Date();
    }
  } else {
    archive.displayName = safeName;
    archive.downloadName = safeName;
    archive.contentModifiedAt = new Date();
    if (archive.files?.[0]) {
      archive.files[0].originalName = safeName;
      archive.files[0].contentModifiedAt = new Date();
    }
  }

  await archive.save();
  log("api", `rename ${archive.id} name=${safeName}`);
  return res.json({ ok: true });
});

apiRouter.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(413).json({ error: "too_many_files" });
    }
    return res.status(400).json({ error: "upload_error" });
  }
  return next(err);
});
