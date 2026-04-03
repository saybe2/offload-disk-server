import { AnalyticsTotals } from "../models/AnalyticsTotals.js";
import type { Response } from "express";

type CounterBucket = {
  ts: number;
  uploadBytes: number;
  mirrorBytes: number;
  downloadBytes: number;
  restoreBytes: number;
  previewBytes: number;
  thumbnailBytes: number;
  subtitleBytes: number;
  transcodeOutBytes: number;
  deleteBytes: number;
  smbReadBytes: number;
  smbWriteBytes: number;
};

const WINDOW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const FLUSH_INTERVAL_MS = 1500;
const TOTALS_DOC_ID = "global";

const totals = {
  upload: {
    archivesStarted: 0,
    archivesDone: 0,
    archivesError: 0,
    bytes: 0,
    durationMs: 0,
    providers: {
      discord: { done: 0, bytes: 0 },
      telegram: { done: 0, bytes: 0 }
    }
  },
  mirror: {
    partsDone: 0,
    partsError: 0,
    rateLimited: 0,
    bytes: 0,
    durationMs: 0,
    providers: {
      discord: { done: 0, error: 0, rateLimited: 0, bytes: 0 },
      telegram: { done: 0, error: 0, rateLimited: 0, bytes: 0 }
    }
  },
  download: { started: 0, done: 0, error: 0, bytesPlanned: 0 },
  restore: { jobsStarted: 0, jobsDone: 0, jobsError: 0, bytes: 0, durationMs: 0 },
  preview: { started: 0, done: 0, error: 0, bytes: 0 },
  thumbnail: { jobsStarted: 0, jobsDone: 0, jobsError: 0, bytes: 0, durationMs: 0 },
  subtitle: {
    jobsStarted: 0,
    jobsDone: 0,
    jobsError: 0,
    sourceBytes: 0,
    bytes: 0,
    durationMs: 0,
    providers: {
      asr: { attempted: 0, failed: 0 },
      local: { attempted: 0, failed: 0 }
    }
  },
  transcode: { jobsStarted: 0, jobsDone: 0, jobsError: 0, bytesIn: 0, bytesOut: 0, durationMs: 0, errorTypes: {} as Record<string, number> },
  deletion: { jobsStarted: 0, jobsDone: 0, jobsError: 0, partsDone: 0, bytesFreed: 0, durationMs: 0 },
  smb: { readOpens: 0, writeOpens: 0, readOps: 0, writeOps: 0, readBytes: 0, writeBytes: 0, errors: 0 }
};

const buckets: CounterBucket[] = [];
const pendingInc: Record<string, number> = {};
let flushTimer: NodeJS.Timeout | null = null;
let flushInProgress = false;
const DOWNLOAD_TRACKER_KEY = "__offloadDownloadTrackerAttached";

function now() {
  return Date.now();
}

function cleanupBuckets() {
  const threshold = now() - WINDOW_MS;
  while (buckets.length > 0 && buckets[0].ts < threshold) {
    buckets.shift();
  }
}

function getCurrentBucket() {
  cleanupBuckets();
  const ts = now();
  const last = buckets[buckets.length - 1];
  if (last && ts - last.ts < 1000) {
    return last;
  }
  const next: CounterBucket = {
    ts,
    uploadBytes: 0,
    mirrorBytes: 0,
    downloadBytes: 0,
    restoreBytes: 0,
    previewBytes: 0,
    thumbnailBytes: 0,
    subtitleBytes: 0,
    transcodeOutBytes: 0,
    deleteBytes: 0,
    smbReadBytes: 0,
    smbWriteBytes: 0
  };
  buckets.push(next);
  return next;
}

function sumRate<K extends keyof CounterBucket>(field: K, windowMs = RATE_WINDOW_MS) {
  cleanupBuckets();
  const threshold = now() - windowMs;
  let sum = 0;
  for (const item of buckets) {
    if (item.ts >= threshold) {
      sum += Number(item[field] || 0);
    }
  }
  return sum / (windowMs / 1000);
}

function avg(totalDuration: number, totalCount: number) {
  if (!totalCount) return 0;
  return Math.round(totalDuration / totalCount);
}

function addPendingInc(delta: Record<string, number>) {
  for (const [key, value] of Object.entries(delta)) {
    const amount = Math.trunc(value || 0);
    if (!amount) continue;
    pendingInc[key] = (pendingInc[key] || 0) + amount;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPendingIncrements();
    }, FLUSH_INTERVAL_MS);
  }
}

async function flushPendingIncrements() {
  if (flushInProgress) return;
  const keys = Object.keys(pendingInc);
  if (keys.length === 0) return;
  const incPayload: Record<string, number> = {};
  for (const key of keys) {
    incPayload[key] = pendingInc[key];
    delete pendingInc[key];
  }
  flushInProgress = true;
  try {
    await AnalyticsTotals.updateOne(
      { _id: TOTALS_DOC_ID },
      { $setOnInsert: { _id: TOTALS_DOC_ID }, $inc: incPayload },
      { upsert: true }
    );
  } catch (err) {
    for (const [key, value] of Object.entries(incPayload)) {
      pendingInc[key] = (pendingInc[key] || 0) + value;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushPendingIncrements();
      }, FLUSH_INTERVAL_MS);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[analytics] ${new Date().toISOString()} persist failed: ${message}`);
  } finally {
    flushInProgress = false;
  }
}

export async function initAnalyticsPersistence() {
  const doc = await AnalyticsTotals.findById(TOTALS_DOC_ID).lean();
  if (!doc) {
    await AnalyticsTotals.updateOne(
      { _id: TOTALS_DOC_ID },
      { $setOnInsert: { _id: TOTALS_DOC_ID } },
      { upsert: true }
    );
    return;
  }

  totals.upload.archivesStarted = Number(doc.upload?.archivesStarted || 0);
  totals.upload.archivesDone = Number(doc.upload?.archivesDone || 0);
  totals.upload.archivesError = Number(doc.upload?.archivesError || 0);
  totals.upload.bytes = Number(doc.upload?.bytes || 0);
  totals.upload.durationMs = Number(doc.upload?.durationMs || 0);
  totals.upload.providers.discord.done = Number((doc as any).upload?.providers?.discord?.done || 0);
  totals.upload.providers.discord.bytes = Number((doc as any).upload?.providers?.discord?.bytes || 0);
  totals.upload.providers.telegram.done = Number((doc as any).upload?.providers?.telegram?.done || 0);
  totals.upload.providers.telegram.bytes = Number((doc as any).upload?.providers?.telegram?.bytes || 0);

  totals.mirror.partsDone = Number(doc.mirror?.partsDone || 0);
  totals.mirror.partsError = Number(doc.mirror?.partsError || 0);
  totals.mirror.rateLimited = Number(doc.mirror?.rateLimited || 0);
  totals.mirror.bytes = Number(doc.mirror?.bytes || 0);
  totals.mirror.durationMs = Number(doc.mirror?.durationMs || 0);
  totals.mirror.providers.discord.done = Number(doc.mirror?.providers?.discord?.done || 0);
  totals.mirror.providers.discord.error = Number(doc.mirror?.providers?.discord?.error || 0);
  totals.mirror.providers.discord.rateLimited = Number(doc.mirror?.providers?.discord?.rateLimited || 0);
  totals.mirror.providers.discord.bytes = Number(doc.mirror?.providers?.discord?.bytes || 0);
  totals.mirror.providers.telegram.done = Number(doc.mirror?.providers?.telegram?.done || 0);
  totals.mirror.providers.telegram.error = Number(doc.mirror?.providers?.telegram?.error || 0);
  totals.mirror.providers.telegram.rateLimited = Number(doc.mirror?.providers?.telegram?.rateLimited || 0);
  totals.mirror.providers.telegram.bytes = Number(doc.mirror?.providers?.telegram?.bytes || 0);

  totals.download.started = Number(doc.download?.started || 0);
  totals.download.done = Number(doc.download?.done || 0);
  totals.download.error = Number(doc.download?.error || 0);
  totals.download.bytesPlanned = Number(doc.download?.bytesPlanned || 0);

  totals.restore.jobsStarted = Number((doc as any).restore?.jobsStarted || 0);
  totals.restore.jobsDone = Number((doc as any).restore?.jobsDone || 0);
  totals.restore.jobsError = Number((doc as any).restore?.jobsError || 0);
  totals.restore.bytes = Number((doc as any).restore?.bytes || 0);
  totals.restore.durationMs = Number((doc as any).restore?.durationMs || 0);

  totals.preview.started = Number((doc as any).preview?.started || 0);
  totals.preview.done = Number((doc as any).preview?.done || 0);
  totals.preview.error = Number((doc as any).preview?.error || 0);
  totals.preview.bytes = Number((doc as any).preview?.bytes || 0);

  totals.thumbnail.jobsStarted = Number((doc as any).thumbnail?.jobsStarted || 0);
  totals.thumbnail.jobsDone = Number((doc as any).thumbnail?.jobsDone || 0);
  totals.thumbnail.jobsError = Number((doc as any).thumbnail?.jobsError || 0);
  totals.thumbnail.bytes = Number((doc as any).thumbnail?.bytes || 0);
  totals.thumbnail.durationMs = Number((doc as any).thumbnail?.durationMs || 0);

  totals.subtitle.jobsStarted = Number((doc as any).subtitle?.jobsStarted || 0);
  totals.subtitle.jobsDone = Number((doc as any).subtitle?.jobsDone || 0);
  totals.subtitle.jobsError = Number((doc as any).subtitle?.jobsError || 0);
  totals.subtitle.sourceBytes = Number((doc as any).subtitle?.sourceBytes || 0);
  totals.subtitle.bytes = Number((doc as any).subtitle?.bytes || 0);
  totals.subtitle.durationMs = Number((doc as any).subtitle?.durationMs || 0);
  totals.subtitle.providers.asr.attempted = Number((doc as any).subtitle?.providers?.asr?.attempted || 0);
  totals.subtitle.providers.asr.failed = Number((doc as any).subtitle?.providers?.asr?.failed || 0);
  totals.subtitle.providers.local.attempted = Number((doc as any).subtitle?.providers?.local?.attempted || 0);
  totals.subtitle.providers.local.failed = Number((doc as any).subtitle?.providers?.local?.failed || 0);

  totals.transcode.jobsStarted = Number((doc as any).transcode?.jobsStarted || 0);
  totals.transcode.jobsDone = Number((doc as any).transcode?.jobsDone || 0);
  totals.transcode.jobsError = Number((doc as any).transcode?.jobsError || 0);
  totals.transcode.bytesIn = Number((doc as any).transcode?.bytesIn || 0);
  totals.transcode.bytesOut = Number((doc as any).transcode?.bytesOut || 0);
  totals.transcode.durationMs = Number((doc as any).transcode?.durationMs || 0);
  const rawTranscodeErrorTypes = (doc as any).transcode?.errorTypes;
  const transcodeErrorEntries =
    rawTranscodeErrorTypes instanceof Map
      ? [...rawTranscodeErrorTypes.entries()]
      : Object.entries(rawTranscodeErrorTypes || {});
  totals.transcode.errorTypes = Object.fromEntries(
    transcodeErrorEntries.map(([key, value]) => [String(key), Number(value || 0)])
  );

  totals.deletion.jobsStarted = Number((doc as any).deletion?.jobsStarted || 0);
  totals.deletion.jobsDone = Number((doc as any).deletion?.jobsDone || 0);
  totals.deletion.jobsError = Number((doc as any).deletion?.jobsError || 0);
  totals.deletion.partsDone = Number((doc as any).deletion?.partsDone || 0);
  totals.deletion.bytesFreed = Number((doc as any).deletion?.bytesFreed || 0);
  totals.deletion.durationMs = Number((doc as any).deletion?.durationMs || 0);

  totals.smb.readOpens = Number((doc as any).smb?.readOpens || 0);
  totals.smb.writeOpens = Number((doc as any).smb?.writeOpens || 0);
  totals.smb.readOps = Number((doc as any).smb?.readOps || 0);
  totals.smb.writeOps = Number((doc as any).smb?.writeOps || 0);
  totals.smb.readBytes = Number((doc as any).smb?.readBytes || 0);
  totals.smb.writeBytes = Number((doc as any).smb?.writeBytes || 0);
  totals.smb.errors = Number((doc as any).smb?.errors || 0);
}

export function noteUploadArchiveStarted() {
  totals.upload.archivesStarted += 1;
  addPendingInc({ "upload.archivesStarted": 1 });
}

export function noteUploadArchiveDone(bytes: number, durationMs: number) {
  totals.upload.archivesDone += 1;
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.upload.durationMs += duration;
  addPendingInc({
    "upload.archivesDone": 1,
    "upload.durationMs": duration
  });
}

export function noteUploadBytes(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  if (!amount) return;
  totals.upload.bytes += amount;
  getCurrentBucket().uploadBytes += amount;
  addPendingInc({ "upload.bytes": amount });
}

export function noteUploadProviderDone(provider: "discord" | "telegram", bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  totals.upload.providers[provider].done += 1;
  if (amount > 0) {
    totals.upload.providers[provider].bytes += amount;
  }
  addPendingInc({
    [`upload.providers.${provider}.done`]: 1,
    ...(amount > 0 ? { [`upload.providers.${provider}.bytes`]: amount } : {})
  });
}

export function noteUploadArchiveError() {
  totals.upload.archivesError += 1;
  addPendingInc({ "upload.archivesError": 1 });
}

export function noteMirrorPartDone(provider: "discord" | "telegram", bytes: number, durationMs: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.mirror.partsDone += 1;
  totals.mirror.bytes += amount;
  totals.mirror.durationMs += duration;
  totals.mirror.providers[provider].done += 1;
  totals.mirror.providers[provider].bytes += amount;
  getCurrentBucket().mirrorBytes += amount;
  addPendingInc({
    "mirror.partsDone": 1,
    "mirror.bytes": amount,
    "mirror.durationMs": duration,
    [`mirror.providers.${provider}.done`]: 1,
    [`mirror.providers.${provider}.bytes`]: amount
  });
}

export function noteMirrorPartError(provider: "discord" | "telegram", isRateLimited = false) {
  totals.mirror.partsError += 1;
  totals.mirror.providers[provider].error += 1;
  const delta: Record<string, number> = {
    "mirror.partsError": 1,
    [`mirror.providers.${provider}.error`]: 1
  };
  if (isRateLimited) {
    totals.mirror.rateLimited += 1;
    totals.mirror.providers[provider].rateLimited += 1;
    delta["mirror.rateLimited"] = 1;
    delta[`mirror.providers.${provider}.rateLimited`] = 1;
  }
  addPendingInc(delta);
}

export function noteDownloadStarted(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  totals.download.started += 1;
  totals.download.bytesPlanned += amount;
  addPendingInc({
    "download.started": 1,
    "download.bytesPlanned": amount
  });
}

export function noteDownloadDone(bytes: number) {
  totals.download.done += 1;
  addPendingInc({ "download.done": 1 });
}

export function noteDownloadError() {
  totals.download.error += 1;
  addPendingInc({ "download.error": 1 });
}

export function noteDownloadBytes(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  if (!amount) return;
  getCurrentBucket().downloadBytes += amount;
}

function chunkByteLength(chunk: unknown, encoding?: BufferEncoding) {
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, encoding);
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return 0;
}

export function attachDownloadByteTracker(res: Response) {
  const trackerTarget = res as Response & Record<string, unknown>;
  if (trackerTarget[DOWNLOAD_TRACKER_KEY]) return;
  trackerTarget[DOWNLOAD_TRACKER_KEY] = true;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  (res as any).write = ((chunk: any, encoding?: any, cb?: any) => {
    const bufferEncoding = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
    noteDownloadBytes(chunkByteLength(chunk, bufferEncoding));
    return originalWrite(chunk, encoding, cb);
  }) as typeof res.write;

  (res as any).end = ((chunk?: any, encoding?: any, cb?: any) => {
    if (chunk != null) {
      const bufferEncoding = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
      noteDownloadBytes(chunkByteLength(chunk, bufferEncoding));
    }
    return originalEnd(chunk as any, encoding as any, cb as any);
  }) as typeof res.end;
}

export function noteRestoreJobStarted() {
  totals.restore.jobsStarted += 1;
  addPendingInc({ "restore.jobsStarted": 1 });
}

export function noteRestoreBytes(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  if (!amount) return;
  totals.restore.bytes += amount;
  getCurrentBucket().restoreBytes += amount;
  addPendingInc({ "restore.bytes": amount });
}

export function noteRestoreJobDone(durationMs: number) {
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.restore.jobsDone += 1;
  totals.restore.durationMs += duration;
  addPendingInc({
    "restore.jobsDone": 1,
    "restore.durationMs": duration
  });
}

export function noteRestoreJobError() {
  totals.restore.jobsError += 1;
  addPendingInc({ "restore.jobsError": 1 });
}

export function notePreviewStarted(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  totals.preview.started += 1;
  addPendingInc({
    "preview.started": 1
  });
  if (amount > 0) {
    totals.preview.bytes += amount;
    getCurrentBucket().previewBytes += amount;
    addPendingInc({ "preview.bytes": amount });
  }
}

export function notePreviewDone() {
  totals.preview.done += 1;
  addPendingInc({ "preview.done": 1 });
}

export function notePreviewError() {
  totals.preview.error += 1;
  addPendingInc({ "preview.error": 1 });
}

export function noteThumbnailStarted() {
  totals.thumbnail.jobsStarted += 1;
  addPendingInc({ "thumbnail.jobsStarted": 1 });
}

export function noteThumbnailDone(bytes: number, durationMs: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.thumbnail.jobsDone += 1;
  totals.thumbnail.bytes += amount;
  totals.thumbnail.durationMs += duration;
  getCurrentBucket().thumbnailBytes += amount;
  addPendingInc({
    "thumbnail.jobsDone": 1,
    "thumbnail.bytes": amount,
    "thumbnail.durationMs": duration
  });
}

export function noteThumbnailError() {
  totals.thumbnail.jobsError += 1;
  addPendingInc({ "thumbnail.jobsError": 1 });
}

export function noteSubtitleStarted(sourceBytes: number) {
  const amount = Math.max(0, Math.trunc(sourceBytes || 0));
  totals.subtitle.jobsStarted += 1;
  totals.subtitle.sourceBytes += amount;
  addPendingInc({
    "subtitle.jobsStarted": 1,
    "subtitle.sourceBytes": amount
  });
}

export function noteSubtitleProviderAttempt(provider: "asr" | "local") {
  totals.subtitle.providers[provider].attempted += 1;
  addPendingInc({ [`subtitle.providers.${provider}.attempted`]: 1 });
}

export function noteSubtitleProviderFailure(provider: "asr" | "local") {
  totals.subtitle.providers[provider].failed += 1;
  addPendingInc({ [`subtitle.providers.${provider}.failed`]: 1 });
}

export function noteSubtitleDone(bytes: number, durationMs: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.subtitle.jobsDone += 1;
  totals.subtitle.bytes += amount;
  totals.subtitle.durationMs += duration;
  getCurrentBucket().subtitleBytes += amount;
  addPendingInc({
    "subtitle.jobsDone": 1,
    "subtitle.bytes": amount,
    "subtitle.durationMs": duration
  });
}

export function noteSubtitleError() {
  totals.subtitle.jobsError += 1;
  addPendingInc({ "subtitle.jobsError": 1 });
}

export function noteTranscodeStarted(bytesIn: number) {
  const amount = Math.max(0, Math.trunc(bytesIn || 0));
  totals.transcode.jobsStarted += 1;
  totals.transcode.bytesIn += amount;
  addPendingInc({
    "transcode.jobsStarted": 1,
    "transcode.bytesIn": amount
  });
}

export function noteTranscodeDone(bytesOut: number, durationMs: number) {
  const amount = Math.max(0, Math.trunc(bytesOut || 0));
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.transcode.jobsDone += 1;
  totals.transcode.bytesOut += amount;
  totals.transcode.durationMs += duration;
  getCurrentBucket().transcodeOutBytes += amount;
  addPendingInc({
    "transcode.jobsDone": 1,
    "transcode.bytesOut": amount,
    "transcode.durationMs": duration
  });
}

function normalizeTranscodeErrorType(reason?: string) {
  const msg = String(reason || "").toLowerCase();
  if (!msg) return "unknown";
  if (msg.includes("quota_exceeded")) return "quota_exceeded";
  if (msg.includes("source_missing")) return "source_missing";
  if (msg.includes("unsupported_media_content")) return "unsupported_media_content";
  if (msg.includes("already_compatible_codecs")) return "already_compatible_codecs";
  if (msg.includes("transcode_output_empty")) return "output_empty";
  if (msg.includes("ffmpeg_failed") && msg.includes("invalid data found when processing input")) return "ffmpeg_invalid_input";
  if (msg.includes("ffmpeg_failed") && msg.includes("does not contain any stream")) return "ffmpeg_no_stream";
  if (msg.includes("ffmpeg_missing")) return "ffmpeg_missing";
  if (msg.includes("user_not_found")) return "user_not_found";
  if (msg.includes("source_archive_id_missing")) return "source_archive_id_missing";
  if (msg.includes("source_user_id_missing")) return "source_user_id_missing";
  return "unknown";
}

export function noteTranscodeError(reason?: string) {
  const type = normalizeTranscodeErrorType(reason);
  totals.transcode.jobsError += 1;
  totals.transcode.errorTypes[type] = (totals.transcode.errorTypes[type] || 0) + 1;
  addPendingInc({
    "transcode.jobsError": 1,
    [`transcode.errorTypes.${type}`]: 1
  });
}

export function noteDeleteStarted() {
  totals.deletion.jobsStarted += 1;
  addPendingInc({ "deletion.jobsStarted": 1 });
}

export function noteDeletePartDone(bytesFreed: number) {
  const amount = Math.max(0, Math.trunc(bytesFreed || 0));
  totals.deletion.partsDone += 1;
  totals.deletion.bytesFreed += amount;
  getCurrentBucket().deleteBytes += amount;
  addPendingInc({
    "deletion.partsDone": 1,
    "deletion.bytesFreed": amount
  });
}

export function noteDeleteDone(durationMs: number) {
  const duration = Math.max(0, Math.trunc(durationMs || 0));
  totals.deletion.jobsDone += 1;
  totals.deletion.durationMs += duration;
  addPendingInc({
    "deletion.jobsDone": 1,
    "deletion.durationMs": duration
  });
}

export function noteDeleteError() {
  totals.deletion.jobsError += 1;
  addPendingInc({ "deletion.jobsError": 1 });
}

export function noteSmbReadOpen() {
  totals.smb.readOpens += 1;
  addPendingInc({ "smb.readOpens": 1 });
}

export function noteSmbWriteOpen() {
  totals.smb.writeOpens += 1;
  addPendingInc({ "smb.writeOpens": 1 });
}

export function noteSmbRead(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  totals.smb.readOps += 1;
  totals.smb.readBytes += amount;
  getCurrentBucket().smbReadBytes += amount;
  addPendingInc({
    "smb.readOps": 1,
    "smb.readBytes": amount
  });
}

export function noteSmbWrite(bytes: number) {
  const amount = Math.max(0, Math.trunc(bytes || 0));
  totals.smb.writeOps += 1;
  totals.smb.writeBytes += amount;
  getCurrentBucket().smbWriteBytes += amount;
  addPendingInc({
    "smb.writeOps": 1,
    "smb.writeBytes": amount
  });
}

export function noteSmbError() {
  totals.smb.errors += 1;
  addPendingInc({ "smb.errors": 1 });
}

export function getAnalyticsSnapshot() {
  return {
    upload: {
      ...totals.upload,
      avgArchiveMs: avg(totals.upload.durationMs, totals.upload.archivesDone),
      rateBps60s: Math.round(sumRate("uploadBytes"))
    },
    mirror: {
      ...totals.mirror,
      avgPartMs: avg(totals.mirror.durationMs, totals.mirror.partsDone),
      rateBps60s: Math.round(sumRate("mirrorBytes"))
    },
    download: {
      ...totals.download,
      rateBps60s: Math.round(sumRate("downloadBytes"))
    },
    restore: {
      ...totals.restore,
      avgJobMs: avg(totals.restore.durationMs, totals.restore.jobsDone),
      rateBps60s: Math.round(sumRate("restoreBytes"))
    },
    preview: {
      ...totals.preview,
      rateBps60s: Math.round(sumRate("previewBytes"))
    },
    thumbnail: {
      ...totals.thumbnail,
      avgJobMs: avg(totals.thumbnail.durationMs, totals.thumbnail.jobsDone),
      rateBps60s: Math.round(sumRate("thumbnailBytes"))
    },
    subtitle: {
      ...totals.subtitle,
      avgJobMs: avg(totals.subtitle.durationMs, totals.subtitle.jobsDone),
      rateBps60s: Math.round(sumRate("subtitleBytes"))
    },
    transcode: {
      ...totals.transcode,
      errorTypes: { ...totals.transcode.errorTypes },
      avgJobMs: avg(totals.transcode.durationMs, totals.transcode.jobsDone),
      rateBps60s: Math.round(sumRate("transcodeOutBytes"))
    },
    deletion: {
      ...totals.deletion,
      avgJobMs: avg(totals.deletion.durationMs, totals.deletion.jobsDone),
      rateBps60s: Math.round(sumRate("deleteBytes"))
    },
    smb: {
      ...totals.smb,
      readRateBps60s: Math.round(sumRate("smbReadBytes")),
      writeRateBps60s: Math.round(sumRate("smbWriteBytes"))
    },
    generatedAt: new Date().toISOString()
  };
}
