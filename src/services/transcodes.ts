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
import { noteTranscodeDone, noteTranscodeError, noteTranscodeStarted } from "./analytics.js";

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

function asId(value: any) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return String(value);
}

function sourceArchiveId(archive: any) {
  return asId(archive?.id || archive?._id);
}

function sourceUserId(archive: any) {
  return asId(archive?.userId);
}

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
  if (detectedKind && detectedKind !== "video" && detectedKind !== "audio") {
    return null;
  }
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

function getOutputName(sourceName: string, mediaKind: "video" | "audio", audioTrack = 0) {
  const cleanBase = sanitizeFilename(path.basename(sourceName, path.extname(sourceName) || undefined) || "media");
  if (mediaKind === "video") {
    if (audioTrack > 0) {
      return `${cleanBase}.track${audioTrack + 1}.mp4`;
    }
    return `${cleanBase}.mp4`;
  }
  if (audioTrack > 0) {
    return `${cleanBase}.track${audioTrack + 1}.m4a`;
  }
  return `${cleanBase}.m4a`;
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

type ProbedStream = {
  codec_type?: string;
  codec_name?: string;
};

async function probeMediaStreams(inputPath: string) {
  return new Promise<ProbedStream[]>((resolve, reject) => {
    const args = ["-v", "error", "-show_streams", "-of", "json", inputPath];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", (err) => {
      reject(new Error(`ffprobe_spawn_failed:${toErrorMessage(err)}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe_failed:${code}:${stderr.slice(-500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}") as { streams?: ProbedStream[] };
        resolve(Array.isArray(parsed.streams) ? parsed.streams : []);
      } catch (err) {
        reject(new Error(`ffprobe_parse_failed:${toErrorMessage(err)}`));
      }
    });
  });
}

async function evaluateCompatibility(inputPath: string, mediaKind: "video" | "audio") {
  let streams: ProbedStream[] = [];
  try {
    streams = await probeMediaStreams(inputPath);
  } catch (err) {
    const message = toErrorMessage(err);
    if (/invalid data found when processing input/i.test(message)) {
      return { unsupported: true, compatible: false, reason: "unsupported_media_content" };
    }
    return { unsupported: false, compatible: false, reason: "" };
  }

  const videoCodecs = streams
    .filter((stream) => String(stream.codec_type || "").toLowerCase() === "video")
    .map((stream) => String(stream.codec_name || "").toLowerCase())
    .filter(Boolean);
  const audioCodecs = streams
    .filter((stream) => String(stream.codec_type || "").toLowerCase() === "audio")
    .map((stream) => String(stream.codec_name || "").toLowerCase())
    .filter(Boolean);

  if (mediaKind === "video") {
    if (videoCodecs.length === 0) {
      return { unsupported: true, compatible: false, reason: "unsupported_media_content" };
    }
    const videoOk = videoCodecs.every((codec) => config.transcodeCompatibleVideoCodecs.includes(codec));
    const audioOk = audioCodecs.every((codec) => config.transcodeCompatibleAudioCodecs.includes(codec));
    return { unsupported: false, compatible: videoOk && audioOk, reason: "already_compatible_codecs" };
  }

  if (audioCodecs.length === 0) {
    return { unsupported: true, compatible: false, reason: "unsupported_media_content" };
  }
  if (videoCodecs.length > 0) {
    return { unsupported: false, compatible: false, reason: "" };
  }
  const audioOnlyOk = audioCodecs.every((codec) => config.transcodeCompatibleAudioCodecs.includes(codec));
  return { unsupported: false, compatible: audioOnlyOk, reason: "already_compatible_codecs" };
}

async function transcodeToOutput(inputPath: string, outputPath: string, mediaKind: "video" | "audio", audioTrack = 0) {
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
      audioTrack > 0 ? `0:a:${Math.max(0, audioTrack)}?` : "0:a:0?",
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
    "-map",
    audioTrack > 0 ? `0:a:${Math.max(0, audioTrack)}?` : "0:a:0?",
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

async function updateSourceTranscodeStateForTrack(
  archiveId: string,
  fileIndex: number,
  audioTrack: number,
  patch: Record<string, unknown>,
  updateTrack0Variant = true
) {
  if (Number.isInteger(audioTrack) && audioTrack > 0) {
    await upsertSourceTranscodeVariantState(archiveId, fileIndex, audioTrack, patch);
    return;
  }
  await updateSourceTranscodeState(archiveId, fileIndex, patch);
  if (updateTrack0Variant) {
    await upsertSourceTranscodeVariantState(archiveId, fileIndex, 0, patch);
  }
}

async function upsertSourceTranscodeVariantState(
  archiveId: string,
  fileIndex: number,
  audioTrack: number,
  patch: Record<string, unknown>
) {
  const source = await Archive.findById(archiveId).select("files").lean();
  const files = Array.isArray(source?.files) ? source.files : [];
  const file = files[fileIndex];
  const baseVariants = Array.isArray((file as any)?.transcode?.variants)
    ? (file as any).transcode.variants
    : [];
  const variants = baseVariants
    .map((item: any) => ({
      audioTrack: Number(item?.audioTrack),
      archiveId: String(item?.archiveId || ""),
      status: item?.status || null,
      size: Number(item?.size || 0),
      contentType: String(item?.contentType || ""),
      updatedAt: item?.updatedAt || null,
      error: String(item?.error || "")
    }))
    .filter((item: any) => Number.isInteger(item.audioTrack) && item.audioTrack >= 0);
  const idx = variants.findIndex((item: any) => item.audioTrack === audioTrack);
  const next = {
    audioTrack,
    archiveId: String(patch.archiveId ?? (idx >= 0 ? variants[idx].archiveId : "")),
    status: patch.status ?? (idx >= 0 ? variants[idx].status : null),
    size: Number(patch.size ?? (idx >= 0 ? variants[idx].size : 0)),
    contentType: String(patch.contentType ?? (idx >= 0 ? variants[idx].contentType : "")),
    updatedAt: patch.updatedAt ?? new Date(),
    error: String(patch.error ?? (idx >= 0 ? variants[idx].error : ""))
  };
  if (idx >= 0) {
    variants[idx] = next;
  } else {
    variants.push(next);
  }
  variants.sort((a: any, b: any) => a.audioTrack - b.audioTrack);
  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.transcode.variants`]: variants,
        [`files.${fileIndex}.transcode.updatedAt`]: new Date()
      }
    }
  );
}

async function createTranscodedArchive(
  sourceArchive: ArchiveDoc | any,
  fileIndex: number,
  sourcePath: string,
  sourceName: string,
  detectedKind?: string,
  audioTrack = 0
) {
  const sourceId = sourceArchiveId(sourceArchive);
  const userId = sourceUserId(sourceArchive);
  if (!sourceId) {
    throw new Error("source_archive_id_missing");
  }
  if (!userId) {
    throw new Error("source_user_id_missing");
  }
  const mediaKind = resolveMediaKind(sourceName, detectedKind);
  if (!mediaKind) {
    await updateSourceTranscodeStateForTrack(sourceId, fileIndex, audioTrack, {
      status: "skipped",
      error: "unsupported_media_type",
      archiveId: "",
      size: 0,
      contentType: ""
    });
    return null;
  }
  if (isSkippedByConfig(sourceName, mediaKind)) {
    await updateSourceTranscodeStateForTrack(sourceId, fileIndex, audioTrack, {
      status: "skipped",
      error: "already_compatible",
      archiveId: "",
      size: 0,
      contentType: ""
    });
    return null;
  }

  const compatibility = await evaluateCompatibility(sourcePath, mediaKind);
  if (compatibility.unsupported) {
    await updateSourceTranscodeStateForTrack(sourceId, fileIndex, audioTrack, {
      status: "skipped",
      error: compatibility.reason || "unsupported_media_content",
      archiveId: "",
      size: 0,
      contentType: ""
    });
    return null;
  }
  if (compatibility.compatible) {
    await updateSourceTranscodeStateForTrack(sourceId, fileIndex, audioTrack, {
      status: "skipped",
      error: compatibility.reason || "already_compatible_codecs",
      archiveId: "",
      size: 0,
      contentType: ""
    });
    return null;
  }

  const existingVariants = Array.isArray(sourceArchive.files?.[fileIndex]?.transcode?.variants)
    ? sourceArchive.files[fileIndex].transcode.variants
    : [];
  const existingArchiveId = audioTrack > 0
    ? String(
        existingVariants.find((variant: any) => Number(variant?.audioTrack) === audioTrack)?.archiveId || ""
      )
    : String(sourceArchive.files?.[fileIndex]?.transcode?.archiveId || "");
  if (existingArchiveId) {
    const existing = await Archive.findById(existingArchiveId).select("_id status deletedAt").lean();
    if (existing && !existing.deletedAt && ["queued", "processing", "ready"].includes(String(existing.status || ""))) {
      return existing._id.toString();
    }
  }

  const workDir = transcodeWorkDir(sourceId, fileIndex);
  await fs.promises.mkdir(workDir, { recursive: true });
  const outputName = getOutputName(sourceName, mediaKind, audioTrack);
  const outputPath = path.join(workDir, `0_${sanitizeFilename(outputName)}`);
  const contentType = (mime.lookup(outputName) as string) || (mediaKind === "video" ? "video/mp4" : "audio/mp4");

  log("transcode", `start source=${sourceId} file=${fileIndex} name=${sourceName}`);
  const sourceStat = await fs.promises.stat(sourcePath).catch(() => null);
  const inputBytes = Math.max(0, Number(sourceStat?.size || 0));
  noteTranscodeStarted(inputBytes);
  const startedAt = Date.now();
  let finished = false;
  try {
    await transcodeToOutput(sourcePath, outputPath, mediaKind, audioTrack);
    const transcodeDurationMs = Date.now() - startedAt;
    const stat = await fs.promises.stat(outputPath);
    if (!stat.size) {
      noteTranscodeError();
      finished = true;
      throw new Error("transcode_output_empty");
    }

    const user = await User.findById(userId);
    if (!user) {
      throw new Error("user_not_found");
    }
    if (user.quotaBytes > 0 && user.usedBytes + stat.size > user.quotaBytes) {
      noteTranscodeError();
      finished = true;
      await updateSourceTranscodeStateForTrack(sourceId, fileIndex, audioTrack, {
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
      userId,
      name: sanitizeFilename(outputName),
      displayName: `${sourceName} (converted${audioTrack > 0 ? ` track ${audioTrack + 1}` : ""})`,
      downloadName: outputName,
      archiveKind: "transcoded",
      sourceArchiveId: sourceArchive._id || sourceId,
      sourceFileIndex: fileIndex,
      transcodeAudioTrack: audioTrack,
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

    await User.updateOne({ _id: userId }, { $inc: { usedBytes: stat.size } });
    await updateSourceTranscodeStateForTrack(sourceId, fileIndex, audioTrack, {
      archiveId: archive.id,
      status: "queued",
      size: stat.size,
      contentType,
      error: ""
    });
    noteTranscodeDone(stat.size, transcodeDurationMs);
    finished = true;
    log("transcode", `queued source=${sourceId} file=${fileIndex} archive=${archive.id} size=${stat.size}`);
    return archive.id;
  } catch (err) {
    if (!finished) {
      noteTranscodeError();
      finished = true;
    }
    throw err;
  }
}

async function ensureSourceUserEnabled(userId: string) {
  const user = await User.findById(userId).select("transcodeCopiesEnabled").lean();
  return !!user?.transcodeCopiesEnabled;
}

export async function ensureArchiveFileTranscodeFromSource(
  sourceArchive: ArchiveDoc | any,
  fileIndex: number,
  audioTrack = 0
) {
  const sourceId = sourceArchiveId(sourceArchive);
  const userId = sourceUserId(sourceArchive);
  if (!sourceId) {
    throw new Error("source_archive_id_missing");
  }
  if (!userId) {
    throw new Error("source_user_id_missing");
  }
  const key = `${sourceId}:${fileIndex}:${audioTrack}`;
  if (inFlight.has(key)) {
    return inFlight.get(key)!;
  }
  const run = (async () => {
    const file = sourceArchive.files?.[fileIndex];
    if (!file || file?.deletedAt) return null;
    if (String(sourceArchive.archiveKind || "primary") === "transcoded") return null;
    const enabled = await ensureSourceUserEnabled(userId);
    if (!enabled) {
      if (audioTrack > 0) {
        await upsertSourceTranscodeVariantState(sourceId, fileIndex, audioTrack, {
          status: "skipped",
          error: "disabled_by_user",
          archiveId: "",
          size: 0,
          contentType: ""
        });
      } else {
        await updateSourceTranscodeState(sourceId, fileIndex, {
          status: "skipped",
          error: "disabled_by_user",
          archiveId: "",
          size: 0,
          contentType: ""
        });
      }
      return null;
    }

    const sourceName = file.originalName || file.name || `file_${fileIndex}`;
    if (!supportsTranscodeCopy(sourceName, file.detectedKind)) {
      if (audioTrack > 0) {
        await upsertSourceTranscodeVariantState(sourceId, fileIndex, audioTrack, {
          status: "skipped",
          error: "unsupported_media_type",
          archiveId: "",
          size: 0,
          contentType: ""
        });
      } else {
        await updateSourceTranscodeState(sourceId, fileIndex, {
          status: "skipped",
          error: "unsupported_media_type",
          archiveId: "",
          size: 0,
          contentType: ""
        });
      }
      return null;
    }

    const sourcePath = String(file.path || "");
    if (!sourcePath || !(await fs.promises.stat(sourcePath).catch(() => null))) {
      throw new Error("source_missing");
    }

    if (audioTrack > 0) {
      await upsertSourceTranscodeVariantState(sourceId, fileIndex, audioTrack, {
        status: "processing",
        error: ""
      });
    } else {
      await updateSourceTranscodeState(sourceId, fileIndex, {
        status: "processing",
        error: ""
      });
      await upsertSourceTranscodeVariantState(sourceId, fileIndex, 0, {
        status: "processing",
        error: ""
      });
    }
    return await createTranscodedArchive(sourceArchive, fileIndex, sourcePath, sourceName, file.detectedKind, audioTrack);
  })()
    .catch(async (err) => {
      const message = toErrorMessage(err);
      if (audioTrack > 0) {
        await upsertSourceTranscodeVariantState(sourceId, fileIndex, audioTrack, {
          status: "error",
          error: message.slice(0, 500)
        });
      } else {
        await updateSourceTranscodeState(sourceId, fileIndex, {
          status: "error",
          error: message.slice(0, 500)
        });
      }
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
  const sourceId = sourceArchiveId(sourceArchive);
  if (!sourceId) {
    throw new Error("source_archive_id_missing");
  }
  const sourceName = file.originalName || file.name || `file_${fileIndex}`;
  const sourcePath = String(file.path || "");
  const sourceExists = sourcePath ? await fs.promises.stat(sourcePath).catch(() => null) : null;
  if (sourceExists) {
    return ensureArchiveFileTranscodeFromSource(sourceArchive, fileIndex, 0);
  }

  const workDir = transcodeWorkDir(sourceId, fileIndex);
  await fs.promises.mkdir(workDir, { recursive: true });
  const restoredPath = path.join(workDir, `${fileIndex}_${sanitizeFilename(sourceName)}`);
  try {
    if (sourceArchive.isBundle) {
      await restoreArchiveFileToFile(sourceArchive, fileIndex, restoredPath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(sourceArchive, restoredPath, config.cacheDir, config.masterKey);
    }
    const sourceObject =
      sourceArchive && typeof (sourceArchive as any).toObject === "function"
        ? (sourceArchive as any).toObject()
        : sourceArchive;
    const restoredArchive = {
      ...sourceObject,
      _id: sourceObject?._id || sourceId,
      userId: sourceObject?.userId || sourceArchive?.userId,
      files: [...(sourceObject?.files || [])]
    };
    restoredArchive.files[fileIndex] = { ...restoredArchive.files[fileIndex], path: restoredPath };
    return await ensureArchiveFileTranscodeFromSource(restoredArchive, fileIndex, 0);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureArchiveFileTranscodeForAudioTrack(
  sourceArchive: ArchiveDoc | any,
  fileIndex: number,
  audioTrack: number
) {
  if (!Number.isInteger(audioTrack) || audioTrack <= 0) {
    return ensureArchiveFileTranscode(sourceArchive, fileIndex);
  }
  const file = sourceArchive.files?.[fileIndex];
  if (!file || file.deletedAt) return null;
  const sourceId = sourceArchiveId(sourceArchive);
  if (!sourceId) throw new Error("source_archive_id_missing");
  const sourceName = file.originalName || file.name || `file_${fileIndex}`;
  const sourcePath = String(file.path || "");
  const sourceExists = sourcePath ? await fs.promises.stat(sourcePath).catch(() => null) : null;
  if (sourceExists) {
    return ensureArchiveFileTranscodeFromSource(sourceArchive, fileIndex, audioTrack);
  }

  const workDir = transcodeWorkDir(sourceId, fileIndex);
  await fs.promises.mkdir(workDir, { recursive: true });
  const restoredPath = path.join(workDir, `${fileIndex}_${sanitizeFilename(sourceName)}`);
  try {
    if (sourceArchive.isBundle) {
      await restoreArchiveFileToFile(sourceArchive, fileIndex, restoredPath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(sourceArchive, restoredPath, config.cacheDir, config.masterKey);
    }
    const sourceObject =
      sourceArchive && typeof (sourceArchive as any).toObject === "function"
        ? (sourceArchive as any).toObject()
        : sourceArchive;
    const restoredArchive = {
      ...sourceObject,
      _id: sourceObject?._id || sourceId,
      userId: sourceObject?.userId || sourceArchive?.userId,
      files: [...(sourceObject?.files || [])]
    };
    restoredArchive.files[fileIndex] = { ...restoredArchive.files[fileIndex], path: restoredPath };
    return await ensureArchiveFileTranscodeFromSource(restoredArchive, fileIndex, audioTrack);
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

export async function findReadyTranscodeArchiveByAudioTrack(
  sourceArchive: ArchiveDoc | any,
  fileIndex: number,
  audioTrack: number
) {
  if (!Number.isInteger(audioTrack) || audioTrack <= 0) {
    return findReadyTranscodeArchive(sourceArchive, fileIndex);
  }
  const variants = Array.isArray(sourceArchive?.files?.[fileIndex]?.transcode?.variants)
    ? sourceArchive.files[fileIndex].transcode.variants
    : [];
  const directId = String(
    variants.find((variant: any) => Number(variant?.audioTrack) === audioTrack && String(variant?.status || "") === "ready")?.archiveId || ""
  );
  if (directId) {
    const direct = await Archive.findById(directId);
    if (direct && !direct.deletedAt && !direct.trashedAt && String(direct.archiveKind || "") === "transcoded" && direct.status === "ready") {
      return direct;
    }
  }
  const sourceArchiveId = sourceArchive?._id || sourceArchive?.id || null;
  if (!sourceArchiveId) return null;
  const found = await Archive.findOne({
    archiveKind: "transcoded",
    sourceArchiveId,
    sourceFileIndex: fileIndex,
    transcodeAudioTrack: audioTrack,
    status: "ready",
    deletedAt: null,
    trashedAt: null
  });
  if (!found) return null;
  await upsertSourceTranscodeVariantState(String(sourceArchiveId), fileIndex, audioTrack, {
    archiveId: found.id,
    status: "ready",
    size: Number(found.originalSize || found.files?.[0]?.size || 0),
    contentType: String((mime.lookup(found.downloadName || found.name || "") as string) || ""),
    error: ""
  }).catch(() => undefined);
  return found;
}

export async function syncSourceTranscodeStateFromArchive(transcodeArchive: ArchiveDoc | any) {
  if (String(transcodeArchive.archiveKind || "") !== "transcoded") return;
  const sourceArchiveId = transcodeArchive.sourceArchiveId ? String(transcodeArchive.sourceArchiveId) : "";
  const sourceFileIndex = Number(transcodeArchive.sourceFileIndex);
  const audioTrack = Number(transcodeArchive.transcodeAudioTrack);
  if (!sourceArchiveId || !Number.isInteger(sourceFileIndex) || sourceFileIndex < 0) return;
  const file = transcodeArchive.files?.[0];
  const contentType = (mime.lookup(file?.originalName || file?.name || transcodeArchive.downloadName || "") as string) || "";
  const nextStatus =
    transcodeArchive.status === "ready"
      ? "ready"
      : transcodeArchive.status === "error"
        ? "error"
        : "processing";
  const archiveId = asId(transcodeArchive.id || transcodeArchive._id);
  const patch = {
    archiveId,
    status: nextStatus,
    size: Number(transcodeArchive.originalSize || file?.size || 0),
    contentType,
    error: String(transcodeArchive.error || "")
  };
  if (Number.isInteger(audioTrack) && audioTrack > 0) {
    await upsertSourceTranscodeVariantState(sourceArchiveId, sourceFileIndex, audioTrack, patch);
    return;
  }
  await updateSourceTranscodeState(sourceArchiveId, sourceFileIndex, patch);
  await upsertSourceTranscodeVariantState(sourceArchiveId, sourceFileIndex, 0, patch);
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
