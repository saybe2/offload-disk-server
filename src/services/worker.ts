import fs from "fs";
import path from "path";
import { checkDiskSpace } from "./disk.js";
import { Archive } from "../models/Archive.js";
import { User } from "../models/User.js";
import { Webhook } from "../models/Webhook.js";
import { config, computed } from "../config.js";
import { createZip, splitFileIntoParts } from "./archive.js";
import { deriveKey, encryptFile } from "./crypto.js";
import { deleteWebhookMessage, uploadToWebhook } from "./discord.js";
import { uniqueParts } from "./parts.js";

let running = 0;
let deleting = false;

function log(message: string) {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      if (!fs.existsSync(zipPath)) {
        await createZip(archive.files, zipPath);
      }
    } else {
      if (!archive.files[0]) {
        throw new Error("missing_file");
      }
      inputPath = archive.files[0].path;
    }

    if (!fs.existsSync(encPath) || !archive.iv || !archive.authTag) {
      const key = deriveKey(config.masterKey);
      const encMeta = await encryptFile(inputPath, encPath, key);
      archive.iv = encMeta.iv;
      archive.authTag = encMeta.authTag;
    }

    const parts = await splitFileIntoParts(encPath, computed.chunkSizeBytes, partsDir);
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

  if (!candidate) return;

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
              await processDelete();
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
