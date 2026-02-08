import fs from "fs";
import path from "path";
import { Archive } from "../models/Archive.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const HOUR_MS = 60 * 60 * 1000;

async function removePath(target: string) {
  await fs.promises.rm(target, { recursive: true, force: true });
}

async function cleanupUploadsTmp(cutoffMs: number) {
  const tmpDir = path.join(config.cacheDir, "uploads_tmp");
  let removed = 0;
  const entries = await fs.promises.readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(tmpDir, entry.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || stat.mtimeMs > cutoffMs) continue;
    await removePath(full).catch(() => undefined);
    removed += 1;
  }
  if (removed > 0) {
    log("cleanup", `uploads_tmp removed=${removed}`);
  }
}

function buildKeepSets(archives: Array<{ _id: any; status: string; stagingDir?: string }>) {
  const keepUploads = new Set<string>();
  const keepWork = new Set<string>();
  const keepReady = !config.cacheDeleteAfterUpload;
  for (const archive of archives) {
    const status = archive.status;
    const keep = status === "processing" || status === "queued" || (status === "ready" && keepReady);
    if (!keep) continue;
    if (archive.stagingDir) {
      keepUploads.add(path.resolve(archive.stagingDir));
    }
    const id = String(archive._id);
    keepWork.add(path.join(config.cacheDir, "work", id));
    keepWork.add(path.join(config.cacheDir, "work", `stream_${id}`));
  }
  return { keepUploads, keepWork };
}

async function cleanupUploadsDir(cutoffMs: number, keepUploads: Set<string>) {
  const baseDir = path.join(config.cacheDir, "uploads");
  const dateDirs = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const dateDir of dateDirs) {
    if (!dateDir.isDirectory()) continue;
    const datePath = path.join(baseDir, dateDir.name);
    const subDirs = await fs.promises.readdir(datePath, { withFileTypes: true }).catch(() => []);
    for (const subDir of subDirs) {
      if (!subDir.isDirectory()) continue;
      const subPath = path.join(datePath, subDir.name);
      if (keepUploads.has(path.resolve(subPath))) continue;
      const stat = await fs.promises.stat(subPath).catch(() => null);
      if (!stat || stat.mtimeMs > cutoffMs) continue;
      await removePath(subPath).catch(() => undefined);
      removed += 1;
    }
    const remaining = await fs.promises.readdir(datePath).catch(() => []);
    if (remaining.length === 0) {
      const stat = await fs.promises.stat(datePath).catch(() => null);
      if (stat && stat.mtimeMs <= cutoffMs) {
        await removePath(datePath).catch(() => undefined);
      }
    }
  }
  if (removed > 0) {
    log("cleanup", `uploads removed=${removed}`);
  }
}

async function cleanupWorkDir(cutoffMs: number, keepWork: Set<string>) {
  const baseDir = path.join(config.cacheDir, "work");
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(baseDir, entry.name);
    if (keepWork.has(path.resolve(full))) continue;
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || stat.mtimeMs > cutoffMs) continue;
    await removePath(full).catch(() => undefined);
    removed += 1;
  }
  if (removed > 0) {
    log("cleanup", `work removed=${removed}`);
  }
}

export async function cleanupCacheOnce() {
  const ttlMs = config.uploadTmpTtlHours * HOUR_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const cutoffMs = Date.now() - ttlMs;
  try {
    const archives = await Archive.find({ deletedAt: null })
      .select("_id status stagingDir")
      .lean();
    const { keepUploads, keepWork } = buildKeepSets(archives);
    await cleanupUploadsTmp(cutoffMs);
    await cleanupUploadsDir(cutoffMs, keepUploads);
    await cleanupWorkDir(cutoffMs, keepWork);
  } catch (err) {
    log("cleanup", `error ${(err as Error).message}`);
  }
}

export function startCacheCleanup() {
  const intervalMs = Math.max(1, config.uploadTmpCleanupMinutes) * 60 * 1000;
  cleanupCacheOnce().catch(() => undefined);
  setInterval(() => cleanupCacheOnce().catch(() => undefined), intervalMs);
}
