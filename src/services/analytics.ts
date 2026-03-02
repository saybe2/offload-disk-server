import { AnalyticsTotals } from "../models/AnalyticsTotals.js";

type CounterBucket = {
  ts: number;
  uploadBytes: number;
  mirrorBytes: number;
  downloadBytes: number;
};

const WINDOW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const FLUSH_INTERVAL_MS = 1500;
const TOTALS_DOC_ID = "global";

const totals = {
  upload: { archivesStarted: 0, archivesDone: 0, archivesError: 0, bytes: 0, durationMs: 0 },
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
  download: { started: 0, done: 0, error: 0, bytesPlanned: 0 }
};

const buckets: CounterBucket[] = [];
const pendingInc: Record<string, number> = {};
let flushTimer: NodeJS.Timeout | null = null;
let flushInProgress = false;

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
  const next: CounterBucket = { ts, uploadBytes: 0, mirrorBytes: 0, downloadBytes: 0 };
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
  const amount = Math.max(0, Math.trunc(bytes || 0));
  totals.download.done += 1;
  getCurrentBucket().downloadBytes += amount;
  addPendingInc({ "download.done": 1 });
}

export function noteDownloadError() {
  totals.download.error += 1;
  addPendingInc({ "download.error": 1 });
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
    generatedAt: new Date().toISOString()
  };
}
