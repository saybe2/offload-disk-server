import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PassThrough } from "stream";
import type { Response } from "express";
import mime from "mime-types";
import unzipper from "unzipper";
import { ArchiveDoc } from "../models/Archive.js";
import { Archive } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { downloadToFile, fetchWebhookMessage } from "./discord.js";
import { deriveKey } from "./crypto.js";
import { zipEntryName } from "./archive.js";
import { startRestore, endRestore } from "./activity.js";
import { uniqueParts } from "./parts.js";
import { log } from "../logger.js";

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

async function downloadPartWithRepair(
  archiveId: string,
  part: { index: number; url: string; messageId: string; webhookId: string },
  partPath: string,
  webhookCache: Map<string, string>
) {
  try {
    await downloadToFile(part.url, partPath);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/download_failed:404/.test(message)) {
      throw err;
    }
    let webhookUrl = webhookCache.get(part.webhookId);
    if (!webhookUrl) {
      const hook = await Webhook.findById(part.webhookId).lean();
      webhookUrl = hook?.url || "";
      webhookCache.set(part.webhookId, webhookUrl);
    }
    if (!webhookUrl) {
      throw err;
    }
    const payload = await fetchWebhookMessage(webhookUrl, part.messageId);
    const freshUrl = payload.attachments?.[0]?.url;
    if (!freshUrl) {
      throw err;
    }
    await Archive.updateOne(
      { _id: archiveId, "parts.messageId": part.messageId },
      { $set: { "parts.$.url": freshUrl } }
    );
    part.url = freshUrl;
    await downloadToFile(part.url, partPath);
  }
}

function archiveEncryptionVersion(archive: ArchiveDoc | any) {
  return archive.encryptionVersion || 1;
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
  if (archiveEncryptionVersion(archive) >= 2) {
    const workDir = path.join(tempBaseDir, "restore", `${archive.id}_file_v2`);
    await fs.promises.mkdir(workDir, { recursive: true });
    const output = fs.createWriteStream(outputPath);
    const key = deriveKey(masterKey);
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
          await new Promise<void>((resolve, reject) => {
            output.once("drain", resolve);
            output.once("error", reject);
          });
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
    return;
  }

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
    const webhookCache = new Map<string, string>();
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadPartWithRepair(archive.id, part, partPath, webhookCache);

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

  if (archiveEncryptionVersion(archive) >= 2) {
    const workDirV2 = path.join(tempBaseDir, "restore", `${archive.id}_file_${fileIndex}_v2`);
    await fs.promises.mkdir(workDirV2, { recursive: true });
    const key = deriveKey(masterKey);
    const zipStream = new PassThrough();

    const output = fs.createWriteStream(outputPath);
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
        entry.on("end", () => entryDoneResolve?.());
        entry.pipe(output);
        return;
      }
      entry.autodrain();
    });
    parser.on("error", (err: Error) => entryDoneReject?.(err));
    zipStream.pipe(parser);

    try {
      const webhookCache = new Map<string, string>();
      const parts = uniqueParts(archive.parts);
      for (const part of parts) {
        const partPath = path.join(workDirV2, `part_${part.index}`);
        await downloadPartWithRepair(archive.id, part, partPath, webhookCache);
        const actualHash = await hashFile(partPath);
        if (actualHash !== part.hash) {
          throw new Error(`part_hash_mismatch:${part.index}`);
        }
        const plain = await decryptPartToBuffer(partPath, part as any, key);
        await fs.promises.unlink(partPath).catch(() => undefined);
        if (!zipStream.write(plain)) {
          await new Promise<void>((resolve, reject) => {
            zipStream.once("drain", resolve);
            zipStream.once("error", reject);
          });
        }
      }

      zipStream.end();
      if (!entryFound) {
        throw new Error("file_not_found");
      }
      await entryDonePromise;
    } catch (err) {
      log("restore", `bundle extract failed ${archive.id} ${(err as Error).message}`);
      throw err;
    } finally {
      await fs.promises.rm(workDirV2, { recursive: true, force: true });
      endRestore();
    }
    return;
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
    const webhookCache = new Map<string, string>();
    const parts = uniqueParts(archive.parts);
    for (const part of parts) {
      const partPath = path.join(workDir, `part_${part.index}`);
      await downloadPartWithRepair(archive.id, part, partPath, webhookCache);

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

  if (archiveEncryptionVersion(archive) >= 2) {
    const workDirV2 = path.join(tempBaseDir, "restore", `${archive.id}_bundle_${fileIndex}_v2`);
    await fs.promises.mkdir(workDirV2, { recursive: true });
    const key = deriveKey(masterKey);
    const zipStream = new PassThrough();
    const downloadName = (file.originalName || file.name || "file").replace(/[\\/]/g, "_");
    const contentType = (mime.lookup(downloadName) as string) || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", contentDisposition(downloadName));
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
    zipStream.pipe(parser);

    let aborted = false;
    res.on("close", () => {
      aborted = true;
      zipStream.destroy();
      parser.destroy();
    });

    try {
      const webhookCache = new Map<string, string>();
      const parts = uniqueParts(archive.parts);
      for (const part of parts) {
        if (aborted) break;
        const partPath = path.join(workDirV2, `part_${part.index}`);
        await downloadPartWithRepair(archive.id, part, partPath, webhookCache);
        const actualHash = await hashFile(partPath);
        if (actualHash !== part.hash) {
          throw new Error(`part_hash_mismatch:${part.index}`);
        }
        const plain = await decryptPartToBuffer(partPath, part as any, key);
        await fs.promises.unlink(partPath).catch(() => undefined);
        if (!zipStream.write(plain)) {
          await new Promise<void>((resolve, reject) => {
            zipStream.once("drain", resolve);
            zipStream.once("error", reject);
          });
        }
      }
      if (!aborted) {
        zipStream.end();
      }
    } catch (err) {
      log("restore", `bundle stream failed ${archive.id} ${(err as Error).message}`);
      res.destroy();
    } finally {
      await fs.promises.rm(workDirV2, { recursive: true, force: true });
      endRestore();
    }
    return;
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
  const contentType = (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", contentDisposition(downloadName));
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
  if (archiveEncryptionVersion(archive) >= 2) {
    startRestore();
    const workDirV2 = path.join(tempBaseDir, "restore", `${archive.id}_v2`);
    await fs.promises.mkdir(workDirV2, { recursive: true });
    const key = deriveKey(masterKey);
    const downloadName = archive.downloadName || (archive.isBundle ? `${archive.name}.zip` : archive.name);
    const contentType = archive.isBundle
      ? "application/zip"
      : (mime.lookup(downloadName) as string) || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", contentDisposition(downloadName));
    if (!archive.isBundle && archive.files?.[0]?.size) {
      res.setHeader("Content-Length", archive.files[0].size);
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
        const partPath = path.join(workDirV2, `part_${part.index}`);
        await downloadPartWithRepair(archive.id, part, partPath, webhookCache);
        const actualHash = await hashFile(partPath);
        if (actualHash !== part.hash) {
          throw new Error(`part_hash_mismatch:${part.index}`);
        }
        const plain = await decryptPartToBuffer(partPath, part as any, key);
        await fs.promises.unlink(partPath).catch(() => undefined);
        if (!res.write(plain)) {
          await new Promise<void>((resolve, reject) => {
            res.once("drain", resolve);
            res.once("error", reject);
          });
        }
      }
      if (!aborted) {
        res.end();
      }
    } catch (err) {
      log("restore", `stream failed ${archive.id} ${(err as Error).message}`);
      res.destroy();
    } finally {
      await fs.promises.rm(workDirV2, { recursive: true, force: true });
      endRestore();
    }
    return;
  }

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
  const contentType = archive.isBundle
    ? "application/zip"
    : (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", contentDisposition(downloadName));
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
