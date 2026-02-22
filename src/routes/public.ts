import fs from "fs";
import mime from "mime-types";
import path from "path";
import { Router } from "express";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { Share } from "../models/Share.js";
import { config } from "../config.js";
import { getDescendantFolderIds } from "../services/folders.js";
import {
  restoreArchiveFileToFile,
  restoreArchiveToFile,
  streamArchiveFileToResponse,
  streamArchiveToResponse
} from "../services/restore.js";
import { bumpDownloadCounts } from "../services/downloadCounts.js";
import { bumpPreviewCount } from "../services/previewCounts.js";
import { ensureArchiveThumbnail, supportsThumbnail } from "../services/thumbnails.js";
import { remuxTsToMp4 } from "../services/videoPreview.js";
import { sanitizeFilename } from "../utils/names.js";
import { isPreviewAllowedForFile, resolvePreviewContentType } from "../services/preview.js";
import { log } from "../logger.js";

export const publicRouter = Router();
type ResolveArchiveSuccess = { share: any; archive: any };
type ResolveArchiveError = { status: number; error: "not_found" | "expired" | "archive_required" };
type ResolveArchiveResult = ResolveArchiveSuccess | ResolveArchiveError;

function isExpired(expiresAt?: Date | null) {
  return !!expiresAt && expiresAt.getTime() <= Date.now();
}

function inlineContentDisposition(filename: string) {
  const safeName = filename.replace(/[\\/]/g, "_");
  const encoded = encodeURIComponent(safeName).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `inline; filename*=UTF-8''${encoded}`;
}

function parsePreviewIndex(rawValue: unknown) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return 0;
  const value = Number(rawValue);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function isFileDeleted(file: any) {
  return !!file?.deletedAt;
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

async function resolveArchiveByShare(token: string, archiveId?: string): Promise<ResolveArchiveResult> {
  const share = await Share.findOne({ token }).lean();
  if (!share) return { status: 404, error: "not_found" as const };
  if (isExpired(share.expiresAt)) return { status: 410, error: "expired" as const };

  if (share.type === "archive" && share.archiveId) {
    const shareArchiveId = share.archiveId.toString();
    if (archiveId && archiveId !== shareArchiveId) {
      return { status: 404, error: "not_found" as const };
    }
    const archive = await Archive.findById(share.archiveId);
    if (!archive) return { status: 404, error: "not_found" as const };
    return { share, archive };
  }

  if (share.type === "folder" && share.folderId) {
    if (!archiveId) return { status: 400, error: "archive_required" as const };
    const folder = await Folder.findById(share.folderId).lean();
    if (!folder) return { status: 404, error: "not_found" as const };
    const descendants = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
    const archive = await Archive.findOne({
      _id: archiveId,
      folderId: { $in: descendants },
      deletedAt: null,
      trashedAt: null
    });
    if (!archive) return { status: 404, error: "not_found" as const };
    return { share, archive };
  }

  return { status: 404, error: "not_found" as const };
}

publicRouter.get("/api/public/shares/:token", async (req, res) => {
  const share = await Share.findOne({ token: req.params.token }).lean();
  if (!share) return res.status(404).json({ error: "not_found" });
  if (isExpired(share.expiresAt)) return res.status(410).json({ error: "expired" });

  if (share.type === "archive" && share.archiveId) {
    const archive = await Archive.findById(share.archiveId).lean();
    if (!archive) return res.status(404).json({ error: "not_found" });
    return res.json({
      type: "archive",
      name: archive.displayName || archive.name,
      expiresAt: share.expiresAt,
      archive: {
        id: archive._id,
        status: archive.status,
        originalSize: archive.originalSize,
        createdAt: archive.createdAt,
        isBundle: archive.isBundle,
        files: (archive.files || [])
          .map((f: any, idx: number) => ({ ...f, fileIndex: idx }))
          .filter((f: any) => !isFileDeleted(f))
      }
    });
  }

  if (share.type === "folder" && share.folderId) {
    const folder = await Folder.findById(share.folderId).lean();
    if (!folder) return res.status(404).json({ error: "not_found" });
    const descendants = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
    const archives = await Archive.find({
      folderId: { $in: descendants },
      deletedAt: null,
      trashedAt: null
    })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({
      type: "folder",
      name: folder.name,
      expiresAt: share.expiresAt,
      archives: archives.map((a) => ({
        id: a._id,
        name: a.displayName || a.name,
        status: a.status,
        originalSize: a.originalSize,
        createdAt: a.createdAt,
        isBundle: a.isBundle,
        files: (a.files || [])
          .map((f: any, idx: number) => ({ ...f, fileIndex: idx }))
          .filter((f: any) => !isFileDeleted(f))
      }))
    });
  }

  return res.status(404).json({ error: "not_found" });
});

publicRouter.get("/api/public/shares/:token/download", async (req, res) => {
  const resolved = await resolveArchiveByShare(req.params.token);
  if (!("archive" in resolved)) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  const { archive } = resolved;
  if (archive.status !== "ready") return res.status(409).json({ error: "not_ready" });

  try {
    const fileIndex = req.query.fileIndex ? Number(req.query.fileIndex) : null;
    if (archive.isBundle && Number.isInteger(fileIndex)) {
      const file = archive.files?.[fileIndex as number];
      if (!file || isFileDeleted(file)) {
        return res.status(404).json({ error: "file_not_found" });
      }
      await streamArchiveFileToResponse(archive, fileIndex as number, res, config.cacheDir, config.masterKey);
      await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: fileIndex as number }]);
      return;
    }
    if (!archive.isBundle && archive.files?.[0] && isFileDeleted(archive.files[0])) {
      return res.status(404).json({ error: "file_not_found" });
    }
    await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
    const targets: { archiveId: string; fileIndex: number }[] = [];
    if (archive.isBundle && archive.files && archive.files.length > 1) {
      for (const i of activeBundleFileIndices(archive)) {
        targets.push({ archiveId: archive.id, fileIndex: i });
      }
    } else {
      targets.push({ archiveId: archive.id, fileIndex: 0 });
    }
    await bumpDownloadCounts(targets);
  } catch {
    return res.status(500).json({ error: "restore_failed" });
  }
});

publicRouter.get("/api/public/shares/:token/archive/:archiveId/download", async (req, res) => {
  const resolved = await resolveArchiveByShare(req.params.token, req.params.archiveId);
  if (!("archive" in resolved)) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  const { archive } = resolved;
  if (archive.status !== "ready") return res.status(409).json({ error: "not_ready" });

  try {
    const fileIndex = req.query.fileIndex ? Number(req.query.fileIndex) : null;
    if (archive.isBundle && Number.isInteger(fileIndex)) {
      const file = archive.files?.[fileIndex as number];
      if (!file || isFileDeleted(file)) {
        return res.status(404).json({ error: "file_not_found" });
      }
      await streamArchiveFileToResponse(archive, fileIndex as number, res, config.cacheDir, config.masterKey);
      await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: fileIndex as number }]);
      return;
    }
    if (!archive.isBundle && archive.files?.[0] && isFileDeleted(archive.files[0])) {
      return res.status(404).json({ error: "file_not_found" });
    }
    await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
    const targets: { archiveId: string; fileIndex: number }[] = [];
    if (archive.isBundle && archive.files && archive.files.length > 1) {
      for (const i of activeBundleFileIndices(archive)) {
        targets.push({ archiveId: archive.id, fileIndex: i });
      }
    } else {
      targets.push({ archiveId: archive.id, fileIndex: 0 });
    }
    await bumpDownloadCounts(targets);
  } catch {
    return res.status(500).json({ error: "restore_failed" });
  }
});

publicRouter.get("/api/public/shares/:token/archive/:archiveId/files/:index/thumbnail", async (req, res) => {
  const resolved = await resolveArchiveByShare(req.params.token, req.params.archiveId);
  if (!("archive" in resolved)) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  const { archive } = resolved;
  if (archive.status !== "ready") return res.status(409).json({ error: "not_ready" });

  let fileIndex = Number(req.params.index);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return res.status(400).json({ error: "bad_index" });
  }
  if (!archive.isBundle) {
    fileIndex = 0;
  }
  const file = archive.files?.[fileIndex];
  if (!file) {
    return res.status(404).json({ error: "file_not_found" });
  }
  if (isFileDeleted(file)) {
    return res.status(404).json({ error: "file_not_found" });
  }

  const fileName = file.originalName || file.name || archive.displayName || archive.name;
  if (!supportsThumbnail(fileName, file.detectedKind)) {
    return res.status(415).json({ error: "unsupported_thumbnail_type" });
  }

  try {
    const thumb = await ensureArchiveThumbnail(archive, fileIndex);
    res.setHeader("Content-Type", thumb.contentType);
    res.setHeader("Content-Length", thumb.size);
    res.setHeader("Cache-Control", "private, max-age=3600");
    return fs.createReadStream(thumb.filePath).pipe(res);
  } catch (err) {
    const message = (err as Error).message || "thumbnail_failed";
    log("thumb", `public error ${archive.id} file=${fileIndex} ${message}`);
    if (message === "file_not_found") {
      return res.status(404).json({ error: "file_not_found" });
    }
    return res.status(500).json({ error: "thumbnail_failed" });
  }
});

publicRouter.get("/api/public/shares/:token/archive/:archiveId/preview", async (req, res) => {
  const resolved = await resolveArchiveByShare(req.params.token, req.params.archiveId);
  if (!("archive" in resolved)) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  const { archive } = resolved;
  if (archive.status !== "ready") {
    return res.status(409).json({ error: "not_ready" });
  }

  let fileIndex = parsePreviewIndex(req.query.fileIndex);
  if (fileIndex < 0) {
    return res.status(400).json({ error: "bad_index" });
  }
  if (!archive.isBundle) {
    fileIndex = 0;
  }

  const file = archive.files?.[fileIndex];
  if (!file) {
    return res.status(404).json({ error: "file_not_found" });
  }
  if (isFileDeleted(file)) {
    return res.status(404).json({ error: "file_not_found" });
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

  const tempDir = path.join(
    config.cacheDir,
    "preview_public",
    `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const outputPath = path.join(tempDir, `${fileIndex}_${sanitizeFilename(fileName)}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    if (archive.isBundle) {
      await restoreArchiveFileToFile(archive, fileIndex, outputPath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(archive, outputPath, config.cacheDir, config.masterKey);
    }
    let servePath = outputPath;
    if (detectedKind === "video" && ext === ".ts") {
      const mp4Path = path.join(tempDir, `${fileIndex}_${sanitizeFilename(fileName)}.mp4`);
      const remuxed = await remuxTsToMp4(outputPath, mp4Path);
      if (remuxed) {
        servePath = mp4Path;
        contentType = "video/mp4";
      }
    }
    const body = await fs.promises.readFile(servePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", body.length);
    res.setHeader("Content-Disposition", inlineContentDisposition(fileName));
    res.setHeader("Cache-Control", "private, max-age=60");
    void bumpPreviewCount(archive.id, fileIndex).catch(() => undefined);
    return res.end(body);
  } catch (err) {
    log("preview", `public error ${archive.id} file=${fileIndex} ${(err as Error).message}`);
    return res.status(500).json({ error: "preview_failed" });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
