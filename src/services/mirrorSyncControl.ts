import { config } from "../config.js";
import { Archive } from "../models/Archive.js";
import { Setting } from "../models/Setting.js";

const KEY_PAUSED = "mirror_sync_paused";
const KEY_AUTO_TUNE = "mirror_sync_auto_tune";
const KEY_CONCURRENCY = "mirror_sync_concurrency";

let initialized = false;
let paused = false;
let autoTune = config.mirrorSyncAutoTune;
let concurrency = Math.max(config.mirrorSyncConcurrencyMin, Math.min(config.mirrorSyncConcurrencyMax, config.mirrorSyncConcurrency));
let successStreak = 0;
let lastDownshiftAt = 0;
let lastUpshiftAt = 0;

const MIN_CONCURRENCY = Math.max(1, config.mirrorSyncConcurrencyMin);
const MAX_CONCURRENCY = Math.max(MIN_CONCURRENCY, config.mirrorSyncConcurrencyMax);

function toBool(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
}

function toInt(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampConcurrency(value: number) {
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, value));
}

async function upsertSetting(key: string, value: string) {
  await Setting.updateOne({ key }, { $set: { value } }, { upsert: true });
}

export async function initMirrorSyncControl() {
  if (initialized) return;
  const settings = await Setting.find({ key: { $in: [KEY_PAUSED, KEY_AUTO_TUNE, KEY_CONCURRENCY] } }).lean();
  const map = new Map(settings.map((item) => [item.key, item.value]));
  paused = toBool(map.get(KEY_PAUSED), false);
  autoTune = toBool(map.get(KEY_AUTO_TUNE), config.mirrorSyncAutoTune);
  concurrency = clampConcurrency(toInt(map.get(KEY_CONCURRENCY), config.mirrorSyncConcurrency));
  initialized = true;
}

export function getMirrorSyncState() {
  return {
    paused,
    autoTune,
    concurrency,
    minConcurrency: MIN_CONCURRENCY,
    maxConcurrency: MAX_CONCURRENCY
  };
}

export async function setMirrorSyncPaused(next: boolean) {
  paused = !!next;
  await upsertSetting(KEY_PAUSED, paused ? "1" : "0");
  return getMirrorSyncState();
}

export async function setMirrorSyncAutoTune(next: boolean) {
  autoTune = !!next;
  successStreak = 0;
  await upsertSetting(KEY_AUTO_TUNE, autoTune ? "1" : "0");
  return getMirrorSyncState();
}

export async function setMirrorSyncConcurrency(next: number) {
  concurrency = clampConcurrency(next);
  successStreak = 0;
  await upsertSetting(KEY_CONCURRENCY, String(concurrency));
  return getMirrorSyncState();
}

export async function noteMirrorSyncSuccess() {
  if (!autoTune) return getMirrorSyncState();
  successStreak += 1;
  if (successStreak < 20) return getMirrorSyncState();
  const now = Date.now();
  if (now - lastUpshiftAt < 15000) return getMirrorSyncState();
  successStreak = 0;
  if (concurrency >= MAX_CONCURRENCY) return getMirrorSyncState();
  concurrency = clampConcurrency(concurrency + 1);
  lastUpshiftAt = now;
  await upsertSetting(KEY_CONCURRENCY, String(concurrency));
  return getMirrorSyncState();
}

export async function noteMirrorSyncRateLimited() {
  if (!autoTune) return getMirrorSyncState();
  successStreak = 0;
  const now = Date.now();
  if (now - lastDownshiftAt < 5000) return getMirrorSyncState();
  if (concurrency <= MIN_CONCURRENCY) return getMirrorSyncState();
  concurrency = clampConcurrency(concurrency - 1);
  lastDownshiftAt = now;
  await upsertSetting(KEY_CONCURRENCY, String(concurrency));
  return getMirrorSyncState();
}

export async function retryMirrorSyncFailures() {
  const now = new Date();
  const result = await Archive.collection.updateMany(
    {
      status: "ready",
      deletedAt: null,
      trashedAt: null,
      parts: {
        $elemMatch: {
          mirrorProvider: { $in: ["discord", "telegram"] },
          mirrorPending: { $ne: true },
          mirrorError: { $nin: ["", null] },
          $or: [{ mirrorUrl: "" }, { mirrorUrl: { $exists: false } }, { mirrorMessageId: "" }, { mirrorMessageId: { $exists: false } }]
        }
      }
    },
    {
      $set: {
        "parts.$[p].mirrorPending": true,
        "parts.$[p].mirrorError": "",
        updatedAt: now
      }
    },
    {
      arrayFilters: [
        {
          "p.mirrorProvider": { $in: ["discord", "telegram"] },
          "p.mirrorPending": { $ne: true },
          "p.mirrorError": { $nin: ["", null] },
          $or: [
            { "p.mirrorUrl": "" },
            { "p.mirrorUrl": { $exists: false } },
            { "p.mirrorMessageId": "" },
            { "p.mirrorMessageId": { $exists: false } }
          ]
        }
      ]
    }
  );
  return {
    matched: result.matchedCount || 0,
    modified: result.modifiedCount || 0
  };
}
