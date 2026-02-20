import fs from "fs";
import path from "path";
import crypto from "crypto";
import { checkDiskSpace } from "./disk.js";
import { Archive } from "../models/Archive.js";
import { User } from "../models/User.js";
import { Webhook } from "../models/Webhook.js";
import { config, computed } from "../config.js";
import { createZip, splitFileIntoParts } from "./archive.js";
import { deriveKey, encryptFile } from "./crypto.js";
import { deleteWebhookMessage, uploadBufferToWebhook, uploadToWebhook } from "./discord.js";
import { restoreArchiveToFile } from "./restore.js";
import { uniqueParts } from "./parts.js";

let running = 0;
let deleting = false;
let migrating = false;
const migrateBackoffUntil = new Map<string, number>();

function log(message: string) {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

function startStage(archiveId: string, name: string) {
  const started = Date.now();
  log(`stage ${archiveId} ${name} start`);
  return () => {
    const elapsed = Date.now() - started;
    log(`stage ${archiveId} ${name} done ${elapsed}ms`);
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupMigrateBackoff(now = Date.now()) {
  for (const [id, until] of migrateBackoffUntil.entries()) {
    if (until <= now) {
      migrateBackoffUntil.delete(id);
    }
  }
}

function isMigrationBackoff(id: string, now = Date.now()) {
  const until = migrateBackoffUntil.get(id);
  if (!until) return false;
  if (until <= now) {
    migrateBackoffUntil.delete(id);
    return false;
  }
  return true;
}

function setMigrationBackoff(id: string) {
  const ms = Math.max(1, config.migrateV1BackoffMinutes) * 60 * 1000;
  migrateBackoffUntil.set(id, Date.now() + ms);
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
      log(`retry upload attempt=${attempt} delay=${delay}ms`);
      await sleep(delay);
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
      log(`retry upload attempt=${attempt} delay=${delay}ms`);
      await sleep(delay);
    }
  }
}

async function resetStaleProcessing() {
  const threshold = new Date(Date.now() - config.processingStaleMinutes * 60 * 1000);
  const stale = await Archive.find({ status: "processing", updatedAt: { $lt: threshold }, deletedAt: null }).lean();
  for (const item of stale) {
    const reset: Record<string, unknown> = { status: "queued" };
    if (!item.parts || item.parts.length === 0) {
      reset.uploadedBytes = 0;
      reset.uploadedParts = 0;
    }
    await Archive.updateOne({ _id: item._id }, { $set: reset });
    log(`reset stale ${item._id}`);
  }
}

async function hasDiskSpace() {
  const info = await checkDiskSpace(config.cacheDir);
  const freeGb = info.free / (1024 * 1024 * 1024);
  if (freeGb < config.diskHardLimitGb) {
    return { ok: false, mode: "hard" as const, freeGb };
  }
  if (freeGb < config.diskSoftLimitGb) {
    return { ok: true, mode: "soft" as const, freeGb };
  }
  return { ok: true, mode: "normal" as const, freeGb };
}

async function processNextArchive() {
  const disk = await hasDiskSpace();
  if (!disk.ok) {
    return;
  }

  const archive = await Archive.findOneAndUpdate(
    { status: "queued", deletedAt: null, trashedAt: null },
    { status: "processing", error: "" },
    { sort: { priority: -1, createdAt: 1 }, new: true }
  );

  if (!archive) {
    return;
  }

  log(`start ${archive.id} priority=${archive.priority}`);

  const workDir = path.join(config.cacheDir, "work", archive.id);
  const zipPath = path.join(workDir, "archive.zip");
  const encPath = path.join(workDir, "archive.enc");
  const partsDir = path.join(workDir, "parts");

  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    let inputPath = zipPath;
    if (archive.isBundle) {
      const done = startStage(archive.id, "zip");
      if (!fs.existsSync(zipPath)) {
        await createZip(archive.files, zipPath);
      } else {
        log(`stage ${archive.id} zip reuse`);
      }
      done();
    } else {
      if (!archive.files[0]) {
        throw new Error("missing_file");
      }
      inputPath = archive.files[0].path;
    }

    const encryptionVersion = archive.encryptionVersion || 1;
    if (encryptionVersion >= 2) {
      const webhooks = await Webhook.find({ enabled: true });
      if (webhooks.length === 0) {
        throw new Error("no_webhooks_configured");
      }
      const uploadedParts = uniqueParts(archive.parts || []);
      const uploadedIndex = new Set(uploadedParts.map((p) => p.index));
      const completedFromParts = uploadedParts.length;
      if (!archive.uploadedParts || archive.uploadedParts < completedFromParts) {
        archive.uploadedParts = completedFromParts;
      }
      if (!archive.uploadedBytes || archive.uploadedBytes === 0) {
        archive.uploadedBytes = uploadedParts.reduce((sum, p) => sum + (p.size || 0), 0);
      }

      const key = deriveKey(config.masterKey);
      const rs = fs.createReadStream(inputPath, { highWaterMark: computed.chunkSizeBytes });
      let partIndex = 0;
      let totalEncryptedSize = 0;
      let uploadedNow = archive.uploadedParts || 0;

      for await (const chunk of rs) {
        const plainChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalEncryptedSize += plainChunk.length;

        if (uploadedIndex.has(partIndex)) {
          partIndex += 1;
          continue;
        }

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(plainChunk), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const hash = crypto.createHash("sha256").update(encrypted).digest("hex");
        const webhook = webhooks[partIndex % webhooks.length];
        const content = `archive:${archive.id} part:${partIndex}`;
        const result = await uploadBufferWithRetry(encrypted, `part_${partIndex}`, webhook.url, content);

        const partDoc = {
          index: partIndex,
          size: encrypted.length,
          plainSize: plainChunk.length,
          hash,
          url: result.url,
          messageId: result.messageId,
          webhookId: webhook.id,
          iv: iv.toString("base64"),
          authTag: authTag.toString("base64")
        };
        await Archive.updateOne(
          { _id: archive.id },
          { $push: { parts: partDoc }, $inc: { uploadedBytes: encrypted.length, uploadedParts: 1 } }
        );
        uploadedNow += 1;
        if (uploadedNow % 10 === 0) {
          log(`progress ${archive.id} ${uploadedNow}/${partIndex + 1}`);
        }
        partIndex += 1;
      }

      archive.encryptedSize = totalEncryptedSize;
      archive.totalParts = partIndex;
      archive.iv = "";
      archive.authTag = "";
      archive.encryptionVersion = 2;
      await archive.save();

      await Archive.updateOne({ _id: archive.id }, { $set: { status: "ready", error: "" } });
      log(`ready ${archive.id}`);

      if (config.cacheDeleteAfterUpload) {
        await fs.promises.rm(archive.stagingDir, { recursive: true, force: true });
        await fs.promises.rm(workDir, { recursive: true, force: true });
      }

      if (disk.mode === "soft") {
        await new Promise((r) => setTimeout(r, config.workerPollMs));
      }
      return;
    }

    if (!fs.existsSync(encPath) || !archive.iv || !archive.authTag) {
      const done = startStage(archive.id, "encrypt");
      const key = deriveKey(config.masterKey);
      const encMeta = await encryptFile(inputPath, encPath, key);
      archive.iv = encMeta.iv;
      archive.authTag = encMeta.authTag;
      done();
      if (config.deleteStagingAfterEncrypt && inputPath === archive.files[0]?.path) {
        await fs.promises.unlink(inputPath).catch(() => undefined);
        const stagingDir = archive.stagingDir;
        if (stagingDir) {
          const entries = await fs.promises.readdir(stagingDir).catch(() => []);
          if (entries.length === 0) {
            await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
    } else {
      log(`stage ${archive.id} encrypt reuse`);
    }

    const splitDone = startStage(archive.id, "split");
    const parts = await splitFileIntoParts(encPath, computed.chunkSizeBytes, partsDir);
    splitDone();
    const encStats = await fs.promises.stat(encPath);

    archive.encryptedSize = encStats.size;
    archive.totalParts = parts.length;
    if (!archive.uploadedBytes) archive.uploadedBytes = 0;
    if (!archive.uploadedParts) archive.uploadedParts = 0;
    if (archive.parts && archive.parts.length > 0 && archive.uploadedParts === 0) {
      archive.uploadedParts = archive.parts.length;
      archive.uploadedBytes = archive.parts.reduce((sum, p) => sum + p.size, 0);
    }
    await archive.save();

    const webhooks = await Webhook.find({ enabled: true });
    if (webhooks.length === 0) {
      throw new Error("no_webhooks_configured");
    }

    const uploadedParts = archive.parts || [];
    const uploadedIndex = new Set(uploadedParts.map((p) => p.index));
    const pendingParts = parts.filter((p) => !uploadedIndex.has(p.index));
    const totalParts = archive.totalParts;
    let completed = archive.uploadedParts || uploadedParts.length;

    const concurrency = Math.max(1, Math.min(config.uploadPartsConcurrency, webhooks.length));
    log(`upload ${archive.id} parts=${pendingParts.length}/${totalParts} concurrency=${concurrency}`);

    const workers = Array.from({ length: concurrency }, () => (async () => {
      while (true) {
        const part = pendingParts.shift();
        if (!part) return;

        const webhook = webhooks[part.index % webhooks.length];
        const content = `archive:${archive.id} part:${part.index}`;
        const result = await uploadWithRetry(part.path, webhook.url, content);
        const partDoc = {
          index: part.index,
          size: part.size,
          hash: part.hash,
          url: result.url,
          messageId: result.messageId,
          webhookId: webhook.id
        };
        await Archive.updateOne(
          { _id: archive.id },
          { $push: { parts: partDoc }, $inc: { uploadedBytes: part.size, uploadedParts: 1 } }
        );
        completed += 1;
        if (completed % 10 === 0 || completed === totalParts) {
          log(`progress ${archive.id} ${completed}/${totalParts}`);
        }
      }
    })());

    await Promise.all(workers);

    await Archive.updateOne({ _id: archive.id }, { $set: { status: "ready", error: "" } });
    log(`ready ${archive.id}`);

    if (config.cacheDeleteAfterUpload) {
      await fs.promises.rm(archive.stagingDir, { recursive: true, force: true });
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }

    if (disk.mode === "soft") {
      await new Promise((r) => setTimeout(r, config.workerPollMs));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    const retryable = isTransientError(err);
    if (retryable && archive.retryCount < config.uploadRetryMax) {
      await Archive.updateOne(
        { _id: archive.id },
        { $set: { status: "queued", error: message }, $inc: { retryCount: 1 } }
      );
      log(`retry queued ${archive.id} (${archive.retryCount + 1}/${config.uploadRetryMax}) ${message}`);
    } else {
      await Archive.updateOne({ _id: archive.id }, { $set: { status: "error", error: message } });
      log(`error ${archive.id} ${message}`);
    }
  }
}

async function deletePartsFromDiscord(parts: Array<{ messageId: string; webhookId: string }>) {
  if (!parts.length) return;
  const hooks = await Webhook.find().lean();
  const hookById = new Map(hooks.map((h) => [h._id.toString(), h.url]));
  for (const part of parts) {
    const hookUrl = hookById.get(String(part.webhookId));
    if (!hookUrl) continue;
    try {
      await deleteWebhookMessage(hookUrl, part.messageId);
    } catch {
      // best-effort cleanup
    }
  }
}

async function findV1MigrationCandidate() {
  cleanupMigrateBackoff();
  const candidates = await Archive.find({
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    encryptionVersion: { $lt: 2 }
  })
    .sort({ updatedAt: 1 })
    .limit(20);

  for (const archive of candidates) {
    if (!isMigrationBackoff(archive.id)) {
      return archive;
    }
  }
  return null;
}

async function processV1Migration() {
  if (!config.migrateV1Enabled || migrating) {
    return false;
  }

  const archive = await findV1MigrationCandidate();
  if (!archive) {
    return false;
  }

  migrating = true;
  const oldParts = uniqueParts(archive.parts || []);
  const workDir = path.join(
    config.cacheDir,
    "migrate",
    `${archive.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const plainPath = path.join(workDir, archive.isBundle ? "archive.zip" : "archive.bin");
  const uploadedNewParts: Array<{ messageId: string; webhookId: string }> = [];

  try {
    const disk = await hasDiskSpace();
    if (!disk.ok) {
      setMigrationBackoff(archive.id);
      return false;
    }

    const webhooks = await Webhook.find({ enabled: true });
    if (webhooks.length === 0) {
      setMigrationBackoff(archive.id);
      return false;
    }

    await fs.promises.mkdir(workDir, { recursive: true });
    log(`migrate start ${archive.id} v1->v2`);

    const restoreDone = startStage(archive.id, "migrate_restore_v1");
    await restoreArchiveToFile(archive, plainPath, config.cacheDir, config.masterKey);
    restoreDone();

    const uploadDone = startStage(archive.id, "migrate_upload_v2");
    const key = deriveKey(config.masterKey);
    const rs = fs.createReadStream(plainPath, { highWaterMark: computed.chunkSizeBytes });
    const newParts: any[] = [];
    let partIndex = 0;
    let uploadedBytes = 0;
    let encryptedSize = 0;

    for await (const chunk of rs) {
      const plainChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      encryptedSize += plainChunk.length;

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plainChunk), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const hash = crypto.createHash("sha256").update(encrypted).digest("hex");
      const webhook = webhooks[partIndex % webhooks.length];
      const content = `archive:${archive.id} migrate_v2 part:${partIndex}`;
      const result = await uploadBufferWithRetry(encrypted, `part_${partIndex}`, webhook.url, content);

      uploadedNewParts.push({ messageId: result.messageId, webhookId: webhook.id });
      newParts.push({
        index: partIndex,
        size: encrypted.length,
        plainSize: plainChunk.length,
        hash,
        url: result.url,
        messageId: result.messageId,
        webhookId: webhook.id,
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64")
      });
      uploadedBytes += encrypted.length;
      partIndex += 1;
      if (partIndex % 10 === 0) {
        log(`migrate progress ${archive.id} ${partIndex}`);
      }
    }
    uploadDone();

    const swap = await Archive.updateOne(
      { _id: archive.id, status: "ready", deletedAt: null, trashedAt: null, encryptionVersion: { $lt: 2 } },
      {
        $set: {
          parts: newParts,
          encryptionVersion: 2,
          iv: "",
          authTag: "",
          uploadedParts: partIndex,
          totalParts: partIndex,
          uploadedBytes,
          encryptedSize,
          error: "",
          chunkSizeBytes: computed.chunkSizeBytes,
          retryCount: 0
        }
      }
    );

    if (swap.modifiedCount === 0) {
      log(`migrate skip ${archive.id} changed before swap`);
      await deletePartsFromDiscord(uploadedNewParts);
      setMigrationBackoff(archive.id);
      return true;
    }

    if (config.migrateV1DeleteOldParts) {
      await deletePartsFromDiscord(oldParts);
    }

    migrateBackoffUntil.delete(archive.id);
    log(`migrate ready ${archive.id} parts=${partIndex}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`migrate error ${archive.id} ${message}`);
    await deletePartsFromDiscord(uploadedNewParts);
    setMigrationBackoff(archive.id);
    return true;
  } finally {
    migrating = false;
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processDelete() {
  const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const candidate = await Archive.findOneAndUpdate(
    {
      deletedAt: null,
      deleting: false,
      $or: [{ deleteRequestedAt: { $ne: null } }, { trashedAt: { $ne: null, $lte: threshold } }]
    },
    { deleting: true },
    { sort: { deleteRequestedAt: 1, trashedAt: 1 }, new: true }
  );

  if (!candidate) return false;

  log(`delete start ${candidate.id}`);

  try {
    const hooks = await Webhook.find();
    const hookById = new Map(hooks.map((h) => [h.id.toString(), h.url]));
    let deletedParts = 0;
    const parts = uniqueParts(candidate.parts);
    const total = parts.length;
    await Archive.updateOne(
      { _id: candidate.id },
      { $set: { deleteTotalParts: total, deletedParts: 0 } }
    );
    for (const part of parts) {
      const hookUrl = hookById.get(part.webhookId);
      if (!hookUrl) continue;
      try {
        await deleteWebhookMessage(hookUrl, part.messageId);
        deletedParts += 1;
        await Archive.updateOne(
          { _id: candidate.id },
          { $set: { deletedParts } }
        );
        if (deletedParts % 10 === 0 || deletedParts === total) {
          log(`delete progress ${candidate.id} ${deletedParts}/${total}`);
        }
      } catch {
        // ignore single delete failures
      }
    }

    await Archive.updateOne(
      { _id: candidate.id },
      { $set: { deletedAt: new Date() }, $unset: { parts: 1 } }
    );

    await User.updateOne({ _id: candidate.userId }, { $inc: { usedBytes: -candidate.originalSize } });
    log(`delete done ${candidate.id}`);
    return true;
  } finally {
    await Archive.updateOne({ _id: candidate.id }, { $set: { deleting: false } });
  }
}

export function startWorker() {
  setInterval(async () => {
    while (running < config.workerConcurrency) {
      running += 1;
      (async () => {
        try {
          await resetStaleProcessing();
          const before = await Archive.countDocuments({ status: "queued", deletedAt: null, trashedAt: null });
          if (before > 0) {
            await processNextArchive();
          } else if (!deleting) {
            deleting = true;
            try {
              const didDelete = await processDelete();
              if (!didDelete) {
                await processV1Migration();
              }
            } finally {
              deleting = false;
            }
          }
        } finally {
          running -= 1;
        }
      })();
    }
  }, config.workerPollMs);
}
