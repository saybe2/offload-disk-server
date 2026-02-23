import { Archive } from "../models/Archive.js";
import { config } from "../config.js";
import {
  ensureArchiveThumbnail,
  ensureArchiveThumbnailFromSource,
  isPermanentThumbnailFailureMessage,
  supportsThumbnail
} from "./thumbnails.js";

const queued = new Set<string>();
const active = new Set<string>();
const retryAt = new Map<string, number>();
let ticker: NodeJS.Timeout | null = null;
let tickRunning = false;

function log(message: string) {
  console.log(`[thumb-worker] ${new Date().toISOString()} ${message}`);
}

function fileNeedsThumbnail(file: any) {
  if (file?.deletedAt) return false;
  if (file?.thumbnail?.failedAt) return false;
  const fileName = file?.originalName || file?.name || "";
  if (!supportsThumbnail(fileName, file?.detectedKind)) return false;
  return !file?.thumbnail?.updatedAt;
}

function archiveNeedsThumbnail(archive: any) {
  if (!archive?.files || archive.files.length === 0) return false;
  for (const file of archive.files) {
    if (fileNeedsThumbnail(file)) {
      return true;
    }
  }
  return false;
}

export function queueArchiveThumbnails(archiveId: string) {
  if (!archiveId) return;
  const key = String(archiveId);
  const waitUntil = retryAt.get(key) || 0;
  if (waitUntil > Date.now()) return;
  queued.add(key);
}

async function refillQueue() {
  if (queued.size >= config.thumbWorkerConcurrency * 4) {
    return;
  }
  const candidates = await Archive.find({
    status: { $in: ["queued", "processing", "ready"] },
    deletedAt: null,
    trashedAt: null,
    "files.0": { $exists: true },
    "files.thumbnail.updatedAt": { $exists: false }
  })
    .sort({ createdAt: 1 })
    .select("_id files")
    .limit(config.thumbBackfillScanLimit)
    .lean();

  for (const archive of candidates) {
    if (queued.size >= config.thumbWorkerConcurrency * 6) {
      break;
    }
    if (!archiveNeedsThumbnail(archive)) {
      continue;
    }
    const id = archive._id.toString();
    if (!active.has(id)) {
      const waitUntil = retryAt.get(id) || 0;
      if (waitUntil <= Date.now()) {
        queued.add(id);
      }
    }
  }
}

async function processArchive(archiveId: string) {
  const archive = await Archive.findById(archiveId);
  if (!archive) return;
  if (archive.deletedAt || archive.trashedAt) return;

  let generated = 0;
  let waitingForReady = false;
  for (let fileIndex = 0; fileIndex < archive.files.length; fileIndex += 1) {
    const file = archive.files[fileIndex];
    if (!fileNeedsThumbnail(file)) continue;

    try {
      if (file.path) {
        await ensureArchiveThumbnailFromSource(archive, fileIndex);
      } else if (archive.status === "ready") {
        await ensureArchiveThumbnail(archive, fileIndex);
      } else {
        waitingForReady = true;
        continue;
      }
      generated += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanentThumbnailFailureMessage(message)) {
        continue;
      }
      if (message === "source_missing" && archive.status === "ready") {
        try {
          await ensureArchiveThumbnail(archive, fileIndex);
          generated += 1;
          continue;
        } catch (fallbackErr) {
          const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          if (isPermanentThumbnailFailureMessage(fallbackMessage)) {
            continue;
          }
          log(`error ${archiveId} file=${fileIndex} ${fallbackMessage}`);
          retryAt.set(archiveId, Date.now() + config.thumbRetryMs);
          queued.add(archiveId);
          return;
        }
      }
      if (message === "source_missing" && archive.status !== "ready") {
        waitingForReady = true;
        continue;
      }
      log(`error ${archiveId} file=${fileIndex} ${message}`);
      retryAt.set(archiveId, Date.now() + config.thumbRetryMs);
      queued.add(archiveId);
      return;
    }
  }

  if (waitingForReady) {
    retryAt.set(archiveId, Date.now() + config.thumbRetryMs);
    queued.add(archiveId);
  } else {
    retryAt.delete(archiveId);
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
    while (active.size < config.thumbWorkerConcurrency && queued.size > 0) {
      const next = queued.values().next().value as string | undefined;
      if (!next) break;
      queued.delete(next);
      const waitUntil = retryAt.get(next) || 0;
      if (waitUntil > Date.now()) {
        continue;
      }
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

export function startThumbnailWorker() {
  if (!config.thumbWorkerEnabled) {
    log("disabled");
    return;
  }
  if (ticker) return;
  ticker = setInterval(() => {
    void tick();
  }, config.thumbWorkerPollMs);
  void tick();
  log(`started concurrency=${config.thumbWorkerConcurrency} poll=${config.thumbWorkerPollMs}ms`);
}
