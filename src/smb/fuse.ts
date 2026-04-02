import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { config } from "../config.js";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { User } from "../models/User.js";
import { restoreArchiveFileToFile, restoreArchiveToFile } from "../services/restore.js";
import { createArchiveFromLocalFile } from "../services/archiveCreate.js";
import { deriveKey } from "../services/crypto.js";
import { uniqueParts } from "../services/parts.js";
import { downloadToFile } from "../services/discord.js";
import { refreshMirrorPartUrl, refreshPartUrl } from "../services/partProvider.js";
import { log } from "../logger.js";
import { sanitizeFilename } from "../utils/names.js";
import {
  noteSmbError,
  noteSmbRead,
  noteSmbReadOpen,
  noteSmbWrite,
  noteSmbWriteOpen
} from "../services/analytics.js";

const READ_DIR = "smb_read";
const WRITE_DIR = "smb_write";

type FileItem = {
  archive: any;
  fileIndex: number;
  baseName: string;
  visibleName: string;
  size: number;
};

type DirListing = {
  folders: any[];
  files: FileItem[];
  fileMap: Map<string, FileItem>;
};

const dirCache = new Map<string, { ts: number; data: DirListing }>();
const userCache = new Map<string, { ts: number; data: any | null }>();
const readCache = new Map<string, { path: string; refs: number; ready: boolean; promise?: Promise<void> }>();
type ProgressivePartInfo = {
  index: number;
  start: number;
  end: number;
  plainSize: number;
  part: any;
};

type ProgressiveReadCacheEntry = {
  archiveId: string;
  cryptoKey: Buffer;
  path: string;
  refs: number;
  size: number;
  partInfos: ProgressivePartInfo[];
  readyParts: Set<number>;
  loadingParts: Map<number, Promise<void>>;
};

const progressiveReadCache = new Map<string, ProgressiveReadCacheEntry>();
const handleMap = new Map<
  number,
  | {
      type: "read" | "write";
      path: string;
      key?: string;
      username: string;
      folderId: string | null;
      overwriteId?: string;
    }
  | {
      type: "progressive_read";
      path: string;
      key: string;
      username: string;
      folderId: string | null;
    }
>();

export function getSmbRuntimeState() {
  return {
    dirCacheEntries: dirCache.size,
    userCacheEntries: userCache.size,
    readCacheEntries: readCache.size,
    progressiveReadEntries: progressiveReadCache.size,
    activeHandles: handleMap.size
  };
}

function nowTs() {
  return Date.now();
}

function cacheKey(userId: string, folderId: string | null) {
  return `${userId}:${folderId || "root"}`;
}

function sanitizeName(name: string) {
  return sanitizeFilename(name);
}

async function getUserByName(username: string) {
  const cached = userCache.get(username);
  const ttl = 10000;
  if (cached && nowTs() - cached.ts < ttl) {
    return cached.data;
  }
  const user = await User.findOne({ username }).lean();
  userCache.set(username, { ts: nowTs(), data: user || null });
  return user || null;
}

async function findFolderByPath(userId: string, segments: string[]) {
  let parentId: any = null;
  if (segments.length === 0) return null;
  let folder: any = null;
  for (const segment of segments) {
    folder = await Folder.findOne({ userId, parentId, name: segment }).lean();
    if (!folder) return null;
    parentId = folder._id;
  }
  return folder;
}

function buildFileItems(archives: any[]) {
  const items: FileItem[] = [];
  for (const archive of archives) {
    const files = archive.files || [];
    if (archive.isBundle && files.length > 1) {
      files.forEach((file: any, index: number) => {
        const baseName = sanitizeName(file.originalName || file.name || archive.displayName || archive.name);
        items.push({
          archive,
          fileIndex: index,
          baseName,
          visibleName: "",
          size: file.size || archive.originalSize || 0
        });
      });
    } else if (files[0]) {
      const file = files[0];
      const baseName = sanitizeName(file.originalName || file.name || archive.displayName || archive.name);
      items.push({
        archive,
        fileIndex: 0,
        baseName,
        visibleName: "",
        size: file.size || archive.originalSize || 0
      });
    }
  }
  return items;
}

function assignVisibleNames(items: FileItem[]) {
  const used = new Set<string>();
  const sorted = items.slice().sort((a, b) => {
    const nameCmp = a.baseName.localeCompare(b.baseName);
    if (nameCmp !== 0) return nameCmp;
    const idCmp = String(a.archive._id).localeCompare(String(b.archive._id));
    if (idCmp !== 0) return idCmp;
    return a.fileIndex - b.fileIndex;
  });

  for (const item of sorted) {
    const prefix = item.archive.status === "ready" ? "" : "r";
    let candidate = `${prefix}${item.baseName}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      item.visibleName = candidate;
      continue;
    }
    const ext = path.extname(candidate);
    const base = ext ? candidate.slice(0, -ext.length) : candidate;
    let n = 1;
    while (true) {
      const next = `${base}_${n}${ext}`;
      if (!used.has(next)) {
        used.add(next);
        item.visibleName = next;
        break;
      }
      n += 1;
    }
  }
  return sorted;
}

async function listDirectory(userId: string, folderId: string | null) {
  const key = cacheKey(userId, folderId);
  const cached = dirCache.get(key);
  if (cached && nowTs() - cached.ts < 2000) {
    return cached.data;
  }

  const [folders, archives] = await Promise.all([
    Folder.find({ userId, parentId: folderId }).sort({ name: 1 }).lean(),
    Archive.find({ userId, folderId, trashedAt: null, deletedAt: null }).lean()
  ]);
  const files = assignVisibleNames(buildFileItems(archives));
  const fileMap = new Map<string, FileItem>();
  for (const file of files) {
    fileMap.set(file.visibleName, file);
  }
  const data = { folders, files, fileMap };
  dirCache.set(key, { ts: nowTs(), data });
  return data;
}

function invalidateDir(userId: string, folderId: string | null) {
  dirCache.delete(cacheKey(userId, folderId));
}

function makeDirStat() {
  const now = new Date();
  return {
    mtime: now,
    atime: now,
    ctime: now,
    size: 4096,
    mode: 0o40755,
    uid: 0,
    gid: 0
  };
}

function makeFileStat(size: number, mtime?: Date) {
  const time = mtime || new Date();
  return {
    mtime: time,
    atime: time,
    ctime: time,
    size,
    mode: 0o100644,
    uid: 0,
    gid: 0
  };
}

async function resolvePath(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length === 0) return { type: "root" as const };

  const username = parts[0];
  const user = await getUserByName(username);
  if (!user) return { type: "missing" as const };

  const rest = parts.slice(1);
  if (rest.length === 0) {
    return { type: "user" as const, username, user };
  }

  const folder = await findFolderByPath(user._id.toString(), rest);
  if (folder) {
    return { type: "folder" as const, username, user, folder };
  }

  const parentSegments = rest.slice(0, -1);
  const fileName = rest[rest.length - 1];
  const parentFolder = parentSegments.length > 0
    ? await findFolderByPath(user._id.toString(), parentSegments)
    : null;
  if (parentSegments.length > 0 && !parentFolder) {
    return { type: "missing" as const };
  }
  const folderId = parentFolder ? parentFolder._id.toString() : null;
  const listing = await listDirectory(user._id.toString(), folderId);
  const file = listing.fileMap.get(fileName);
  if (!file) return { type: "missing" as const };
  return { type: "file" as const, username, user, folder: parentFolder, file };
}

async function hashFile(filePath: string) {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("data", (data) => hash.update(data));
    rs.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function decryptPartToBuffer(partPath: string, part: { iv?: string; authTag?: string; index: number }, key: Buffer) {
  const ivB64 = part.iv || "";
  const authTagB64 = part.authTag || "";
  if (!ivB64 || !authTagB64) {
    throw new Error(`part_crypto_missing:${part.index}`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const encrypted = await fs.promises.readFile(partPath);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function downloadPartWithRepair(
  archiveId: string,
  part: {
    index: number;
    url: string;
    mirrorUrl?: string;
    mirrorMessageId?: string;
    mirrorWebhookId?: string;
    mirrorProvider?: "discord" | "telegram";
    mirrorTelegramFileId?: string;
  },
  partPath: string
) {
  try {
    await downloadToFile(part.url, partPath);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/download_failed:(401|403|404)/.test(message)) {
      throw err;
    }
  }

  try {
    await refreshPartUrl(archiveId, part);
    await downloadToFile(part.url, partPath);
    return;
  } catch {
    // try mirror below
  }

  if (!part.mirrorUrl) {
    throw new Error("part_download_failed_no_mirror");
  }
  try {
    await downloadToFile(part.mirrorUrl, partPath);
    return;
  } catch {
    await refreshMirrorPartUrl(archiveId, part);
    await downloadToFile(String(part.mirrorUrl || ""), partPath);
  }
}

function buildProgressivePartInfos(archive: any, totalSize: number) {
  const parts = uniqueParts(archive.parts || []).slice().sort((a, b) => Number(a.index) - Number(b.index));
  const infos: ProgressivePartInfo[] = [];
  let cursor = 0;
  for (const part of parts) {
    const plainSize = Math.max(0, Number(part.plainSize || part.size || 0));
    if (plainSize <= 0) continue;
    infos.push({
      index: Number(part.index),
      start: cursor,
      end: cursor + plainSize - 1,
      plainSize,
      part
    });
    cursor += plainSize;
  }
  if (infos.length > 0 && totalSize > 0) {
    const last = infos[infos.length - 1];
    const expectedEnd = totalSize - 1;
    if (expectedEnd > last.end) {
      last.plainSize += expectedEnd - last.end;
      last.end = expectedEnd;
    } else if (expectedEnd < last.end) {
      last.plainSize = Math.max(0, last.plainSize - (last.end - expectedEnd));
      last.end = expectedEnd;
    }
  }
  return infos;
}

function findOverlappingProgressiveParts(entry: ProgressiveReadCacheEntry, start: number, end: number) {
  const indexes: number[] = [];
  for (const info of entry.partInfos) {
    if (info.end < start) continue;
    if (info.start > end) break;
    indexes.push(info.index);
  }
  return indexes;
}

async function ensureProgressivePartReady(key: string, partIndex: number) {
  const entry = progressiveReadCache.get(key);
  if (!entry) throw new Error("progressive_entry_missing");
  if (entry.readyParts.has(partIndex)) return;
  const inFlight = entry.loadingParts.get(partIndex);
  if (inFlight) {
    await inFlight;
    return;
  }
  const info = entry.partInfos.find((partInfo) => partInfo.index === partIndex);
  if (!info) throw new Error(`progressive_part_missing:${partIndex}`);
  const job = (async () => {
    const partPath = `${entry.path}.part_${partIndex}`;
    await downloadPartWithRepair(entry.archiveId, info.part, partPath);
    const actualHash = await hashFile(partPath);
    if (actualHash !== info.part.hash) {
      throw new Error(`part_hash_mismatch:${partIndex}`);
    }
    const plain = await decryptPartToBuffer(partPath, info.part as any, entry.cryptoKey);
    await fs.promises.unlink(partPath).catch(() => undefined);
    const writeLen = Math.min(plain.length, Math.max(0, info.plainSize));
    if (writeLen <= 0) {
      entry.readyParts.add(partIndex);
      return;
    }
    const fd = await fs.promises.open(entry.path, "r+");
    try {
      await fd.write(plain, 0, writeLen, info.start);
    } finally {
      await fd.close();
    }
    entry.readyParts.add(partIndex);
  })();
  entry.loadingParts.set(partIndex, job);
  try {
    await job;
  } finally {
    entry.loadingParts.delete(partIndex);
  }
}

async function ensureProgressiveRangeReady(key: string, position: number, length: number) {
  const entry = progressiveReadCache.get(key);
  if (!entry) throw new Error("progressive_entry_missing");
  if (length <= 0 || position >= entry.size) return;
  const start = Math.max(0, position);
  const end = Math.min(entry.size - 1, position + length - 1);
  const indexes = findOverlappingProgressiveParts(entry, start, end);
  for (const index of indexes) {
    await ensureProgressivePartReady(key, index);
  }
}

async function ensureProgressiveReadablePath(file: FileItem) {
  const archive = file.archive;
  const fileIndex = file.fileIndex;
  const key = `${archive._id}:${fileIndex}`;
  const existing = progressiveReadCache.get(key);
  if (existing) {
    return { path: existing.path, key, size: existing.size };
  }
  const size = Math.max(0, Number(file.size || 0));
  const partInfos = buildProgressivePartInfos(archive, size);
  if (partInfos.length === 0) {
    throw new Error("parts_missing");
  }
  const cacheDir = path.join(config.cacheDir, READ_DIR);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const outputPath = path.join(cacheDir, `${archive._id}_${fileIndex}_progressive`);
  const fd = await fs.promises.open(outputPath, "w+");
  try {
    if (size > 0) {
      await fd.truncate(size);
    }
  } finally {
    await fd.close();
  }
  progressiveReadCache.set(key, {
    archiveId: String(archive._id),
    cryptoKey: deriveKey(config.masterKey),
    path: outputPath,
    refs: 0,
    size,
    partInfos,
    readyParts: new Set<number>(),
    loadingParts: new Map<number, Promise<void>>()
  });
  return { path: outputPath, key, size };
}

async function ensureReadablePath(file: FileItem) {
  const archive = file.archive;
  const fileIndex = file.fileIndex;
  const key = `${archive._id}:${fileIndex}`;
  const entry = readCache.get(key);

  if (archive.status !== "ready") {
    const rawPath = archive.files?.[fileIndex]?.path;
    if (rawPath && fs.existsSync(rawPath)) {
      return { path: rawPath, cleanup: false };
    }
    throw new Error("not_ready");
  }

  const cacheDir = path.join(config.cacheDir, READ_DIR);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const outputPath = path.join(cacheDir, `${archive._id}_${fileIndex}`);

  if (!entry) {
    const newEntry = { path: outputPath, refs: 0, ready: false, promise: Promise.resolve() };
    newEntry.promise = (async () => {
      if (archive.isBundle && archive.files?.length > 1) {
        await restoreArchiveFileToFile(archive, fileIndex, outputPath, config.cacheDir, config.masterKey);
      } else {
        await restoreArchiveToFile(archive, outputPath, config.cacheDir, config.masterKey);
      }
      newEntry.ready = true;
    })();
    readCache.set(key, newEntry);
    await newEntry.promise;
    return { path: outputPath, cleanup: true, key };
  }

  if (!entry.ready && entry.promise) {
    await entry.promise;
  }
  return { path: entry.path, cleanup: true, key };
}

function releaseReadable(key?: string) {
  if (!key) return;
  const entry = readCache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    readCache.delete(key);
    fs.promises.unlink(entry.path).catch(() => undefined);
  }
}

function releaseProgressiveReadable(key?: string) {
  if (!key) return;
  const entry = progressiveReadCache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    progressiveReadCache.delete(key);
    fs.promises.unlink(entry.path).catch(() => undefined);
  }
}

async function handleStatfs(username: string) {
  const user = await getUserByName(username);
  const totalBytes = user && user.quotaBytes > 0 ? user.quotaBytes : config.smbUnlimitedBytes;
  const usedBytes = user ? user.usedBytes || 0 : 0;
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  let blockSize = 4096;
  const maxBlocks = 0x7fffffff;
  while (Math.floor(totalBytes / blockSize) > maxBlocks) {
    blockSize *= 2;
  }
  return {
    bsize: blockSize,
    frsize: blockSize,
    blocks: Math.floor(totalBytes / blockSize),
    bfree: Math.floor(freeBytes / blockSize),
    bavail: Math.floor(freeBytes / blockSize),
    files: 1_000_000,
    ffree: 1_000_000,
    favail: 1_000_000,
    namemax: 255
  };
}

export function startFuse() {
  if (!config.smbEnabled) return;

  const require = createRequire(import.meta.url);
  let Fuse: any;
  try {
    Fuse = require("fuse-native");
  } catch (err) {
    log("smb", `fuse-native unavailable: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const ERR = {
    ENOENT: (Fuse as any).ENOENT ?? -2,
    EIO: (Fuse as any).EIO ?? -5,
    EPERM: (Fuse as any).EPERM ?? -1,
    EACCES: (Fuse as any).EACCES ?? -13,
    EEXIST: (Fuse as any).EEXIST ?? -17,
    ENOTEMPTY: (Fuse as any).ENOTEMPTY ?? -39,
    EXDEV: (Fuse as any).EXDEV ?? -18,
    EAGAIN: (Fuse as any).EAGAIN ?? -11,
    ENOSPC: (Fuse as any).ENOSPC ?? -28
  };

  const mountPath = config.smbMount;
  const readyFile = "/home/container/data/fuse_ready";
  const failedFile = "/home/container/data/fuse_failed";
  const ops: any = {
    readdir: async (filePath: string, cb: (err: number | null, files?: string[]) => void) => {
      try {
        const resolved = await resolvePath(filePath);
        if (resolved.type === "root") {
          const users = await User.find().select("username").lean();
          return cb(0, [".", "..", ...users.map((u) => u.username)]);
        }
        if (resolved.type === "user") {
          const listing = await listDirectory(resolved.user._id.toString(), null);
          return cb(0, [".", "..", ...listing.folders.map((f) => f.name), ...listing.files.map((f) => f.visibleName)]);
        }
        if (resolved.type === "folder") {
          const listing = await listDirectory(resolved.user._id.toString(), resolved.folder._id.toString());
          return cb(0, [".", "..", ...listing.folders.map((f) => f.name), ...listing.files.map((f) => f.visibleName)]);
        }
        return cb(ERR.ENOENT);
      } catch (err) {
        log("smb", `readdir failed: ${err instanceof Error ? err.message : err}`);
        return cb(ERR.EIO);
      }
    },
    getattr: async (filePath: string, cb: (err: number | null, stat?: any) => void) => {
      try {
        const resolved = await resolvePath(filePath);
        if (resolved.type === "root") return cb(0, makeDirStat());
        if (resolved.type === "user") return cb(0, makeDirStat());
        if (resolved.type === "folder") return cb(0, makeDirStat());
        if (resolved.type === "file") {
          const archive = resolved.file.archive;
          const mtime = archive.updatedAt || archive.createdAt || new Date();
          return cb(0, makeFileStat(resolved.file.size, new Date(mtime)));
        }
        return cb(ERR.ENOENT);
      } catch (err) {
        log("smb", `getattr failed: ${err instanceof Error ? err.message : err}`);
        return cb(ERR.EIO);
      }
    },
    statfs: async (filePath: string, cb: (err: number | null, stat?: any) => void) => {
      try {
        const parts = filePath.split("/").filter(Boolean);
        const username = parts[0];
        if (!username) return cb(0, await handleStatfs(""));
        return cb(0, await handleStatfs(username));
      } catch (err) {
        return cb(ERR.EIO);
      }
    },
    open: async (filePath: string, flags: number, cb: (err: number | null, fd?: number) => void) => {
      try {
        const isWrite = (flags & fs.constants.O_WRONLY) || (flags & fs.constants.O_RDWR);
        if (isWrite) {
          const parts = filePath.split("/").filter(Boolean);
          if (parts.length < 2) return cb(ERR.EPERM);
          const username = parts[0];
          const user = await getUserByName(username);
          if (!user) return cb(ERR.EACCES);
          const folderSegments = parts.slice(1, -1);
          const folder = folderSegments.length > 0 ? await findFolderByPath(user._id.toString(), folderSegments) : null;
          if (folderSegments.length > 0 && !folder) return cb(ERR.ENOENT);

          const dir = path.join(config.cacheDir, WRITE_DIR, username);
          await fs.promises.mkdir(dir, { recursive: true });
          const tempPath = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
          const fd = fs.openSync(tempPath, "w+");

          let overwriteId: string | undefined;
          const resolved = await resolvePath(filePath);
          if (resolved.type === "file") {
            overwriteId = resolved.file.archive._id.toString();
          }
          handleMap.set(fd, { type: "write", path: tempPath, username, folderId: folder ? folder._id.toString() : null, overwriteId });
          noteSmbWriteOpen();
          return cb(0, fd);
        }
        const resolved = await resolvePath(filePath);
        if (resolved.type !== "file") return cb(ERR.ENOENT);
        const canProgressive =
          resolved.file.archive.status === "ready" &&
          !resolved.file.archive.isBundle &&
          Number(resolved.file.size || 0) > 0 &&
          Number(resolved.file.archive.encryptionVersion || 2) >= 2;
        if (canProgressive) {
          const info = await ensureProgressiveReadablePath(resolved.file);
          const fd = fs.openSync(info.path, "r");
          const entry = progressiveReadCache.get(info.key);
          if (entry) entry.refs += 1;
          handleMap.set(fd, {
            type: "progressive_read",
            path: info.path,
            key: info.key,
            username: resolved.username,
            folderId: resolved.folder ? resolved.folder._id.toString() : null
          });
          noteSmbReadOpen();
          return cb(0, fd);
        }
        const info = await ensureReadablePath(resolved.file);
        const fd = fs.openSync(info.path, "r");
        if (info.key) {
          const entry = readCache.get(info.key);
          if (entry) entry.refs += 1;
        }
        handleMap.set(fd, { type: "read", path: info.path, key: info.key, username: resolved.username, folderId: resolved.folder ? resolved.folder._id.toString() : null });
        noteSmbReadOpen();
        return cb(0, fd);
      } catch (err: any) {
        noteSmbError();
        if (err?.message === "not_ready") return cb(ERR.EAGAIN);
        return cb(ERR.EIO);
      }
    },
    create: async (filePath: string, mode: number, cb: (err: number | null, fd?: number) => void) => {
      try {
        const parts = filePath.split("/").filter(Boolean);
        if (parts.length < 2) return cb(ERR.EPERM);
        const username = parts[0];
        const user = await getUserByName(username);
        if (!user) return cb(ERR.EACCES);
        const fileName = parts[parts.length - 1];
        const folderSegments = parts.slice(1, -1);
        const folder = folderSegments.length > 0 ? await findFolderByPath(user._id.toString(), folderSegments) : null;
        if (folderSegments.length > 0 && !folder) return cb(ERR.ENOENT);

        const dir = path.join(config.cacheDir, WRITE_DIR, username);
        await fs.promises.mkdir(dir, { recursive: true });
        const tempPath = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        const fd = fs.openSync(tempPath, "w+");
        handleMap.set(fd, { type: "write", path: tempPath, username, folderId: folder ? folder._id.toString() : null });
        noteSmbWriteOpen();
        return cb(0, fd);
      } catch (err) {
        noteSmbError();
        return cb(ERR.EIO);
      }
    },
    read: (filePath: string, fd: number, buffer: Buffer, length: number, position: number, cb: (bytes: number) => void) => {
      const handle = handleMap.get(fd);
      if (handle?.type === "progressive_read") {
        ensureProgressiveRangeReady(handle.key, position, length)
          .then(() => {
            fs.read(fd, buffer, 0, length, position, (err, bytesRead) => {
              if (err) {
                noteSmbError();
                return cb(0);
              }
              if (bytesRead > 0) {
                noteSmbRead(bytesRead);
              }
              return cb(bytesRead);
            });
          })
          .catch((err) => {
            log("smb", `progressive read failed: ${err instanceof Error ? err.message : err}`);
            noteSmbError();
            cb(0);
          });
        return;
      }
      fs.read(fd, buffer, 0, length, position, (err, bytesRead) => {
        if (err) {
          noteSmbError();
          return cb(0);
        }
        if (bytesRead > 0) {
          noteSmbRead(bytesRead);
        }
        return cb(bytesRead);
      });
    },
    write: (filePath: string, fd: number, buffer: Buffer, length: number, position: number, cb: (bytes: number) => void) => {
      fs.write(fd, buffer, 0, length, position, (err, bytesWritten) => {
        if (err) {
          noteSmbError();
          return cb(0);
        }
        if (bytesWritten > 0) {
          noteSmbWrite(bytesWritten);
        }
        return cb(bytesWritten);
      });
    },
    release: async (filePath: string, fd: number, cb: (err?: number | null) => void) => {
      const handle = handleMap.get(fd);
      handleMap.delete(fd);
      fs.close(fd, async () => {
        if (!handle) return cb(0);
        if (handle.type === "read") {
          releaseReadable(handle.key);
          return cb(0);
        }
        if (handle.type === "progressive_read") {
          releaseProgressiveReadable(handle.key);
          return cb(0);
        }
        try {
          const stat = await fs.promises.stat(handle.path);
          if (stat.size > 0) {
            const user = await getUserByName(handle.username);
            if (!user) {
              await fs.promises.unlink(handle.path).catch(() => undefined);
              return cb(ERR.EACCES);
            }
            if (user.quotaBytes > 0 && user.usedBytes + stat.size > user.quotaBytes) {
              await fs.promises.unlink(handle.path).catch(() => undefined);
              return cb(ERR.ENOSPC);
            }
            const originalName = sanitizeName(path.basename(filePath));
            await createArchiveFromLocalFile({
              userId: user._id.toString(),
              originalName,
              sourcePath: handle.path,
              folderId: handle.folderId
            });
            if (handle.overwriteId) {
              const old = await Archive.findById(handle.overwriteId).lean();
              if (old) {
                await Archive.updateOne(
                  { _id: old._id },
                  { $set: { trashedAt: new Date(), deleteTotalParts: uniqueParts(old.parts).length, deletedParts: 0 } }
                );
              }
            }
            invalidateDir(user._id.toString(), handle.folderId);
          } else {
            await fs.promises.unlink(handle.path).catch(() => undefined);
          }
          return cb(0);
        } catch (err) {
          noteSmbError();
          return cb(ERR.EIO);
        }
      });
    },
    truncate: async (filePath: string, size: number, cb: (err?: number | null) => void) => {
      return cb(0);
    },
    unlink: async (filePath: string, cb: (err?: number | null) => void) => {
      try {
        const resolved = await resolvePath(filePath);
        if (resolved.type !== "file") return cb(ERR.ENOENT);
        const archive = resolved.file.archive;
        await Archive.updateOne(
          { _id: archive._id },
          { $set: { trashedAt: new Date(), deleteTotalParts: uniqueParts(archive.parts).length, deletedParts: 0 } }
        );
        invalidateDir(resolved.user._id.toString(), resolved.folder ? resolved.folder._id.toString() : null);
        return cb(0);
      } catch {
        return cb(ERR.EIO);
      }
    },
    mkdir: async (filePath: string, mode: number, cb: (err?: number | null) => void) => {
      try {
        const parts = filePath.split("/").filter(Boolean);
        if (parts.length < 2) return cb(ERR.EPERM);
        const username = parts[0];
        const user = await getUserByName(username);
        if (!user) return cb(ERR.EACCES);
        const name = sanitizeName(parts[parts.length - 1]);
        const parentSegments = parts.slice(1, -1);
        const parentFolder = parentSegments.length > 0 ? await findFolderByPath(user._id.toString(), parentSegments) : null;
        const parentId = parentFolder ? parentFolder._id : null;
        const existing = await Folder.findOne({ userId: user._id, parentId, name }).lean();
        if (existing) return cb(ERR.EEXIST);
        await Folder.create({ userId: user._id, name, parentId, priority: 2 });
        invalidateDir(user._id.toString(), parentId ? parentId.toString() : null);
        return cb(0);
      } catch {
        return cb(ERR.EIO);
      }
    },
    rmdir: async (filePath: string, cb: (err?: number | null) => void) => {
      try {
        const resolved = await resolvePath(filePath);
        if (resolved.type !== "folder") return cb(ERR.ENOENT);
        const folderId = resolved.folder._id.toString();
        const children = await Folder.countDocuments({ userId: resolved.user._id, parentId: folderId });
        const files = await Archive.countDocuments({ userId: resolved.user._id, folderId, trashedAt: null, deletedAt: null });
        if (children > 0 || files > 0) return cb(ERR.ENOTEMPTY);
        await Folder.deleteOne({ _id: resolved.folder._id });
        invalidateDir(resolved.user._id.toString(), resolved.folder.parentId ? resolved.folder.parentId.toString() : null);
        return cb(0);
      } catch {
        return cb(ERR.EIO);
      }
    },
    rename: async (from: string, to: string, cb: (err?: number | null) => void) => {
      try {
        const src = await resolvePath(from);
        const destParts = to.split("/").filter(Boolean);
        if (destParts.length < 2) return cb(ERR.EPERM);
        const destUsername = destParts[0];
        if (src.type === "file" && src.username !== destUsername) return cb(ERR.EXDEV);
        if (src.type === "folder" && src.username !== destUsername) return cb(ERR.EXDEV);
        const user = await getUserByName(destUsername);
        if (!user) return cb(ERR.EACCES);

        const destName = sanitizeName(destParts[destParts.length - 1]);
        const destFolderSegments = destParts.slice(1, -1);
        const destFolder = destFolderSegments.length > 0
          ? await findFolderByPath(user._id.toString(), destFolderSegments)
          : null;
        if (destFolderSegments.length > 0 && !destFolder) return cb(ERR.ENOENT);
        const destFolderId = destFolder ? destFolder._id : null;

        if (src.type === "file") {
          const archive = src.file.archive;
          const safeName = sanitizeName(destName);
          if (archive.isBundle && archive.files?.length > 1) {
            await Archive.updateOne(
              { _id: archive._id },
              { $set: { [`files.${src.file.fileIndex}.originalName`]: safeName } }
            );
          } else {
            await Archive.updateOne(
              { _id: archive._id },
              { $set: { displayName: safeName, downloadName: safeName, "files.0.originalName": safeName } }
            );
          }
          await Archive.updateOne({ _id: archive._id }, { $set: { folderId: destFolderId } });
          invalidateDir(user._id.toString(), src.folder ? src.folder._id.toString() : null);
          invalidateDir(user._id.toString(), destFolderId ? destFolderId.toString() : null);
          return cb(0);
        }

        if (src.type === "folder") {
          const existing = await Folder.findOne({ userId: user._id, parentId: destFolderId, name: destName }).lean();
          if (existing) return cb(ERR.EEXIST);
          await Folder.updateOne({ _id: src.folder._id }, { $set: { name: destName, parentId: destFolderId } });
          invalidateDir(user._id.toString(), src.folder.parentId ? src.folder.parentId.toString() : null);
          invalidateDir(user._id.toString(), destFolderId ? destFolderId.toString() : null);
          return cb(0);
        }

        return cb(ERR.ENOENT);
      } catch {
        return cb(ERR.EIO);
      }
    },
    access: async (filePath: string, mode: number, cb: (err?: number | null) => void) => {
      try {
        const resolved = await resolvePath(filePath);
        if (resolved.type === "missing") return cb(ERR.ENOENT);
        return cb(0);
      } catch {
        return cb(ERR.EIO);
      }
    },
    utimens: (_path: string, _atime: number, _mtime: number, cb: (err?: number | null) => void) => cb(0),
    chmod: (_path: string, _mode: number, cb: (err?: number | null) => void) => cb(0),
    chown: (_path: string, _uid: number, _gid: number, cb: (err?: number | null) => void) => cb(0)
  };

  const fuse = new (Fuse as any)(mountPath, ops, {
    force: true,
    debug: false,
    allowOther: true
  });
  fuse.mount((err: Error & { code?: string }) => {
    if (err) {
      const details = [err.message, err.code ? `code=${err.code}` : ""].filter(Boolean).join(" ");
      log("smb", `fuse mount failed: ${details}`);
      try {
        fs.writeFileSync(failedFile, details || err.message);
      } catch {}
      return;
    }
    log("smb", `fuse mounted at ${mountPath}`);
    try {
      fs.writeFileSync(readyFile, new Date().toISOString());
    } catch {}
  });

  const shutdown = () => {
    fuse.unmount((err: Error) => {
      if (err) {
        log("smb", `fuse unmount error: ${err.message}`);
      } else {
        log("smb", "fuse unmounted");
      }
      try {
        fs.unlinkSync(readyFile);
      } catch {}
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
