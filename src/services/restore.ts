import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PassThrough } from "stream";
import type { Response } from "express";
import mime from "mime-types";
import unzipper from "unzipper";
import { ArchiveDoc } from "../models/Archive.js";
import { downloadToFile } from "./discord.js";
import { deriveKey } from "./crypto.js";
import { zipEntryName } from "./archive.js";
import { startRestore, endRestore } from "./activity.js";
import { uniqueParts } from "./parts.js";
import { log } from "../logger.js";

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

async function pipeFileToStream(filePath: string, target: PassThrough) {
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("end", () => resolve());
    rs.pipe(target, { end: false });
  });
}

async function pipeFileToWritable(filePath: string, target: fs.WriteStream) {
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    target.on("error", reject);
    target.on("finish", () => resolve());
    rs.pipe(target);
  });
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
  const workDir = path.join(tempBaseDir, "restore", `${archive.id}_file`);
  await fs.promises.mkdir(workDir, { recursive: true });

  const encryptedStream = new PassThrough();
  const key = deriveKey(masterKey);
  const iv = Buffer.from(archive.iv, "base64");
  const authTag = Buffer.from(archive.authTag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const output = fs.createWriteStream(outputPath);
  encryptedStream.pipe(decipher).pipe(output);

  try {
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadToFile(part.url, partPath);

      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }

      await pipeFileToStream(partPath, encryptedStream);
      await fs.promises.unlink(partPath);
    }

    encryptedStream.end();
    await new Promise<void>((resolve, reject) => {
      output.on("finish", () => resolve());
      output.on("error", reject);
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

  const workDir = path.join(tempBaseDir, "restore", `${archive.id}_file_${fileIndex}`);
  await fs.promises.mkdir(workDir, { recursive: true });

  const encryptedStream = new PassThrough();
  const key = deriveKey(masterKey);
  const iv = Buffer.from(archive.iv, "base64");
  const authTag = Buffer.from(archive.authTag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const output = fs.createWriteStream(outputPath);

  let entryDone = false;
  let entryFound = false;
  let entryDoneResolve: (() => void) | null = null;
  let entryDoneReject: ((err: Error) => void) | null = null;
  const entryDonePromise = new Promise<void>((resolve, reject) => {
    entryDoneResolve = resolve;
    entryDoneReject = reject;
  });

  const parser = unzipper.Parse();
  parser.on("entry", (entry: any) => {
    if (entryFound) {
      entry.autodrain();
      return;
    }
    if (entry.path === zipEntryName(file)) {
      entryFound = true;
      entry.on("error", (err: Error) => entryDoneReject?.(err));
      entry.on("end", () => {
        entryDone = true;
        entryDoneResolve?.();
      });
      entry.pipe(output);
      return;
    }
    entry.autodrain();
  });
  parser.on("error", (err: Error) => entryDoneReject?.(err));

  encryptedStream.pipe(decipher).pipe(parser);

  try {
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadToFile(part.url, partPath);

      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }

      await pipeFileToStream(partPath, encryptedStream);
      await fs.promises.unlink(partPath);
    }

    if (!entryFound) {
      throw new Error("file_not_found");
    }

    await entryDonePromise;
    encryptedStream.end();
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

  const workDir = path.join(tempBaseDir, "restore", `${archive.id}_bundle_${fileIndex}`);
  await fs.promises.mkdir(workDir, { recursive: true });

  const encryptedStream = new PassThrough();
  const key = deriveKey(masterKey);
  const iv = Buffer.from(archive.iv, "base64");
  const authTag = Buffer.from(archive.authTag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  decipher.on("error", () => {
    res.destroy();
  });

  const downloadName = (file.originalName || file.name || "file").replace(/[\\/]/g, "_");
  const safeName = downloadName
    .split("")
    .map((ch) => (/[a-zA-Z0-9._ -]/.test(ch) ? ch : "_"))
    .join("");
  const contentType = (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}\"`);
  if (file.size) {
    res.setHeader("Content-Length", file.size);
  }

  let entryFound = false;

  const parser = unzipper.Parse();
  parser.on("entry", (entry: any) => {
    if (entryFound) {
      entry.autodrain();
      return;
    }
    if (entry.path === zipEntryName(file)) {
      entryFound = true;
      entry.on("error", () => res.destroy());
      entry.on("end", () => {
        if (!res.writableEnded) {
          res.end();
        }
      });
      entry.pipe(res);
      return;
    }
    entry.autodrain();
  });
  parser.on("error", () => {
    log("restore", `bundle stream parse error ${archive.id}`);
    res.destroy();
  });
  parser.on("close", () => {
    if (!entryFound && !res.headersSent) {
      res.status(404).end();
    }
  });

  encryptedStream.pipe(decipher).pipe(parser);

  let aborted = false;
  res.on("close", () => {
    aborted = true;
    encryptedStream.destroy();
    parser.destroy();
  });

  try {
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      if (aborted) break;
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadToFile(part.url, partPath);

      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }

      await pipeFileToStream(partPath, encryptedStream);
      await fs.promises.unlink(partPath);
    }

    if (!aborted) {
      encryptedStream.end();
    }
  } catch (err) {
    log("restore", `bundle stream failed ${archive.id} ${(err as Error).message}`);
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
  const workDir = path.join(tempBaseDir, "restore", archive.id);
  await fs.promises.mkdir(workDir, { recursive: true });

  const encryptedStream = new PassThrough();
  const key = deriveKey(masterKey);
  const iv = Buffer.from(archive.iv, "base64");
  const authTag = Buffer.from(archive.authTag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  decipher.on("error", () => {
    res.destroy();
  });

  const downloadName = archive.downloadName || (archive.isBundle ? `${archive.name}.zip` : archive.name);
  const safeName = downloadName
    .split("")
    .map((ch) => (/[a-zA-Z0-9._ -]/.test(ch) ? ch : "_"))
    .join("");
  const contentType = archive.isBundle
    ? "application/zip"
    : (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}\"`);
  if (!archive.isBundle && archive.files?.[0]?.size) {
    res.setHeader("Content-Length", archive.files[0].size);
  }

  encryptedStream.pipe(decipher).pipe(res);

  let aborted = false;
  res.on("close", () => {
    aborted = true;
    encryptedStream.destroy();
  });

  try {
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      if (aborted) break;
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadToFile(part.url, partPath);

      const actualHash = await hashFile(partPath);
      if (actualHash !== part.hash) {
        throw new Error(`part_hash_mismatch:${part.index}`);
      }

      await pipeFileToStream(partPath, encryptedStream);
      await fs.promises.unlink(partPath);
    }

    if (!aborted) {
      encryptedStream.end();
    }
  } catch (err) {
    log("restore", `stream failed ${archive.id} ${(err as Error).message}`);
    res.destroy();
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    endRestore();
  }
}
