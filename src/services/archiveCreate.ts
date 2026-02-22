import fs from "fs";
import path from "path";
import { Archive } from "../models/Archive.js";
import { User } from "../models/User.js";
import { Folder } from "../models/Folder.js";
import { config, computed } from "../config.js";
import { queueArchiveThumbnails } from "./thumbnailWorker.js";

function sanitizeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function createArchiveFromLocalFile(params: {
  userId: string;
  originalName: string;
  sourcePath: string;
  folderId?: string | null;
}) {
  const { userId, originalName, sourcePath } = params;
  const safeName = originalName.replace(/[\\/]/g, "_");
  const downloadName = safeName;
  const archiveName = sanitizeName(downloadName);

  const stagingDir = path.join(
    config.cacheDir,
    "uploads",
    new Date().toISOString().slice(0, 10),
    `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.promises.mkdir(stagingDir, { recursive: true });

  const dest = path.join(stagingDir, `0_${sanitizeName(originalName)}`);
  await fs.promises.rename(sourcePath, dest);
  const stat = await fs.promises.stat(dest);

  let folderRef: any = null;
  let basePriority = 2;
  if (params.folderId) {
    const folder = await Folder.findById(params.folderId);
    if (folder) {
      folderRef = folder._id;
      basePriority = folder.priority ?? 2;
    }
  }

  const archive = await Archive.create({
    userId,
    name: archiveName,
    displayName: safeName,
    downloadName,
    isBundle: false,
    encryptionVersion: 2,
    folderId: folderRef,
    priority: basePriority,
    priorityOverride: false,
    status: "queued",
    originalSize: stat.size,
    encryptedSize: 0,
    uploadedBytes: 0,
    uploadedParts: 0,
    totalParts: 0,
    chunkSizeBytes: computed.chunkSizeBytes,
    stagingDir,
    files: [{ path: dest, name: path.basename(dest), originalName: safeName, size: stat.size }],
    parts: []
  });

  await User.updateOne({ _id: userId }, { $inc: { usedBytes: stat.size } });
  queueArchiveThumbnails(archive.id);

  return archive;
}
