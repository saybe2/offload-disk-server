import { Archive } from "../models/Archive.js";

const PREVIEW_DEDUP_MS = 20 * 1000;
const PREVIEW_PRUNE_MS = 60 * 1000;
const PREVIEW_DEDUP_MAX_KEYS = 20000;
const previewSeen = new Map<string, number>();
let previewSeenLastPrune = 0;

function shouldCountPreview(key: string) {
  const now = Date.now();
  const last = previewSeen.get(key) || 0;
  if (last > 0 && now - last < PREVIEW_DEDUP_MS) {
    return false;
  }
  previewSeen.set(key, now);
  if (now - previewSeenLastPrune > PREVIEW_PRUNE_MS || previewSeen.size > PREVIEW_DEDUP_MAX_KEYS) {
    previewSeenLastPrune = now;
    const cutoff = now - PREVIEW_DEDUP_MS;
    for (const [dedupKey, ts] of previewSeen.entries()) {
      if (ts < cutoff) {
        previewSeen.delete(dedupKey);
      }
    }
  }
  return true;
}

export async function bumpPreviewCount(archiveId: string, fileIndex: number, viewerKey = "") {
  if (!archiveId || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return;
  }
  const dedupKey = `${viewerKey || "anon"}:${archiveId}:${fileIndex}`;
  if (!shouldCountPreview(dedupKey)) {
    return;
  }
  await Archive.updateOne({ _id: archiveId }, { $inc: { [`files.${fileIndex}.previewCount`]: 1 } });
}
