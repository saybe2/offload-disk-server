import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { spawn } from "child_process";
import mime from "mime-types";
import mongoose from "mongoose";
import { Archive, type ArchiveDoc } from "../models/Archive.js";
import { User } from "../models/User.js";
import { config, computed } from "../config.js";
import { sanitizeFilename } from "../utils/names.js";
import { detectStoredFileType } from "./fileType.js";
import { restoreArchiveFileToFile, restoreArchiveToFile } from "./restore.js";
import { log } from "../logger.js";

const require = createRequire(import.meta.url);
const ffmpegStaticPath = require("ffmpeg-static") as string | null;
const ffmpegBin = ffmpegStaticPath || "ffmpeg";

const videoExt = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".webm",
  ".m4v",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".m2ts",
  ".3gp",
  ".ogv",
  ".vob",
  ".ts"
]);
const audioExt = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".m4a",
  ".ogg",
  ".oga",
  ".opus",
  ".wma",
  ".aiff"
]);

const inFlight = new Map<string, Promise<string | null>>();

function extOf(fileName: string) {
  const lower = String(fileName || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function toErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err || "");
}

function resolveMediaKind(fileName: string, detectedKind?: string) {
  if (detectedKind === "video") return "video" as const;
  if (detectedKind === "audio") return "audio" as const;
  const ext = extOf(fileName);
  if (videoExt.has(ext)) return "video" as const;
  if (audioExt.has(ext)) return "audio" as const;
  return null;
}

function isSkippedByConfig(fileName: string, mediaKind: "video" | "audio") {
  const ext = extOf(fileName);
  if (mediaKind === "video") {
    return config.transcodeSkipVideoExt.includes(ext);
  }
  return config.transcodeSkipAudioExt.includes(ext);
}

export function supportsTranscodeCopy(fileName: string, detectedKind?: string) {
  return !!resolveMediaKind(fileName, detectedKind);
}

export function needsTranscodeCopy(fileName: string, detectedKind?: string) {
  const mediaKind = resolveMediaKind(fileName, detectedKind);
  if (!mediaKind) return false;
  return !isSkippedByConfig(fileName, mediaKind);
}

export function archiveNeedsTranscodeCopies(archive: any) {
  const files = Array.isArray(archive?.files) ? archive.files : [];
  return files.some((file: any) => {
    if (!file || file.deletedAt) return false;
    const fileName = file.originalName || file.name || "";
    return needsTranscodeCopy(fileName, file.detectedKind);
  });
}

function transcodeWorkDir(archiveId: string, fileIndex: number) {
  return path.join(
    config.cacheDir,
    "transcode_work",
    `${archiveId}_${fileIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
}

function getOutputName(sourceName: string, mediaKind: "video" | "audio") {
  const cleanBase = sanitizeFilename(path.basename(sourceName, path.extname(sourceName) || undefined) || "media");
  return mediaKind === "video" ? `${cleanBase}.mp4` : `${cleanBase}.m4a`;
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", (err) => {
      reject(new Error(`ffmpeg_spawn_failed:${toErrorMessage(err)}`));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg_failed:${code}:${stderr.slice(-500)}`));
    });
  });
}

async function transcodeToOutput(inputPath: string, outputPath: string, mediaKind: "video" | "audio") {
  if (!ffmpegBin) {
    throw new Error("ffmpeg_missing");
  }
  if (mediaKind === "video") {
    const args = [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      config.transcodeVideoPreset,
      "-crf",
      String(config.transcodeVideoCrf),
      "-c:a",
      "aac",
      "-b:a",
      `${config.transcodeAudioBitrateKbps}k`,
      "-movflags",
      "+faststart",
      outputPath
    ];
    await runFfmpeg(args);
    return;
  }
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    `${config.transcodeAudioBitrateKbps}k`,
    outputPath
  ];
  await runFfmpeg(args);
}

async function updateSourceTranscodeState(archiveId: string, fileIndex: number, patch: Record<string, unknown>) {
  const setPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    setPatch[`files.${fileIndex}.transcode.${key}`] = value;
  }
  setPatch[`files.${fileIndex}.transcode.updatedAt`] = new Date();
  await Archive.updateOne({ _id: archiveId }, { $set: setPatch });
}

async function createTranscodedArchive(
  sourceArchive: ArchiveDoc | any,
  fileIndex: number,
  sourcePath: string,
  sourceName: string,
  detectedKind?: string
) {
  const mediaKind = resolveMediaKind(sourceName, detectedKind);
  if (!mediaKind) {
    await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
      status: "skipped",
      error: "unsupported_media_type",
      archiveId: "",
      size: 0,
      contentType: ""
    });
    return null;
  }
  if (isSkippedByConfig(sourceName, mediaKind)) {
    await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
      status: "skipped",
      error: "already_compatible",
      archiveId: "",
      size: 0,
      contentType: ""
    });
    return null;
  }

  const existingArchiveId = String(sourceArchive.files?.[fileIndex]?.transcode?.archiveId || "");
  if (existingArchiveId) {
    const existing = await Archive.findById(existingArchiveId).select("_id status deletedAt").lean();
    if (existing && !existing.deletedAt && ["queued", "processing", "ready"].includes(String(existing.status || ""))) {
      return existing._id.toString();
    }
  }

  const workDir = transcodeWorkDir(sourceArchive.id, fileIndex);
  await fs.promises.mkdir(workDir, { recursive: true });
  const outputName = getOutputName(sourceName, mediaKind);
  const outputPath = path.join(workDir, `0_${sanitizeFilename(outputName)}`);
  const contentType = (mime.lookup(outputName) as string) || (mediaKind === "video" ? "video/mp4" : "audio/mp4");

  log("transcode", `start source=${sourceArchive.id} file=${fileIndex} name=${sourceName}`);
  await transcodeToOutput(sourcePath, outputPath, mediaKind);
  const stat = await fs.promises.stat(outputPath);
  if (!stat.size) {
    throw new Error("transcode_output_empty");
  }

  const user = await User.findById(sourceArchive.userId);
  if (!user) {
    throw new Error("user_not_found");
  }
  if (user.quotaBytes > 0 && user.usedBytes + stat.size > user.quotaBytes) {
    await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
      status: "error",
      error: "quota_exceeded",
      archiveId: "",
      size: 0,
      contentType
    });
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }

  const detectedType = await detectStoredFileType(outputPath, outputName);
  const archive = await Archive.create({
    userId: sourceArchive.userId,
    name: sanitizeFilename(outputName),
    displayName: `${sourceName} (converted)`,
    downloadName: outputName,
    archiveKind: "transcoded",
    sourceArchiveId: sourceArchive._id,
    sourceFileIndex: fileIndex,
    isBundle: false,
    encryptionVersion: 2,
    folderId: null,
    priority: 1,
    priorityOverride: true,
    status: "queued",
    contentModifiedAt: new Date(),
    originalSize: stat.size,
    encryptedSize: 0,
    uploadedBytes: 0,
    uploadedParts: 0,
    totalParts: 0,
    chunkSizeBytes: computed.chunkSizeBytes,
    stagingDir: workDir,
    files: [
      {
        path: outputPath,
        name: path.basename(outputPath),
        originalName: outputName,
        size: stat.size,
        contentModifiedAt: new Date(),
        detectedKind: detectedType.kind,
        detectedTypeLabel: detectedType.label
      }
    ],
    parts: []
  });

  await User.updateOne({ _id: sourceArchive.userId }, { $inc: { usedBytes: stat.size } });
  await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
    archiveId: archive.id,
    status: "queued",
    size: stat.size,
    contentType,
    error: ""
  });
  log("transcode", `queued source=${sourceArchive.id} file=${fileIndex} archive=${archive.id} size=${stat.size}`);
  return archive.id;
}

async function ensureSourceUserEnabled(userId: string) {
  const user = await User.findById(userId).select("transcodeCopiesEnabled").lean();
  return !!user?.transcodeCopiesEnabled;
}

export async function ensureArchiveFileTranscodeFromSource(
  sourceArchive: ArchiveDoc | any,
  fileIndex: number
) {
  const key = `${sourceArchive.id}:${fileIndex}`;
  if (inFlight.has(key)) {
    return inFlight.get(key)!;
  }
  const run = (async () => {
    const file = sourceArchive.files?.[fileIndex];
    if (!file || file?.deletedAt) return null;
    if (String(sourceArchive.archiveKind || "primary") === "transcoded") return null;
    const enabled = await ensureSourceUserEnabled(sourceArchive.userId.toString());
    if (!enabled) {
      await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
        status: "skipped",
        error: "disabled_by_user",
        archiveId: "",
        size: 0,
        contentType: ""
      });
      return null;
    }

    const sourceName = file.originalName || file.name || `file_${fileIndex}`;
    if (!supportsTranscodeCopy(sourceName, file.detectedKind)) {
      await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
        status: "skipped",
        error: "unsupported_media_type",
        archiveId: "",
        size: 0,
        contentType: ""
      });
      return null;
    }

    const sourcePath = String(file.path || "");
    if (!sourcePath || !(await fs.promises.stat(sourcePath).catch(() => null))) {
      throw new Error("source_missing");
    }

    await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
      status: "processing",
      error: ""
    });
    return await createTranscodedArchive(sourceArchive, fileIndex, sourcePath, sourceName, file.detectedKind);
  })()
    .catch(async (err) => {
      const message = toErrorMessage(err);
      await updateSourceTranscodeState(sourceArchive.id, fileIndex, {
        status: "error",
        error: message.slice(0, 500)
      });
      throw err;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, run);
  return run;
}

export async function ensureArchiveFileTranscode(sourceArchive: ArchiveDoc | any, fileIndex: number) {
  const file = sourceArchive.files?.[fileIndex];
  if (!file || file.deletedAt) return null;
  const sourceName = file.originalName || file.name || `file_${fileIndex}`;
  const sourcePath = String(file.path || "");
  const sourceExists = sourcePath ? await fs.promises.stat(sourcePath).catch(() => null) : null;
  if (sourceExists) {
    return ensureArchiveFileTranscodeFromSource(sourceArchive, fileIndex);
  }

  const workDir = transcodeWorkDir(sourceArchive.id, fileIndex);
  await fs.promises.mkdir(workDir, { recursive: true });
  const restoredPath = path.join(workDir, `${fileIndex}_${sanitizeFilename(sourceName)}`);
  try {
    if (sourceArchive.isBundle) {
      await restoreArchiveFileToFile(sourceArchive, fileIndex, restoredPath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(sourceArchive, restoredPath, config.cacheDir, config.masterKey);
    }
    const restoredArchive = {
      ...sourceArchive,
      files: [...(sourceArchive.files || [])]
    };
    restoredArchive.files[fileIndex] = { ...restoredArchive.files[fileIndex], path: restoredPath };
    return await ensureArchiveFileTranscodeFromSource(restoredArchive, fileIndex);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function findReadyTranscodeArchive(sourceArchive: ArchiveDoc | any, fileIndex: number) {
  const refId = String(sourceArchive.files?.[fileIndex]?.transcode?.archiveId || "");
  if (!refId) return null;
  const transArchive = await Archive.findById(refId);
  if (!transArchive) return null;
  if (transArchive.deletedAt || transArchive.trashedAt) return null;
  if (String(transArchive.archiveKind || "") !== "transcoded") return null;
  if (transArchive.status !== "ready") return null;
  return transArchive;
}

export async function syncSourceTranscodeStateFromArchive(transcodeArchive: ArchiveDoc | any) {
  if (String(transcodeArchive.archiveKind || "") !== "transcoded") return;
  const sourceArchiveId = transcodeArchive.sourceArchiveId ? String(transcodeArchive.sourceArchiveId) : "";
  const sourceFileIndex = Number(transcodeArchive.sourceFileIndex);
  if (!sourceArchiveId || !Number.isInteger(sourceFileIndex) || sourceFileIndex < 0) return;
  const file = transcodeArchive.files?.[0];
  const contentType = (mime.lookup(file?.originalName || file?.name || transcodeArchive.downloadName || "") as string) || "";
  const nextStatus =
    transcodeArchive.status === "ready"
      ? "ready"
      : transcodeArchive.status === "error"
        ? "error"
        : "processing";
  await updateSourceTranscodeState(sourceArchiveId, sourceFileIndex, {
    archiveId: transcodeArchive.id,
    status: nextStatus,
    size: Number(transcodeArchive.originalSize || file?.size || 0),
    contentType,
    error: String(transcodeArchive.error || "")
  });
}

export async function listLinkedTranscodeArchiveIds(sourceArchive: ArchiveDoc | any, onlyActive = true) {
  const ids = new Set<string>();
  for (const file of sourceArchive.files || []) {
    const ref = String(file?.transcode?.archiveId || "");
    if (ref) ids.add(ref);
  }
  const sourceId = sourceArchive._id || sourceArchive.id;
  if (sourceId) {
    const query: Record<string, unknown> = {
      sourceArchiveId: sourceId,
      archiveKind: "transcoded"
    };
    if (onlyActive) {
      query.deletedAt = null;
    }
    const linked = await Archive.find(query).select("_id").lean();
    for (const doc of linked) {
      ids.add(String(doc._id));
    }
  }
  return [...ids];
}

export async function getUserTranscodeUsageBytes(userId: string) {
  const objectId = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : null;
  if (!objectId) return 0;
  const rows = await Archive.aggregate([
    {
      $match: {
        userId: objectId,
        archiveKind: "transcoded",
        deletedAt: null
      }
    },
    { $group: { _id: null, total: { $sum: "$originalSize" } } }
  ]);
  return Number(rows?.[0]?.total || 0);
}
