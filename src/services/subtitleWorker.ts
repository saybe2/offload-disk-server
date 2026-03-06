import { Archive } from "../models/Archive.js";
import { config } from "../config.js";
import {
  ensureArchiveSubtitle,
  ensureArchiveSubtitleFromSource,
  isPermanentSubtitleFailureMessage,
  supportsSubtitle,
  syncArchiveSubtitleMirror
} from "./subtitles.js";

const queued = new Set<string>();
const active = new Set<string>();
const retryAt = new Map<string, number>();
let ticker: NodeJS.Timeout | null = null;
let tickRunning = false;

export function getSubtitleWorkerState() {
  return {
    enabled: config.subtitleWorkerEnabled,
    queued: queued.size,
    active: active.size,
    retryScheduled: retryAt.size,
    tickRunning
  };
}

function log(message: string) {
  console.log(`[subtitle-worker] ${new Date().toISOString()} ${message}`);
}

function nextRetryDelayMs(message: string) {
  if (message === "subtitle_provider_not_configured" || message === "subtitle_source_too_large_for_asr") {
    return Math.max(config.subtitleRetryMs, 30 * 60 * 1000);
  }
  return config.subtitleRetryMs;
}

function fileNeedsSubtitle(file: any) {
  if (file?.deletedAt) return false;
  if (file?.subtitle?.failedAt) return false;
  const fileName = file?.originalName || file?.name || "";
  if (!supportsSubtitle(fileName, file?.detectedKind)) return false;
  return !file?.subtitle?.updatedAt;
}

function fileNeedsMirror(file: any) {
  if (file?.deletedAt) return false;
  if (!file?.subtitle?.updatedAt) return false;
  return !!file?.subtitle?.mirrorPending && !!file?.subtitle?.mirrorProvider;
}

function archiveNeedsSubtitleWork(archive: any) {
  if (!archive?.files || archive.files.length === 0) return false;
  for (const file of archive.files) {
    if (fileNeedsSubtitle(file) || fileNeedsMirror(file)) {
      return true;
    }
  }
  return false;
}

export function queueArchiveSubtitles(archiveId: string) {
  if (!archiveId) return;
  const key = String(archiveId);
  const waitUntil = retryAt.get(key) || 0;
  if (waitUntil > Date.now()) return;
  queued.add(key);
}

async function refillQueue() {
  if (queued.size >= config.subtitleWorkerConcurrency * 4) {
    return;
  }
  const candidates = await Archive.find({
    status: { $in: ["queued", "processing", "ready"] },
    deletedAt: null,
    trashedAt: null,
    "files.0": { $exists: true }
  })
    .sort({ createdAt: 1 })
    .select("_id status files")
    .limit(config.subtitleBackfillScanLimit)
    .lean();

  for (const archive of candidates) {
    if (queued.size >= config.subtitleWorkerConcurrency * 6) {
      break;
    }
    if (!archiveNeedsSubtitleWork(archive)) {
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
  let mirrored = 0;
  let waitingForReady = false;

  for (let fileIndex = 0; fileIndex < archive.files.length; fileIndex += 1) {
    const file = archive.files[fileIndex];
    if (fileNeedsSubtitle(file)) {
      try {
        if (file.path) {
          await ensureArchiveSubtitleFromSource(archive, fileIndex);
        } else if (archive.status === "ready") {
          await ensureArchiveSubtitle(archive, fileIndex);
        } else {
          waitingForReady = true;
          continue;
        }
        generated += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isPermanentSubtitleFailureMessage(message)) {
          continue;
        }
        if (message === "source_missing" && archive.status !== "ready") {
          waitingForReady = true;
          continue;
        }
        log(`error ${archiveId} file=${fileIndex} ${message}`);
        retryAt.set(archiveId, Date.now() + nextRetryDelayMs(message));
        queued.add(archiveId);
        return;
      }
    }

    if (fileNeedsMirror(file)) {
      try {
        await syncArchiveSubtitleMirror(archive, fileIndex);
        mirrored += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`mirror error ${archiveId} file=${fileIndex} ${message}`);
        retryAt.set(archiveId, Date.now() + nextRetryDelayMs(message));
        queued.add(archiveId);
        return;
      }
    }
  }

  if (waitingForReady) {
    retryAt.set(archiveId, Date.now() + config.subtitleRetryMs);
    queued.add(archiveId);
  } else {
    retryAt.delete(archiveId);
  }

  if (generated > 0 || mirrored > 0) {
    log(`ready ${archiveId} generated=${generated} mirrored=${mirrored}`);
  }
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await refillQueue();
    while (active.size < config.subtitleWorkerConcurrency && queued.size > 0) {
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

export function startSubtitleWorker() {
  if (!config.subtitleWorkerEnabled) {
    log("disabled");
    return;
  }
  if (ticker) return;
  ticker = setInterval(() => {
    void tick();
  }, config.subtitleWorkerPollMs);
  void tick();
  log(`started concurrency=${config.subtitleWorkerConcurrency} poll=${config.subtitleWorkerPollMs}ms`);
}
