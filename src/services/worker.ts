import fs from "fs";
import path from "path";
import crypto from "crypto";
import { checkDiskSpace } from "./disk.js";
import { Archive } from "../models/Archive.js";
import { User } from "../models/User.js";
import { Webhook } from "../models/Webhook.js";
import { config, computed } from "../config.js";
import { createZip } from "./archive.js";
import { deriveKey } from "./crypto.js";
import {
  deletePartRemote,
  refreshPartUrl,
  saveMirrorResult,
  toPartDocument,
  uploadMirrorForPart,
  uploadPartMirrored
} from "./partProvider.js";
import { uniqueParts } from "./parts.js";
import { ensureArchiveThumbnailFromSource, supportsThumbnail } from "./thumbnails.js";
import { isTelegramReady } from "./telegram.js";
import { outboundFetch } from "./outbound.js";

let running = 0;
let deleting = false;
let mirrorMaintenanceRunning = false;
let startupRecoveryPromise: Promise<void> | null = null;

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
  const tgMatch = message.match(/telegram_(upload|get_file|delete)_failed:(\d{3})/);
  if (tgMatch) {
    const code = Number(tgMatch[1]);
    if (code === 429) return true;
    if (code >= 500 && code <= 599) return true;
  }
  return false;
}

async function uploadBufferWithRetry(
  buffer: Buffer,
  filename: string,
  content: string,
  webhook?: { id: string; url: string }
) {
  return withRetry(
    () => uploadPartMirrored(buffer, filename, content, webhook),
    "upload"
  );
}

async function withRetry<T>(operation: () => Promise<T>, label: string) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      attempt += 1;
      if (!isTransientError(err) || attempt > config.uploadRetryMax) {
        throw err;
      }
      const delay = Math.min(config.uploadRetryMaxMs, config.uploadRetryBaseMs * Math.pow(2, attempt - 1));
      log(`retry ${label} attempt=${attempt} delay=${delay}ms`);
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

async function recoverProcessingAfterRestart() {
  const stuck = await Archive.find({ status: "processing", deletedAt: null }).lean();
  if (stuck.length === 0) {
    return;
  }
  for (const item of stuck) {
    const reset: Record<string, unknown> = { status: "queued" };
    if (!item.parts || item.parts.length === 0) {
      reset.uploadedBytes = 0;
      reset.uploadedParts = 0;
    }
    await Archive.updateOne({ _id: item._id }, { $set: reset });
    log(`recovered after restart ${item._id}`);
  }
}

async function ensureStartupRecovery() {
  if (!startupRecoveryPromise) {
    startupRecoveryPromise = recoverProcessingAfterRestart().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`startup recovery error ${message}`);
    });
  }
  await startupRecoveryPromise;
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

async function generateLocalThumbnails(archive: any) {
  if (!archive?.files?.length) return;
  let generated = 0;
  for (let fileIndex = 0; fileIndex < archive.files.length; fileIndex += 1) {
    const file = archive.files[fileIndex];
    if (file?.deletedAt) continue;
    const fileName = file?.originalName || file?.name || "";
    if (!supportsThumbnail(fileName, file?.detectedKind)) continue;
    try {
      await ensureArchiveThumbnailFromSource(archive, fileIndex);
      generated += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`thumb skip ${archive.id} file=${fileIndex} ${message}`);
    }
  }
  if (generated > 0) {
    log(`thumb ready ${archive.id} generated=${generated}`);
  }
}

async function fetchBuffer(url: string) {
  const res = await outboundFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`download_failed:${res.status}:${text}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function loadEncryptedPartBuffer(archiveId: string, part: any) {
  try {
    return await fetchBuffer(String(part.url || ""));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/download_failed:(401|403|404)/.test(message)) {
      throw err;
    }
    await refreshPartUrl(archiveId, part);
    return await fetchBuffer(String(part.url || ""));
  }
}

async function processMirrorSync() {
  const archive = await Archive.findOne({
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    "parts.mirrorPending": true
  });
  if (!archive) {
    return false;
  }

  const telegramReady = isTelegramReady();
  const webhooks = await Webhook.find({ enabled: true }).lean();
  const parts = uniqueParts(archive.parts || []);
  const targetPart = parts.find((p: any) => {
    if (!p?.mirrorPending) return false;
    if (p.mirrorProvider === "telegram") return telegramReady;
    if (p.mirrorProvider === "discord") return webhooks.length > 0;
    return false;
  });
  if (!targetPart) return false;

  // Claim a specific part atomically so parallel worker loops do not mirror it twice.
  const claim = await Archive.updateOne(
    {
      _id: archive.id,
      parts: {
        $elemMatch: {
          index: targetPart.index,
          mirrorPending: true,
          mirrorProvider: targetPart.mirrorProvider
        }
      }
    },
    { $set: { "parts.$.mirrorPending": false, "parts.$.mirrorError": "" } }
  );
  if (!claim.modifiedCount) {
    return false;
  }

  const webhook =
    targetPart.mirrorProvider === "discord" && webhooks.length > 0
      ? webhooks[Math.floor(Math.random() * webhooks.length)]
      : null;

  try {
    const encrypted = await loadEncryptedPartBuffer(archive.id, targetPart);
    const content = `archive:${archive.id} part:${targetPart.index} mirror_sync`;
    const mirror = await uploadMirrorForPart(
      targetPart,
      encrypted,
      content,
      webhook ? { id: String((webhook as any)._id || webhook.id), url: String(webhook.url) } : undefined
    );
    await saveMirrorResult(archive.id, targetPart.index, mirror, targetPart.mirrorProvider);
    log(`mirror synced ${archive.id} part=${targetPart.index} provider=${targetPart.mirrorProvider}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveMirrorResult(archive.id, targetPart.index, null, targetPart.mirrorProvider, message);
    log(`mirror sync error ${archive.id} part=${targetPart.index} ${message}`);
    return true;
  }
}

async function processMirrorSyncBatch() {
  const parallel = Math.max(1, config.mirrorSyncConcurrency);
  let processedAny = false;
  const runners = Array.from({ length: parallel }, async () => {
    while (true) {
      const processed = await processMirrorSync();
      if (!processed) {
        return;
      }
      processedAny = true;
    }
  });
  await Promise.all(runners);
  return processedAny;
}

async function prepareMirrorBackfill() {
  const telegramReady = isTelegramReady();
  const hasDiscord = (await Webhook.countDocuments({ enabled: true })) > 0;
  if (!telegramReady && !hasDiscord) {
    return false;
  }

  const archive = await Archive.findOne({
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    "parts.0": { $exists: true },
    $or: [
      { "parts.mirrorProvider": { $exists: false } },
      { "parts.mirrorProvider": null },
      { "parts.mirrorProvider": "" }
    ]
  }).sort({ updatedAt: 1, createdAt: 1 });

  if (!archive) {
    return false;
  }

  let changed = false;
  let prepared = 0;
  const parts = (archive.parts || []) as any[];
  for (const part of parts) {
    const primary = part?.provider === "telegram" ? "telegram" : "discord";
    if (!part.provider) {
      part.provider = primary;
      changed = true;
    }
    if (part?.mirrorProvider) {
      const hasMirror = !!part?.mirrorUrl && !!part?.mirrorMessageId;
      if (hasMirror && part.mirrorPending) {
        part.mirrorPending = false;
        changed = true;
      } else if (!hasMirror && !part.mirrorPending) {
        part.mirrorPending = true;
        prepared += 1;
        changed = true;
      }
      continue;
    }

    let target: "discord" | "telegram" | null = null;
    if (primary === "discord" && telegramReady) {
      target = "telegram";
    } else if (primary === "telegram" && hasDiscord) {
      target = "discord";
    }
    if (!target) {
      continue;
    }

    part.mirrorProvider = target;
    part.mirrorPending = true;
    part.mirrorError = "";
    prepared += 1;
    changed = true;
  }

  if (!changed || prepared === 0) {
    return false;
  }

  await archive.save();
  log(`mirror prepare ${archive.id} parts=${prepared}`);
  return true;
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
    const webhooks = await Webhook.find({ enabled: true });
    const telegramReady = isTelegramReady();
    if (webhooks.length === 0 && !telegramReady) {
      throw new Error("no_storage_provider_configured");
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
    const providerSlots = webhooks.length > 0 ? webhooks.length : 1;
    const concurrency = Math.max(1, Math.min(config.uploadPartsConcurrency, providerSlots));
    const maxPending = Math.max(10, concurrency * 3);
    let partIndex = 0;
    let totalEncryptedSize = 0;
    let uploadedNow = archive.uploadedParts || 0;
    const estimatedTotalParts = Math.max(
      uploadedNow + 1,
      Math.ceil((archive.originalSize || 0) / computed.chunkSizeBytes)
    );

    type PendingPart = {
      index: number;
      encrypted: Buffer;
      plainSize: number;
      hash: string;
      iv: string;
      authTag: string;
    };

    const pending: PendingPart[] = [];
    let activeUploads = 0;
    let finishedAdding = false;
    let uploadFailed: Error | null = null;
    let resolveUploadDone: (() => void) | null = null;
    const uploadDone = new Promise<void>((resolve) => {
      resolveUploadDone = resolve;
    });

    const maybeFinish = () => {
      if (finishedAdding && activeUploads === 0 && pending.length === 0 && resolveUploadDone) {
        resolveUploadDone();
      }
    };

    const spawnUploadWorkers = () => {
      while (!uploadFailed && activeUploads < concurrency && pending.length > 0) {
        const part = pending.shift();
        if (!part) break;
        activeUploads += 1;
        (async () => {
          try {
            const webhook = webhooks.length > 0 ? webhooks[part.index % webhooks.length] : null;
            const content = `archive:${archive.id} part:${part.index}`;
            const result = await uploadBufferWithRetry(
              part.encrypted,
              `part_${part.index}`,
              content,
              webhook ? { id: webhook.id, url: webhook.url } : undefined
            );
            const partDoc = {
              index: part.index,
              size: part.encrypted.length,
              plainSize: part.plainSize,
              hash: part.hash,
              ...toPartDocument(result.primary, result.mirrorTarget),
              iv: part.iv,
              authTag: part.authTag
            };
            await Archive.updateOne(
              { _id: archive.id },
              { $push: { parts: partDoc }, $inc: { uploadedBytes: part.encrypted.length, uploadedParts: 1 } }
            );
            if (result.mirrorResultPromise) {
              void result.mirrorResultPromise
                .then((mirror) => saveMirrorResult(archive.id, part.index, mirror, result.mirrorTarget))
                .catch((err) => {
                  const message = err instanceof Error ? err.message : String(err);
                  return saveMirrorResult(archive.id, part.index, null, result.mirrorTarget, message);
                });
            }
            uploadedNow += 1;
            if (uploadedNow % 10 === 0) {
              const totalHint = archive.totalParts && archive.totalParts > 0 ? archive.totalParts : estimatedTotalParts;
              const pct = totalHint > 0 ? Math.min(99, Math.floor((uploadedNow / totalHint) * 100)) : 0;
              log(`progress ${archive.id} ${uploadedNow}/${totalHint} (${pct}%)`);
            }
          } catch (err) {
            const asError = err instanceof Error ? err : new Error(String(err));
            if (!uploadFailed) {
              uploadFailed = asError;
              log(`upload error ${archive.id} ${asError.message}`);
            }
          } finally {
            activeUploads -= 1;
            if (!uploadFailed) {
              spawnUploadWorkers();
            }
            maybeFinish();
          }
        })();
      }
    };

    log(`upload ${archive.id} parts=stream/${estimatedTotalParts} concurrency=${concurrency}`);

    for await (const chunk of rs) {
      if (uploadFailed) {
        break;
      }
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
      pending.push({
        index: partIndex,
        encrypted,
        plainSize: plainChunk.length,
        hash,
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64")
      });
      partIndex += 1;
      spawnUploadWorkers();
      while (!uploadFailed && pending.length >= maxPending) {
        await sleep(20);
      }
    }

    finishedAdding = true;
    spawnUploadWorkers();
    maybeFinish();
    await uploadDone;
    if (uploadFailed) {
      throw uploadFailed;
    }

    archive.encryptedSize = totalEncryptedSize;
    archive.totalParts = partIndex;
    archive.iv = "";
    archive.authTag = "";
    archive.encryptionVersion = 2;
    await archive.save();

    await generateLocalThumbnails(archive);
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
      try {
        await deletePartRemote(part, hookById);
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
          await ensureStartupRecovery();
          await resetStaleProcessing();
          const before = await Archive.countDocuments({ status: "queued", deletedAt: null, trashedAt: null });
          if (before > 0) {
            await processNextArchive();
          } else {
            if (!mirrorMaintenanceRunning) {
              mirrorMaintenanceRunning = true;
              try {
                const mirrored = await processMirrorSyncBatch();
                if (mirrored) {
                  return;
                }
                const prepared = await prepareMirrorBackfill();
                if (prepared) {
                  return;
                }
              } finally {
                mirrorMaintenanceRunning = false;
              }
            }
          }
          if (!deleting) {
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
