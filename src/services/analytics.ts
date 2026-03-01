type CounterBucket = {
  ts: number;
  uploadBytes: number;
  mirrorBytes: number;
  downloadBytes: number;
};

const WINDOW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;

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

export function noteUploadArchiveStarted() {
  totals.upload.archivesStarted += 1;
}

export function noteUploadArchiveDone(bytes: number, durationMs: number) {
  totals.upload.archivesDone += 1;
  totals.upload.bytes += Math.max(0, Math.trunc(bytes || 0));
  totals.upload.durationMs += Math.max(0, Math.trunc(durationMs || 0));
  getCurrentBucket().uploadBytes += Math.max(0, Math.trunc(bytes || 0));
}

export function noteUploadArchiveError() {
  totals.upload.archivesError += 1;
}

export function noteMirrorPartDone(provider: "discord" | "telegram", bytes: number, durationMs: number) {
  totals.mirror.partsDone += 1;
  totals.mirror.bytes += Math.max(0, Math.trunc(bytes || 0));
  totals.mirror.durationMs += Math.max(0, Math.trunc(durationMs || 0));
  totals.mirror.providers[provider].done += 1;
  totals.mirror.providers[provider].bytes += Math.max(0, Math.trunc(bytes || 0));
  getCurrentBucket().mirrorBytes += Math.max(0, Math.trunc(bytes || 0));
}

export function noteMirrorPartError(provider: "discord" | "telegram", isRateLimited = false) {
  totals.mirror.partsError += 1;
  totals.mirror.providers[provider].error += 1;
  if (isRateLimited) {
    totals.mirror.rateLimited += 1;
    totals.mirror.providers[provider].rateLimited += 1;
  }
}

export function noteDownloadStarted(bytes: number) {
  totals.download.started += 1;
  totals.download.bytesPlanned += Math.max(0, Math.trunc(bytes || 0));
}

export function noteDownloadDone(bytes: number) {
  totals.download.done += 1;
  getCurrentBucket().downloadBytes += Math.max(0, Math.trunc(bytes || 0));
}

export function noteDownloadError() {
  totals.download.error += 1;
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

