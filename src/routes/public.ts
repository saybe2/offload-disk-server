import { Router } from "express";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { Share } from "../models/Share.js";
import { config } from "../config.js";
import { getDescendantFolderIds } from "../services/folders.js";
import { streamArchiveFileToResponse, streamArchiveToResponse } from "../services/restore.js";
import { bumpDownloadCounts } from "../services/downloadCounts.js";

export const publicRouter = Router();

function isExpired(expiresAt?: Date | null) {
  return !!expiresAt && expiresAt.getTime() <= Date.now();
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
        files: archive.files || []
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
        files: a.files || []
      }))
    });
  }

  return res.status(404).json({ error: "not_found" });
});

publicRouter.get("/api/public/shares/:token/download", async (req, res) => {
  const share = await Share.findOne({ token: req.params.token }).lean();
  if (!share) return res.status(404).json({ error: "not_found" });
  if (isExpired(share.expiresAt)) return res.status(410).json({ error: "expired" });
  if (share.type !== "archive" || !share.archiveId) {
    return res.status(400).json({ error: "bad_share" });
  }

  const archive = await Archive.findById(share.archiveId);
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (archive.status !== "ready") return res.status(409).json({ error: "not_ready" });

  try {
    const fileIndex = req.query.fileIndex ? Number(req.query.fileIndex) : null;
    if (archive.isBundle && Number.isInteger(fileIndex)) {
      await streamArchiveFileToResponse(archive, fileIndex as number, res, config.cacheDir, config.masterKey);
      await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: fileIndex as number }]);
      return;
    }
    await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
    const targets: { archiveId: string; fileIndex: number }[] = [];
    if (archive.isBundle && archive.files && archive.files.length > 1) {
      for (let i = 0; i < archive.files.length; i += 1) {
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
  const share = await Share.findOne({ token: req.params.token }).lean();
  if (!share) return res.status(404).json({ error: "not_found" });
  if (isExpired(share.expiresAt)) return res.status(410).json({ error: "expired" });
  if (share.type !== "folder" || !share.folderId) {
    return res.status(400).json({ error: "bad_share" });
  }

  const folder = await Folder.findById(share.folderId).lean();
  if (!folder) return res.status(404).json({ error: "not_found" });
  const descendants = await getDescendantFolderIds(folder.userId.toString(), folder._id.toString());
  const archive = await Archive.findOne({ _id: req.params.archiveId, folderId: { $in: descendants } });
  if (!archive) return res.status(404).json({ error: "not_found" });
  if (archive.status !== "ready") return res.status(409).json({ error: "not_ready" });

  try {
    const fileIndex = req.query.fileIndex ? Number(req.query.fileIndex) : null;
    if (archive.isBundle && Number.isInteger(fileIndex)) {
      await streamArchiveFileToResponse(archive, fileIndex as number, res, config.cacheDir, config.masterKey);
      await bumpDownloadCounts([{ archiveId: archive.id, fileIndex: fileIndex as number }]);
      return;
    }
    await streamArchiveToResponse(archive, res, config.cacheDir, config.masterKey);
    const targets: { archiveId: string; fileIndex: number }[] = [];
    if (archive.isBundle && archive.files && archive.files.length > 1) {
      for (let i = 0; i < archive.files.length; i += 1) {
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
