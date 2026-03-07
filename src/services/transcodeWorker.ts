import { Archive } from "../models/Archive.js";
import { config } from "../config.js";
import { ensureArchiveFileTranscode, needsTranscodeCopy, syncSourceTranscodeStateFromArchive } from "./transcodes.js";
import fs from "fs";
import path from "path";

const queued = new Set<string>();
const active = new Set<string>();
const retryAt = new Map<string, number>();
let ticker: NodeJS.Timeout | null = null;
let tickRunning = false;

export function getTranscodeWorkerState() {
  return {
    enabled: config.transcodeWorkerEnabled,
    queued: queued.size,
    active: active.size,
    retryScheduled: retryAt.size,
    tickRunning
  };
}

function log(message: string) {
  console.log(`[transcode-worker] ${new Date().toISOString()} ${message}`);
}

function fileNeedsTranscode(file: any) {
  if (!file || file.deletedAt) return false;
  const sourceName = file.originalName || file.name || "";
  if (!needsTranscodeCopy(sourceName, file.detectedKind)) return false;
  const status = String(file?.transcode?.status || "");
  const archiveId = String(file?.transcode?.archiveId || "");
  if (status === "ready" || status === "queued" || status === "processing" || status === "skipped") {
    return false;
  }
  if (archiveId && status !== "error") {
    return false;
  }
  return true;
}

function archiveNeedsTranscodeWork(archive: any) {
  if (!archive?.files || archive.files.length === 0) return false;
  if (String(archive.archiveKind || "primary") === "transcoded") return false;
  if (archive.status !== "ready") return false;
  return archive.files.some((file: any) => fileNeedsTranscode(file));
}

function nextRetryDelayMs(message: string) {
  if (message === "quota_exceeded" || message === "disabled_by_user") {
    return Math.max(config.transcodeRetryMs, 30 * 60 * 1000);
  }
  return config.transcodeRetryMs;
}

export function queueArchiveTranscodes(archiveId: string) {
  if (!archiveId) return;
  const key = String(archiveId);
  const waitUntil = retryAt.get(key) || 0;
  if (waitUntil > Date.now()) return;
  queued.add(key);
}

async function refillQueue() {
  if (queued.size >= config.transcodeWorkerConcurrency * 4) return;
  const candidates = await Archive.find({
    archiveKind: { $ne: "transcoded" },
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    "files.0": { $exists: true }
  })
    .sort({ createdAt: 1 })
    .select("_id status archiveKind files")
    .limit(config.transcodeBackfillScanLimit)
    .lean();

  for (const archive of candidates) {
    if (queued.size >= config.transcodeWorkerConcurrency * 6) break;
    if (!archiveNeedsTranscodeWork(archive)) continue;
    const id = archive._id.toString();
    if (active.has(id)) continue;
    const waitUntil = retryAt.get(id) || 0;
    if (waitUntil > Date.now()) continue;
    queued.add(id);
  }
}

async function processArchive(archiveId: string) {
  const archive = await Archive.findById(archiveId);
  if (!archive) return;
  if (archive.deletedAt || archive.trashedAt) return;
  if (String(archive.archiveKind || "primary") === "transcoded") return;
  if (archive.status !== "ready") return;

  await syncSourceTranscodeStateFromArchive(archive).catch(() => undefined);

  let generated = 0;
  for (let fileIndex = 0; fileIndex < archive.files.length; fileIndex += 1) {
    if (!fileNeedsTranscode(archive.files[fileIndex])) continue;
    try {
      const id = await ensureArchiveFileTranscode(archive, fileIndex);
      if (id) {
        generated += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`error ${archiveId} file=${fileIndex} ${message}`);
      retryAt.set(archiveId, Date.now() + nextRetryDelayMs(message));
      queued.add(archiveId);
      return;
    }
  }

  retryAt.delete(archiveId);
  const refreshed = await Archive.findById(archiveId).select("stagingDir files").lean();
  if (refreshed && config.cacheDeleteAfterUpload) {
    const stillPending = (refreshed.files || []).some((file: any) => fileNeedsTranscode(file));
    if (!stillPending) {
      const stagingDir = String(refreshed.stagingDir || "");
      if (stagingDir) {
        const safeRoot = path.resolve(path.join(config.cacheDir, "staging"));
        const safeTarget = path.resolve(stagingDir);
        if (safeTarget.startsWith(safeRoot)) {
          await fs.promises.rm(safeTarget, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  }
  if (generated > 0) {
    log(`ready ${archiveId} generated=${generated}`);
  }
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await refillQueue();
    while (active.size < config.transcodeWorkerConcurrency && queued.size > 0) {
      const next = queued.values().next().value as string | undefined;
      if (!next) break;
      queued.delete(next);
      const waitUntil = retryAt.get(next) || 0;
      if (waitUntil > Date.now()) continue;
      active.add(next);
      (async () => {
        try {
          await processArchive(next);
        } finally {
          active.delete(next);
        }
      })();
    }
  } finally {
    tickRunning = false;
  }
}

export function startTranscodeWorker() {
  if (!config.transcodeWorkerEnabled) {
    log("disabled");
    return;
  }
  if (ticker) return;
  ticker = setInterval(() => {
    void tick();
  }, config.transcodeWorkerPollMs);
  void tick();
  log(`started concurrency=${config.transcodeWorkerConcurrency} poll=${config.transcodeWorkerPollMs}ms`);
}
