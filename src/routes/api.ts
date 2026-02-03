import { Router } from "express";
import path from "path";
import fs from "fs";
import archiver from "archiver";
import multer from "multer";
import busboy from "busboy";
import crypto from "crypto";
import { nanoid } from "nanoid";
import { checkDiskSpace } from "../services/disk.js";
import { requireAuth } from "../auth.js";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { Share } from "../models/Share.js";
import { User } from "../models/User.js";
import { config, computed } from "../config.js";
import { restoreArchiveFileToFile, restoreArchiveToFile, streamArchiveFileToResponse, streamArchiveToResponse } from "../services/restore.js";
import { uniqueParts } from "../services/parts.js";
import { log } from "../logger.js";
import { getDescendantFolderIds } from "../services/folders.js";
import { Webhook } from "../models/Webhook.js";
import { deriveKey } from "../services/crypto.js";
import { uploadBufferToWebhook, uploadToWebhook } from "../services/discord.js";

const upload = multer({ dest: path.join(config.cacheDir, "uploads_tmp") });

export const apiRouter = Router();

function sanitizeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function makeDisplayName(files: Express.Multer.File[]) {
  if (files.length === 1) {
    return files[0].originalname.replace(/[\\/]/g, "_");
  }
  return `Bundle (${files.length} files)`;
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

function splitUploads(files: Express.Multer.File[]) {
  const groups: Express.Multer.File[][] = [];
  let current: Express.Multer.File[] = [];
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

apiRouter.post("/upload", requireAuth, upload.array("files", 200), async (req, res) => {
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
  const groups = splitUploads(files);
  const archiveIds: string[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    const isBundle = group.length > 1;
    const ordered = isBundle ? [...group].sort((a, b) => a.size - b.size) : group;
    const displayName = makeDisplayName(ordered);
    const downloadName = isBundle
      ? `bundle_${Date.now()}_${groupIndex}.zip`
      : ordered[0].originalname.replace(/[\\/]/g, "_");
    const archiveName = sanitizeName(downloadName);
    stagingDir = path.join(
      config.cacheDir,
      "uploads",
      new Date().toISOString().slice(0, 10),
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${groupIndex}`
    );
    await fs.promises.mkdir(stagingDir, { recursive: true });

    const archiveFiles = [] as { path: string; name: string; originalName: string; size: number }[];
    for (const [index, file] of ordered.entries()) {
      const safeName = `${index}_${sanitizeName(file.originalname)}`;
      const dest = path.join(stagingDir, safeName);
      await fs.promises.rename(file.path, dest);
      archiveFiles.push({ path: dest, name: safeName, originalName: file.originalname, size: file.size });
    }

    if (aborted || req.aborted) {
      await cleanup();
      return;
    }

    const groupSize = ordered.reduce((sum, f) => sum + f.size, 0);

    const archive = await Archive.create({
      userId: user.id,
      name: archiveName,
      displayName,
      downloadName,
      isBundle,
      folderId: folderRef,
      priority: basePriority,
      priorityOverride: false,
      status: "queued",
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

  let folderId: string | null = null;
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
  });

  bb.on("file", (name: string, file: NodeJS.ReadableStream, info: { filename?: string }) => {
    const filename = (info?.filename || "file").toString();
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

      const archive = await Archive.create({
        userId: user.id,
        name: sanitizeName(safeName),
        displayName: safeName,
        downloadName: safeName,
        isBundle: false,
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
        files: [{ path: rawPath, name: path.basename(rawPath), originalName: safeName, size: 0 }],
        parts: []
      });

      archiveId = archive.id;
      log("stream", `upload start archive=${archive.id} user=${user.id} name=${safeName}`);

      const workDir = path.join(config.cacheDir, "work", `stream_${archive.id}`);
      if (useDisk) {
        await fs.promises.mkdir(workDir, { recursive: true });
      }

      const key = deriveKey(config.masterKey);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      let encryptedBytes = 0;
      let partIndex = 0;
      let originalSize = 0;
      let failed: Error | null = null;
      let uploadedPartsCount = 0;

      let active = 0;
      const pending: { index: number; buffer: Buffer; size: number; hash: string }[] = [];
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
              hash: part.hash,
              url: result.url,
              messageId: result.messageId,
              webhookId: webhook.id
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

      const enqueuePart = async (buffer: Buffer, index: number) => {
        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        pending.push({ index, buffer, size: buffer.length, hash });
        scheduleUploads();
        await waitForPendingSpace();
      };

      file.on("data", (chunk: Buffer) => {
        originalSize += chunk.length;
      });
      file.on("error", (err) => {
        failed = err instanceof Error ? err : new Error("stream_failed");
      });

      if (rawWrite) {
        file.pipe(rawWrite);
      }
      file.pipe(cipher);
      file.resume();

      let buffer = Buffer.alloc(0);
      for await (const chunk of cipher) {
        if (failed) break;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= computed.chunkSizeBytes) {
          const part = buffer.subarray(0, computed.chunkSizeBytes);
          buffer = buffer.subarray(computed.chunkSizeBytes);
          encryptedBytes += part.length;
          await enqueuePart(part, partIndex);
          partIndex += 1;
        }
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

      const authTag = cipher.getAuthTag();
      await Archive.updateOne(
        { _id: archive.id },
        {
          $set: {
            iv: iv.toString("base64"),
            authTag: authTag.toString("base64"),
            encryptedSize: encryptedBytes,
            totalParts: partIndex,
            originalSize,
            "files.0.size": originalSize
          }
        }
      );

      await User.updateOne({ _id: user.id }, { $inc: { usedBytes: originalSize } });

      uploadDone = uploadsFinished.then(async () => {
        if (failed) {
          await Archive.updateOne({ _id: archive.id }, { $set: { status: "error", error: failed?.message || "upload_failed" } });
          log("stream", `upload failed archive=${archive.id} err=${failed?.message || "upload_failed"}`);
          return;
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
  return res.json({ archives });
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
    log("download", `start ${archive.id}`);
    await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
  } catch (err) {
    log("download", `error ${archive.id} ${(err as Error).message}`);
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
    let index = 0;
    const nameCounts = new Map<string, number>();
    for (const item of items) {
      const archive = archiveMap.get(item.archiveId);
      if (!archive) continue;
      const fileIndex = Number.isInteger(item.fileIndex) ? (item.fileIndex as number) : 0;

      let outputName = archive.downloadName || archive.name;
      if (archive.isBundle && archive.files?.[fileIndex]) {
        outputName = archive.files[fileIndex].originalName || archive.files[fileIndex].name;
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
      } else {
        await restoreArchiveToFile(archive, outputPath, config.cacheDir, config.masterKey);
      }

      zip.file(outputPath, { name: finalName });
    }

    await zip.finalize();
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

  try {
    log("download", `start ${archive.id} file=${index}`);
    if (!archive.isBundle) {
      await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
      return;
    }
    await streamArchiveFileToResponse(archive, index, res, config.cacheDir, config.masterKey);
  } catch (err) {
    log("download", `error ${archive.id} file=${index} ${(err as Error).message}`);
    return res.status(500).json({ error: "restore_failed" });
  }
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
  let parentRef: any = null;
  if (parentId) {
    const parent = await Folder.findById(parentId);
    if (!parent || (req.session.role !== "admin" && parent.userId.toString() !== req.session.userId)) {
      return res.status(400).json({ error: "invalid_parent" });
    }
    parentRef = parent._id;
  }
  try {
    const folder = await Folder.create({ userId: req.session.userId, name, parentId: parentRef, priority: 2 });
    log("api", `folder create ${folder.id} name=${name}`);
    res.json({ id: folder.id });
  } catch (err: any) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "folder_exists" });
    }
    throw err;
  }
});

apiRouter.patch("/folders/:id", requireAuth, async (req, res) => {
  const { priority, name } = req.body as { priority?: number; name?: string };
  const folder = await Folder.findById(req.params.id);
  if (!folder) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && folder.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (typeof name === "string" && name.trim().length > 0 && name.trim() !== folder.name) {
    folder.name = name.trim();
  }
  if (typeof priority === "number") {
    folder.priority = priority;
    await Archive.updateMany(
      { folderId: folder._id, priorityOverride: false },
      { $set: { priority } }
    );
    log("api", `folder priority ${folder.id}=${priority}`);
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
  const totalFiles = archives.reduce((sum, a) => sum + (a.files?.length || 0), 0);
  res.json({ totalSize, totalArchives, totalFiles });
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
    let index = 0;
    for (const archive of archives) {
      const relPath = archive.folderId ? buildRelativePath(archive.folderId.toString()) : "";
      if (archive.isBundle && archive.files?.length > 1) {
        for (let i = 0; i < archive.files.length; i += 1) {
          const file = archive.files[i];
          const outputName = file.originalName || file.name;
          const safeName = sanitizeName(outputName);
          const outputPath = path.join(tempDir, `${index}_${safeName}`);
          index += 1;
          await restoreArchiveFileToFile(archive as any, i, outputPath, config.cacheDir, config.masterKey);
          const entryName = relPath ? `${relPath}/${outputName}` : outputName;
          zip.file(outputPath, { name: entryName });
        }
      } else {
        const file = archive.files?.[0];
        const outputName = file?.originalName || file?.name || archive.downloadName || archive.name;
        const safeName = sanitizeName(outputName);
        const outputPath = path.join(tempDir, `${index}_${safeName}`);
        index += 1;
        await restoreArchiveToFile(archive as any, outputPath, config.cacheDir, config.masterKey);
        const entryName = relPath ? `${relPath}/${outputName}` : outputName;
        zip.file(outputPath, { name: entryName });
      }
    }

    await zip.finalize();
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
    .select("displayName name")
    .lean();
  const folders = await Folder.find({ _id: { $in: folderIds } })
    .select("name")
    .lean();

  const archiveMap = new Map(archives.map((a) => [a._id.toString(), a]));
  const folderMap = new Map(folders.map((f) => [f._id.toString(), f]));

  const payload = shares.map((s) => {
    let name = "Shared item";
    if (s.archiveId) {
      const a = archiveMap.get(s.archiveId.toString());
      name = a?.displayName || a?.name || name;
    } else if (s.folderId) {
      const f = folderMap.get(s.folderId.toString());
      name = f?.name || name;
    }
    return {
      id: s._id,
      token: s.token,
      type: s.type,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      name
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
  const safeName = name.replace(/[\\/]/g, "_");
  const archive = await Archive.findById(req.params.id);
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (req.session.role !== "admin" && archive.userId.toString() !== req.session.userId) {
    return res.status(403).json({ error: "forbidden" });
  }

  if (typeof fileIndex === "number") {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || !archive.files?.[fileIndex]) {
      return res.status(400).json({ error: "bad_index" });
    }
    archive.files[fileIndex].originalName = safeName;
    if (!archive.isBundle && fileIndex === 0) {
      archive.displayName = safeName;
      archive.downloadName = safeName;
    }
  } else {
    archive.displayName = safeName;
    archive.downloadName = safeName;
    if (archive.files?.[0]) {
      archive.files[0].originalName = safeName;
    }
  }

  await archive.save();
  log("api", `rename ${archive.id} name=${safeName}`);
  return res.json({ ok: true });
});
