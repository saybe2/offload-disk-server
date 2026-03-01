import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Writable } from "stream";
import type { Response } from "express";
import mime from "mime-types";
import unzipper from "unzipper";
import { ArchiveDoc } from "../models/Archive.js";
import { Archive } from "../models/Archive.js";
import { downloadToFile } from "./discord.js";
import { deriveKey } from "./crypto.js";
import { zipEntryName } from "./archive.js";
import { startRestore, endRestore } from "./activity.js";
import { uniqueParts } from "./parts.js";
import { log } from "../logger.js";
import { refreshPartUrl } from "./partProvider.js";

function contentDisposition(filename: string) {
  const fallback = filename
    .split("")
    .map((ch) => (/[a-zA-Z0-9._ -]/.test(ch) ? ch : "_"))
    .join("");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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

async function waitDrainOrError(target: Writable) {
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      target.off("drain", onDrain);
      target.off("error", onError);
    };
    target.once("drain", onDrain);
    target.once("error", onError);
  });
}

async function extractZipEntryToFile(
  zipPath: string,
  entryName: string,
  targetFileIndex: number,
  outputPath: string
) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  const fileEntries = (directory.files || []).filter((entry: any) => {
    const entryType = String(entry?.type || "");
    return !(entryType.toLowerCase() === "directory" || String(entry?.path || "").endsWith("/"));
  });
  const byName = fileEntries.find((entry: any) => entry.path === entryName);
  const byIndex = targetFileIndex >= 0 && targetFileIndex < fileEntries.length
    ? fileEntries[targetFileIndex]
    : null;
  const target = byName || byIndex;
  if (!target) {
    throw new Error("file_not_found");
  }
  const input = await target.stream();
  const output = fs.createWriteStream(outputPath);
  await new Promise<void>((resolve, reject) => {
    input.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    input.pipe(output);
  });
}

async function downloadPartWithRepair(
  archiveId: string,
  part: { index: number; url: string; messageId: string; webhookId: string },
  partPath: string,
  _webhookCache: Map<string, string>
) {
  try {
    await downloadToFile(part.url, partPath);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/download_failed:(401|403|404)/.test(message)) {
      throw err;
    }
    await refreshPartUrl(archiveId, part);
    await downloadToFile(part.url, partPath);
  }
}

function resolveSingleFileSize(archive: ArchiveDoc | any) {
  if (archive.isBundle) {
    return 0;
  }
  const fileSize = archive.files?.[0]?.size || 0;
  if (fileSize > 0) {
    return fileSize;
  }
  if ((archive.originalSize || 0) > 0) {
    return archive.originalSize;
  }
  const parts = uniqueParts(archive.parts || []);
  return parts.reduce((sum, part) => sum + (part.plainSize || part.size || 0), 0);
}

function makeRestoreWorkDir(tempBaseDir: string, key: string) {
  return path.join(
    tempBaseDir,
    "restore",
    `${key}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
}

function buildStableResourceTag(archive: ArchiveDoc | any, size: number) {
  const hash = crypto.createHash("sha1");
  // Keep validator stable across internal re-encryption (v1 -> v2) for the same logical file.
  hash.update(String(archive.id || archive._id || "archive"));
  hash.update(`|size=${size}|bundle=${archive.isBundle ? 1 : 0}`);
  hash.update(`|created=${archive.createdAt ? new Date(archive.createdAt).getTime() : 0}`);
  return hash.digest("hex");
}

function setResumeIdentityHeaders(archive: ArchiveDoc | any, res: Response, size: number) {
  const mtime = archive.createdAt instanceof Date ? archive.createdAt : new Date(archive.createdAt || Date.now());
  if (!Number.isNaN(mtime.getTime())) {
    res.setHeader("Last-Modified", mtime.toUTCString());
  }
  if (size > 0) {
    res.setHeader("ETag", `"${buildStableResourceTag(archive, size)}"`);
  }
}

function parseByteRange(rangeHeader: string, size: number) {
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }

  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) {
    return null;
  }

  let start = 0;
  let end = size - 1;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
  } else {
    start = Number(rawStart);
    if (!Number.isFinite(start) || start < 0) {
      return null;
    }
    if (rawEnd) {
      end = Number(rawEnd);
      if (!Number.isFinite(end) || end < 0) {
        return null;
      }
    }
  }

  if (start >= size) {
    return null;
  }
  if (end >= size) {
    end = size - 1;
  }
  if (start > end) {
    return null;
  }

  return { start, end };
}

async function decryptPartToBuffer(
  partPath: string,
  part: { iv?: string; authTag?: string; index: number },
  key: Buffer
) {
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

export async function streamArchiveRangeToResponse(
  archive: ArchiveDoc,
  rangeHeader: string,
  res: Response,
  tempBaseDir: string,
  masterKey: string
) {
  if (archive.isBundle) {
    throw new Error("range_not_supported");
  }

  const parts = uniqueParts(archive.parts);
  const partRanges = parts.map((part) => ({
    part,
    plainSize: part.plainSize || part.size
  }));
  const inferredTotalSize = partRanges.reduce((sum, item) => sum + item.plainSize, 0);
  const fileSize = resolveSingleFileSize(archive) || inferredTotalSize;
  const range = parseByteRange(rangeHeader, fileSize);
  const downloadName = archive.downloadName || archive.name;
  const contentType = (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", contentDisposition(downloadName));
  res.setHeader("Accept-Ranges", "bytes");
  setResumeIdentityHeaders(archive, res, fileSize);

  if (!range) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

  startRestore();
  const workDir = makeRestoreWorkDir(tempBaseDir, `${archive.id}_range`);
  await fs.promises.mkdir(workDir, { recursive: true });

  let aborted = false;
  res.on("close", () => {
    aborted = true;
  });

  const key = deriveKey(masterKey);
  const responseSize = range.end - range.start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${fileSize}`);
  res.setHeader("Content-Length", responseSize);

  let cursor = 0;
  try {
    const webhookCache = new Map<string, string>();
    for (const { part, plainSize } of partRanges) {
      if (aborted) break;
      const partStart = cursor;
      const partEnd = cursor + plainSize - 1;
      cursor += plainSize;

      if (partEnd < range.start || partStart > range.end) {
        continue;
      }

      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadPartWithRepair(archive.id, part, partPath, webhookCache);
      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }
      const plain = await decryptPartToBuffer(partPath, part as any, key);
      await fs.promises.unlink(partPath).catch(() => undefined);

      const from = Math.max(range.start, partStart) - partStart;
      const to = Math.min(range.end, partEnd) - partStart + 1;
      const slice = plain.subarray(from, to);
      if (!res.write(slice)) {
        await waitDrainOrError(res as unknown as Writable);
      }
    }
    if (!aborted) {
      res.end();
    }
  } catch (err) {
    log("restore", `range stream failed ${archive.id} ${(err as Error).message}`);
    res.destroy();
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    endRestore();
  }
}

export async function restoreArchiveToFile(
  archive: ArchiveDoc,
  outputPath: string,
  tempBaseDir: string,
  masterKey: string
) {
  startRestore();
  try {
    await restoreArchiveToFileInternal(archive, outputPath, tempBaseDir, masterKey);
  } finally {
    endRestore();
  }
}

async function restoreArchiveToFileInternal(
  archive: ArchiveDoc,
  outputPath: string,
  tempBaseDir: string,
  masterKey: string
) {
  const workDir = makeRestoreWorkDir(tempBaseDir, `${archive.id}_file_v2`);
  await fs.promises.mkdir(workDir, { recursive: true });
  const key = deriveKey(masterKey);
  const output = fs.createWriteStream(outputPath);
  try {
    const webhookCache = new Map<string, string>();
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadPartWithRepair(archive.id, part, partPath, webhookCache);

      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }

      const plain = await decryptPartToBuffer(partPath, part as any, key);
      await fs.promises.unlink(partPath).catch(() => undefined);
      if (!output.write(plain)) {
        await waitDrainOrError(output);
      }
    }

    await new Promise<void>((resolve, reject) => {
      output.on("finish", resolve);
      output.on("error", reject);
      output.end();
    });
  } catch (err) {
    log("restore", `file restore failed ${archive.id} ${(err as Error).message}`);
    throw err;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

export async function restoreArchiveFileToFile(
  archive: ArchiveDoc,
  fileIndex: number,
  outputPath: string,
  tempBaseDir: string,
  masterKey: string
) {
  startRestore();
  const file = archive.files?.[fileIndex];
  if (!file) {
    endRestore();
    throw new Error("file_not_found");
  }

  const workDir = makeRestoreWorkDir(tempBaseDir, `${archive.id}_file_${fileIndex}`);
  await fs.promises.mkdir(workDir, { recursive: true });
  const zipPath = path.join(workDir, "bundle.zip");
  try {
    await restoreArchiveToFileInternal(archive, zipPath, tempBaseDir, masterKey);
    await extractZipEntryToFile(zipPath, zipEntryName(file), fileIndex, outputPath);
  } catch (err) {
    log("restore", `bundle extract failed ${archive.id} ${(err as Error).message}`);
    throw err;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    endRestore();
  }
}

export async function streamArchiveFileToResponse(
  archive: ArchiveDoc,
  fileIndex: number,
  res: Response,
  tempBaseDir: string,
  masterKey: string
) {
  startRestore();
  const file = archive.files?.[fileIndex];
  if (!file) {
    endRestore();
    throw new Error("file_not_found");
  }
  const workDir = makeRestoreWorkDir(tempBaseDir, `${archive.id}_bundle_${fileIndex}`);
  await fs.promises.mkdir(workDir, { recursive: true });
  const zipPath = path.join(workDir, "bundle.zip");
  const restoredPath = path.join(workDir, "file");
  const downloadName = (file.originalName || file.name || "file").replace(/[\\/]/g, "_");
  const contentType = (mime.lookup(downloadName) as string) || "application/octet-stream";

  let aborted = false;
  res.on("close", () => {
    aborted = true;
  });

  try {
    await restoreArchiveToFileInternal(archive, zipPath, tempBaseDir, masterKey);
    if (aborted) {
      return;
    }
    await extractZipEntryToFile(zipPath, zipEntryName(file), fileIndex, restoredPath);
    const stat = await fs.promises.stat(restoredPath);

    if (!res.headersSent) {
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", contentDisposition(downloadName));
      res.setHeader("Content-Length", stat.size);
    }

    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(restoredPath);
      rs.on("error", reject);
      res.on("error", reject);
      rs.on("end", resolve);
      rs.pipe(res);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "file_not_found" && !res.headersSent) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }
    log("restore", `bundle stream failed ${archive.id} ${(err as Error).message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "restore_failed" });
      return;
    }
    res.destroy();
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    endRestore();
  }
}

export async function streamArchiveToResponse(
  archive: ArchiveDoc,
  res: Response,
  tempBaseDir: string,
  masterKey: string
) {
  startRestore();
  const workDir = makeRestoreWorkDir(tempBaseDir, `${archive.id}_v2`);
  await fs.promises.mkdir(workDir, { recursive: true });
  const key = deriveKey(masterKey);
  const downloadName = archive.downloadName || (archive.isBundle ? `${archive.name}.zip` : archive.name);
  const contentType = archive.isBundle
    ? "application/zip"
    : (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", contentDisposition(downloadName));
  res.setHeader("Accept-Ranges", "bytes");
  if (!archive.isBundle) {
    const size = resolveSingleFileSize(archive);
    if (size > 0) {
      res.setHeader("Content-Length", size);
      setResumeIdentityHeaders(archive, res, size);
    }
  }

  let aborted = false;
  res.on("close", () => {
    aborted = true;
  });

  try {
    const webhookCache = new Map<string, string>();
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      if (aborted) break;
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadPartWithRepair(archive.id, part, partPath, webhookCache);

      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }

      const plain = await decryptPartToBuffer(partPath, part as any, key);
      await fs.promises.unlink(partPath).catch(() => undefined);
      if (!res.write(plain)) {
        await waitDrainOrError(res as unknown as Writable);
      }
    }

    if (!aborted) {
      res.end();
    }
  } catch (err) {
    log("restore", `stream failed ${archive.id} ${(err as Error).message}`);
    res.destroy();
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    endRestore();
  }
}
