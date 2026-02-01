import dotenv from "dotenv";
import path from "path";

dotenv.config();

const toNumber = (value: string | undefined, fallback: number) => {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: toNumber(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGODB_DB || "cloud_storage",
  sessionSecret: process.env.SESSION_SECRET || "change-me",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin",
  masterKey: process.env.MASTER_KEY || "CHANGE_ME",
  cacheDir: path.resolve(process.env.CACHE_DIR || "./data/cache"),
  cacheDeleteAfterUpload: (process.env.CACHE_DELETE_AFTER_UPLOAD || "true") === "true",
  chunkSizeMiB: toNumber(process.env.CHUNK_SIZE_MIB, 9.8),
  webhookMaxMiB: toNumber(process.env.DISCORD_WEBHOOK_MAX_MIB, 9.8),
  bundleMaxMiB: toNumber(process.env.BUNDLE_MAX_MIB, 32),
  bundleSingleFileMiB: toNumber(process.env.BUNDLE_SINGLE_FILE_MIB, 8),
  diskSoftLimitGb: toNumber(process.env.DISK_SOFT_LIMIT_GB, 15),
  diskHardLimitGb: toNumber(process.env.DISK_HARD_LIMIT_GB, 5),
  workerPollMs: toNumber(process.env.WORKER_POLL_MS, 2000),
  workerConcurrency: toNumber(process.env.WORKER_CONCURRENCY, 1),
  processingStaleMinutes: toNumber(process.env.PROCESSING_STALE_MIN, 30),
  uploadPartsConcurrency: toNumber(process.env.UPLOAD_PARTS_CONCURRENCY, 2),
  uploadRetryMax: toNumber(process.env.UPLOAD_RETRY_MAX, 5),
  uploadRetryBaseMs: toNumber(process.env.UPLOAD_RETRY_BASE_MS, 1500),
  uploadRetryMaxMs: toNumber(process.env.UPLOAD_RETRY_MAX_MS, 15000)
};

const safeChunkMiB = Math.min(config.chunkSizeMiB, config.webhookMaxMiB);

export const computed = {
  chunkSizeBytes: Math.floor(safeChunkMiB * 1024 * 1024),
  webhookMaxBytes: Math.floor(config.webhookMaxMiB * 1024 * 1024),
  bundleMaxBytes: Math.floor(config.bundleMaxMiB * 1024 * 1024),
  bundleSingleFileBytes: Math.floor(config.bundleSingleFileMiB * 1024 * 1024)
};
