import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { File, FormData } from "undici";
import { Archive, type ArchiveDoc } from "../models/Archive.js";
import { Webhook } from "../models/Webhook.js";
import { config } from "../config.js";
import { downloadToFile, fetchWebhookMessage, uploadBufferToWebhook } from "./discord.js";
import { restoreArchiveFileToFile, restoreArchiveToFile } from "./restore.js";
import { uploadPartMirrored, type PartProvider, type ProviderCopy } from "./partProvider.js";
import { buildTelegramFileUrl, isTelegramReady, uploadBufferToTelegram } from "./telegram.js";
import { outboundFetch } from "./outbound.js";
import { log } from "../logger.js";
import {
  noteSubtitleDone,
  noteSubtitleError,
  noteSubtitleProviderAttempt,
  noteSubtitleProviderFailure,
  noteSubtitleStarted
} from "./analytics.js";

const subtitleVideoExt = new Set([
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
const subtitleAudioExt = new Set([
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
const inFlight = new Map<string, Promise<SubtitleResult>>();
const trackProbeInFlight = new Map<string, Promise<AudioTrackInfo[]>>();
const trackProbeCache = new Map<string, { tracks: AudioTrackInfo[]; expiresAt: number }>();
const TRACK_PROBE_CACHE_MS = 6 * 60 * 60 * 1000;
const SUBTITLE_PERMANENT_PREFIX = "subtitle_permanent_failure:";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(ms || 0))));

export interface SubtitleResult {
  filePath: string;
  contentType: string;
  size: number;
  language: string;
}

type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

type AudioTrackInfo = {
  audioTrack: number;
  language: string;
  label: string;
};

function toMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err || "");
}

function makePermanentSubtitleFailure(message: string) {
  return new Error(`${SUBTITLE_PERMANENT_PREFIX}${message}`.slice(0, 1200));
}

export function isPermanentSubtitleFailureMessage(message: string) {
  if (!message) return false;
  if (message.startsWith(SUBTITLE_PERMANENT_PREFIX)) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes("no_audio_stream") ||
    lower.includes("audio_track_not_found") ||
    lower.includes("output file does not contain any stream") ||
    lower.includes("subtitle_unsupported") ||
    lower.includes("file_not_found") ||
    lower.includes("part_crypto_missing") ||
    lower.includes("bundle stream parse error") ||
    lower.includes("zip parse guard invalid signature")
  );
}

function extOf(fileName: string) {
  const lower = String(fileName || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

export function getMediaKind(fileName: string, detectedKind?: string) {
  if (detectedKind === "video") return "video" as const;
  if (detectedKind === "audio") return "audio" as const;
  if (detectedKind && detectedKind !== "video" && detectedKind !== "audio") return null;
  const ext = extOf(fileName);
  if (subtitleVideoExt.has(ext)) return "video" as const;
  if (subtitleAudioExt.has(ext)) return "audio" as const;
  return null;
}

export function supportsSubtitle(fileName: string, detectedKind?: string) {
  return !!getMediaKind(fileName, detectedKind);
}

function subtitleTargetPath(archiveId: string, fileIndex: number, audioTrack = 0) {
  if (!audioTrack) {
    return path.join(config.cacheDir, "subtitles", `${archiveId}_${fileIndex}.vtt`);
  }
  return path.join(config.cacheDir, "subtitles", `${archiveId}_${fileIndex}_a${audioTrack}.vtt`);
}

function subtitleTrackKey(archiveId: string, fileIndex: number, audioTrack = 0) {
  return `${archiveId}:${fileIndex}:track:${audioTrack}`;
}

function normalizeTrackLanguage(value?: string) {
  const text = String(value || "").trim();
  return text || "auto";
}

function buildTrackLabel(audioTrack: number, language?: string, title?: string) {
  const idx = audioTrack + 1;
  const lang = normalizeTrackLanguage(language);
  const cleanTitle = String(title || "").trim();
  if (cleanTitle && lang !== "auto") return `Track ${idx} (${lang}, ${cleanTitle})`;
  if (cleanTitle) return `Track ${idx} (${cleanTitle})`;
  if (lang !== "auto") return `Track ${idx} (${lang})`;
  return `Track ${idx}`;
}

async function ensureSubtitleDir() {
  await fs.promises.mkdir(path.join(config.cacheDir, "subtitles"), { recursive: true });
}

async function cleanupOrphanSubtitleWorkDirs(archiveId: string, fileIndex: number) {
  const baseDir = path.join(config.cacheDir, "subtitle_work");
  const prefix = `${archiveId}_${fileIndex}_`;
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const full = path.join(baseDir, entry.name);
    await fs.promises.rm(full, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  if (removed > 0) {
    log("subtitle", `work cleanup archive=${archiveId} file=${fileIndex} removed=${removed}`);
  }
}

async function markSubtitlePermanentFailure(archiveId: string, fileIndex: number, message: string) {
  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.subtitle.failedAt`]: new Date(),
        [`files.${fileIndex}.subtitle.error`]: message.slice(0, 500),
        [`files.${fileIndex}.subtitle.updatedAt`]: null
      }
    }
  );
}

async function markSubtitleTrackPermanentFailure(
  archiveId: string,
  fileIndex: number,
  audioTrack: number,
  message: string
) {
  await upsertSubtitleTrackMeta(archiveId, fileIndex, audioTrack, {
    audioTrack,
    label: buildTrackLabel(audioTrack, "auto", ""),
    language: "auto",
    contentType: "text/vtt; charset=utf-8",
    size: 0,
    localPath: subtitleTargetPath(archiveId, fileIndex, audioTrack),
    updatedAt: null,
    failedAt: new Date(),
    error: message.slice(0, 500)
  });
}

async function refreshDiscordUrl(webhookId: string, messageId: string) {
  const hook = await Webhook.findById(webhookId).lean();
  if (!hook?.url) {
    throw new Error("missing_webhook");
  }
  const payload = await fetchWebhookMessage(hook.url, messageId);
  const freshUrl = payload.attachments?.[0]?.url;
  if (!freshUrl) {
    throw new Error("missing_attachment_url");
  }
  return freshUrl;
}

async function refreshPrimarySubtitleUrl(
  archiveId: string,
  fileIndex: number,
  subtitleMeta: any
) {
  const provider = subtitleMeta?.provider as PartProvider | undefined;
  const fileId = String(subtitleMeta?.telegramFileId || "");
  const freshUrl =
    provider === "telegram"
      ? await buildTelegramFileUrl(fileId)
      : await refreshDiscordUrl(String(subtitleMeta?.webhookId || ""), String(subtitleMeta?.messageId || ""));
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { [`files.${fileIndex}.subtitle.url`]: freshUrl, [`files.${fileIndex}.subtitle.updatedAt`]: new Date() } }
  );
  subtitleMeta.url = freshUrl;
  return freshUrl;
}

async function refreshMirrorSubtitleUrl(
  archiveId: string,
  fileIndex: number,
  subtitleMeta: any
) {
  const provider = subtitleMeta?.mirrorProvider as PartProvider | undefined;
  const fileId = String(subtitleMeta?.mirrorTelegramFileId || "");
  const freshUrl =
    provider === "telegram"
      ? await buildTelegramFileUrl(fileId)
      : await refreshDiscordUrl(
          String(subtitleMeta?.mirrorWebhookId || ""),
          String(subtitleMeta?.mirrorMessageId || "")
        );
  await Archive.updateOne(
    { _id: archiveId },
    { $set: { [`files.${fileIndex}.subtitle.mirrorUrl`]: freshUrl, [`files.${fileIndex}.subtitle.updatedAt`]: new Date() } }
  );
  subtitleMeta.mirrorUrl = freshUrl;
  return freshUrl;
}

async function tryRestoreSubtitleFromRemote(
  archive: ArchiveDoc,
  fileIndex: number,
  localPath: string
) {
  const subtitleMeta = archive.files?.[fileIndex]?.subtitle;
  if (!subtitleMeta) {
    return false;
  }
  const primaryUrl = String(subtitleMeta.url || "");
  const primaryMessageId = String(subtitleMeta.messageId || "");
  const primaryProvider = String(subtitleMeta.provider || "");
  if (primaryUrl && primaryMessageId && primaryProvider) {
    try {
      await downloadToFile(primaryUrl, localPath);
      return true;
    } catch (err) {
      const message = toMessage(err);
      if (/download_failed:404/.test(message)) {
        const repaired = await refreshPrimarySubtitleUrl(archive.id, fileIndex, subtitleMeta);
        await downloadToFile(repaired, localPath);
        return true;
      }
    }
  }

  const mirrorUrl = String(subtitleMeta.mirrorUrl || "");
  const mirrorMessageId = String(subtitleMeta.mirrorMessageId || "");
  const mirrorProvider = String(subtitleMeta.mirrorProvider || "");
  if (!mirrorUrl || !mirrorMessageId || !mirrorProvider) {
    return false;
  }
  try {
    await downloadToFile(mirrorUrl, localPath);
    return true;
  } catch (err) {
    const message = toMessage(err);
    if (!/download_failed:404/.test(message)) {
      return false;
    }
    const repaired = await refreshMirrorSubtitleUrl(archive.id, fileIndex, subtitleMeta);
    await downloadToFile(repaired, localPath);
    return true;
  }
}

function shellEscape(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runCommand(command: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const shell = process.platform === "win32" ? "cmd" : "bash";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    const proc = spawn(shell, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`subtitle_local_failed:${code}:${stderr.slice(-500)}`));
      }
    });
  });
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", (err) => {
      reject(new Error(`ffmpeg_spawn_failed:${toMessage(err)}`));
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

function runFfprobeDuration(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", (err) => reject(new Error(`ffprobe_spawn_failed:${toMessage(err)}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe_failed:${code}:${stderr.slice(-500)}`));
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("ffprobe_invalid_duration"));
        return;
      }
      resolve(duration);
    });
  });
}

async function listAudioTracksFromFile(filePath: string): Promise<AudioTrackInfo[]> {
  return new Promise<AudioTrackInfo[]>((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index:stream_tags=language,title",
      "-of",
      "json",
      filePath
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", (err) => reject(new Error(`ffprobe_spawn_failed:${toMessage(err)}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe_failed:${code}:${stderr.slice(-500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}") as { streams?: Array<{ tags?: Record<string, unknown> }> };
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        if (streams.length === 0) {
          resolve([]);
          return;
        }
        const tracks = streams.map((stream, idx) => {
          const tags = stream?.tags || {};
          const language = normalizeTrackLanguage(String(tags.language || ""));
          const title = String(tags.title || "");
          return {
            audioTrack: idx,
            language,
            label: buildTrackLabel(idx, language, title)
          } satisfies AudioTrackInfo;
        });
        resolve(tracks);
      } catch (err) {
        reject(new Error(`ffprobe_parse_failed:${toMessage(err)}`));
      }
    });
  });
}

async function probeAudioTracksFromArchive(archive: ArchiveDoc, fileIndex: number, fileName: string): Promise<AudioTrackInfo[]> {
  const key = `${archive.id}:${fileIndex}`;
  const cached = trackProbeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tracks;
  }
  const existing = trackProbeInFlight.get(key);
  if (existing) {
    return existing;
  }
  const run = (async () => {
    const file = archive.files?.[fileIndex];
    if (!file) {
      return [{ audioTrack: 0, language: "auto", label: "Track 1" }];
    }
    const tmpDir = path.join(
      config.cacheDir,
      "subtitle_probe_work",
      `${archive.id}_${fileIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const restoreName = (file.name || file.originalName || fileName || `file_${fileIndex}`).replace(/[\\/]/g, "_");
    const sourcePath = path.join(tmpDir, restoreName);
    try {
      if (archive.isBundle) {
        await restoreArchiveFileToFile(archive, fileIndex, sourcePath, config.cacheDir, config.masterKey);
      } else {
        await restoreArchiveToFile(archive, sourcePath, config.cacheDir, config.masterKey);
      }
      return await listAudioTracksFromFile(sourcePath);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })()
    .then((tracks) => {
      trackProbeCache.set(key, {
        tracks,
        expiresAt: Date.now() + TRACK_PROBE_CACHE_MS
      });
      return tracks;
    })
    .finally(() => {
      trackProbeInFlight.delete(key);
    });
  trackProbeInFlight.set(key, run);
  return run;
}

function sanitizeAsrBaseName(sourceName: string) {
  const base = path.basename(sourceName || "audio");
  const noExt = base.replace(/\.[^.]+$/, "");
  const cleaned = noExt.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "audio").slice(0, 100);
}

async function prepareAsrUploadInput(inputPath: string, sourceName: string, audioTrack = 0) {
  const sourceLabel = path.basename(sourceName || inputPath);
  const sourceStat = await fs.promises.stat(inputPath);
  const ext = extOf(sourceName || inputPath);
  const mediaKind = getMediaKind(sourceName || inputPath);
  const shouldPrepare = !!mediaKind || sourceStat.size > config.subtitleAsrMaxBytes || ext === ".webm";
  if (!shouldPrepare) {
    return {
      uploadPath: inputPath,
      uploadName: sourceLabel,
      uploadSize: sourceStat.size,
      cleanup: async () => undefined
    };
  }

  const tempDir = path.join(
    config.cacheDir,
    "subtitle_work",
    `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputPath = path.join(tempDir, `${sanitizeAsrBaseName(sourceLabel)}.mp3`);
  log("subtitle", `prepare start file=${sourceLabel} track=${audioTrack} size=${sourceStat.size}`);
  try {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map",
      `0:a:${Math.max(0, audioTrack)}?`,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      outputPath
    ]);
    const preparedStat = await fs.promises.stat(outputPath);
    if (!preparedStat.size) {
      throw new Error("prepared_audio_empty");
    }
    log(
      "subtitle",
      `prepare done file=${sourceLabel} track=${audioTrack} prepared=${path.basename(outputPath)} size=${preparedStat.size}`
    );
    return {
      uploadPath: outputPath,
      uploadName: path.basename(outputPath),
      uploadSize: preparedStat.size,
      cleanup: async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };
  } catch (err) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

function looksLikeSrt(raw: string) {
  return /\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(raw);
}

function srtToVtt(rawSrt: string) {
  const normalized = rawSrt.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const out: string[] = ["WEBVTT", ""];
  for (const line of lines) {
    if (/^\d+\s*$/.test(line)) continue;
    if (line.includes("-->")) {
      out.push(line.replaceAll(",", "."));
      continue;
    }
    out.push(line);
  }
  if (out[out.length - 1] !== "") out.push("");
  return out.join("\n");
}

function normalizeVtt(raw: string) {
  const text = String(raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error("subtitle_empty");
  }
  if (text.startsWith("WEBVTT")) {
    return `${text}\n`;
  }
  if (looksLikeSrt(text)) {
    return srtToVtt(text);
  }
  return `WEBVTT\n\n00:00:00.000 --> 23:59:59.000\n${text}\n`;
}

function parseTimestampToSeconds(value: string) {
  const normalized = String(value || "").trim().replace(",", ".");
  const match = normalized.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  const s = Number.parseInt(match[3], 10);
  const msRaw = match[4] || "0";
  const ms = Number.parseInt(msRaw.padEnd(3, "0").slice(0, 3), 10);
  if ([h, m, s, ms].some((n) => !Number.isFinite(n))) return null;
  return h * 3600 + m * 60 + s + ms / 1000;
}

function formatTimestamp(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(
    2,
    "0"
  )}.${String(ms).padStart(3, "0")}`;
}

function parseVttCues(rawVtt: string) {
  const lines = String(rawVtt || "").replace(/\r\n/g, "\n").split("\n");
  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE")) {
      i += 1;
      continue;
    }
    const timingLine = line.includes("-->") ? line : (lines[i + 1] || "").trim();
    const timingMatch = timingLine.match(
      /^(\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*(\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)/
    );
    if (!timingMatch) {
      i += 1;
      continue;
    }
    const start = parseTimestampToSeconds(timingMatch[1]);
    const end = parseTimestampToSeconds(timingMatch[2]);
    if (start == null || end == null || end <= start) {
      i += 1;
      continue;
    }
    i += line.includes("-->") ? 1 : 2;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i += 1;
    }
    cues.push({
      start,
      end,
      text: textLines.join("\n").trim()
    });
    while (i < lines.length && lines[i].trim() === "") i += 1;
  }
  return cues;
}

function normalizeCueText(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeCues(cues: SubtitleCue[]) {
  const ordered = [...cues].sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  const out: SubtitleCue[] = [];
  for (const cue of ordered) {
    const text = String(cue.text || "").trim();
    if (!text) continue;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)) continue;
    if (cue.end <= cue.start + 0.01) continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      normalizeCueText(prev.text) === normalizeCueText(text) &&
      cue.start <= prev.end + 2
    ) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    out.push({ start: cue.start, end: cue.end, text });
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  requestedConcurrency: number,
  handler: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const concurrency =
    requestedConcurrency <= 0 ? items.length : Math.max(1, Math.min(items.length, Math.floor(requestedConcurrency)));
  let cursor = 0;
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await handler(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function cuesToVtt(cues: SubtitleCue[]) {
  const out: string[] = ["WEBVTT", ""];
  for (const cue of cues) {
    out.push(`${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}`);
    out.push(cue.text);
    out.push("");
  }
  return out.join("\n");
}

function extractTextFromApiBody(bodyText: string) {
  if (bodyText.trim().startsWith("WEBVTT") || looksLikeSrt(bodyText)) {
    return bodyText;
  }
  try {
    const parsed = JSON.parse(bodyText) as { text?: string; vtt?: string };
    const fromJson = parsed.vtt || parsed.text || "";
    if (!fromJson) {
      throw new Error("missing_text");
    }
    return fromJson;
  } catch {
    return bodyText;
  }
}

function transcriptToChunkCues(raw: string, chunkDurationSec: number) {
  const normalized = normalizeVtt(raw);
  const parsed = parseVttCues(normalized);
  if (parsed.length === 0) {
    const text = String(raw || "").trim();
    if (!text) {
      throw new Error("subtitle_empty");
    }
    return [{ start: 0, end: Math.max(1, chunkDurationSec), text }];
  }
  return parsed.map((cue) => ({
    start: Math.max(0, Math.min(chunkDurationSec, cue.start)),
    end: Math.max(0, Math.min(chunkDurationSec, cue.end)),
    text: cue.text
  }));
}

async function transcribeViaAsrHttp(inputPath: string, uploadName: string, sourceName: string) {
  const form = new FormData();
  form.append("model", config.subtitleAsrModel);
  if (config.subtitleAsrResponseFormat) {
    form.append("response_format", config.subtitleAsrResponseFormat);
  }
  if (config.subtitleLanguage && config.subtitleLanguage !== "auto") {
    form.append("language", config.subtitleLanguage);
  }
  if (config.subtitleAsrPrompt) {
    form.append("prompt", config.subtitleAsrPrompt);
  }
  const fileBuffer = await fs.promises.readFile(inputPath);
  form.append("file", new File([fileBuffer], uploadName));

  const response = await outboundFetch(config.subtitleAsrUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.subtitleAsrApiKey}`
    },
    body: form
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`subtitle_asr_failed:${response.status}:${bodyText.slice(0, 500)}`);
  }
  log("subtitle", `asr done file=${path.basename(sourceName || inputPath)} size=${fileBuffer.length}`);
  return extractTextFromApiBody(bodyText);
}

async function transcribeViaOpenAiChunked(preparedPath: string, preparedName: string, sourceName: string, preparedSize: number) {
  const durationSec = await runFfprobeDuration(preparedPath);
  const targetBytes = Math.max(1024 * 1024, Math.floor(config.subtitleAsrMaxBytes * 0.92));
  const bytesPerSec = Math.max(1, preparedSize / Math.max(1, durationSec));
  const overlapSec = 2;
  const chunkSec = Math.max(120, Math.floor(targetBytes / bytesPerSec));
  const effectiveChunkSec = Math.max(overlapSec + 5, chunkSec);

  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  let guard = 0;
  while (start < durationSec - 0.01 && guard < 10000) {
    const end = Math.min(durationSec, start + effectiveChunkSec);
    ranges.push({ start, end });
    if (end >= durationSec - 0.01) break;
    start = Math.max(0, end - overlapSec);
    guard += 1;
  }
  if (ranges.length === 0) {
    throw new Error("subtitle_chunk_ranges_empty");
  }

  const chunkDir = path.join(
    config.cacheDir,
    "subtitle_work",
    `asr_chunk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.promises.mkdir(chunkDir, { recursive: true });
  log(
    "subtitle",
    `asr chunking file=${path.basename(sourceName || preparedName)} size=${preparedSize} duration=${Math.round(
      durationSec
    )}s chunks=${ranges.length} chunkSec=${effectiveChunkSec} overlap=${overlapSec}`
  );

  const chunkJobs: Array<{
    index: number;
    range: { start: number; end: number };
    duration: number;
    chunkPath: string;
    uploadName: string;
  }> = [];
  try {
    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i];
      const duration = Math.max(1, range.end - range.start);
      const chunkPath = path.join(chunkDir, `part_${String(i + 1).padStart(3, "0")}.mp3`);
      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-ss",
        String(range.start),
        "-i",
        preparedPath,
        "-t",
        String(duration),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        "-f",
        "mp3",
        chunkPath
      ]);
      const chunkStat = await fs.promises.stat(chunkPath);
      if (chunkStat.size > config.subtitleAsrMaxBytes) {
        throw new Error(`subtitle_chunk_too_large:${i + 1}:${chunkStat.size}`);
      }
      chunkJobs.push({
        index: i,
        range,
        duration,
        chunkPath,
        uploadName: `${sanitizeAsrBaseName(preparedName)}_part_${String(i + 1).padStart(3, "0")}.mp3`
      });
    }

    const apiRetries = Math.max(1, Math.trunc(config.subtitleAsrChunkApiRetries || 1));
    const apiRetryMs = Math.max(250, Math.trunc(config.subtitleAsrChunkApiRetryMs || 1000));
    const apiConcurrencyRaw = Math.trunc(config.subtitleAsrChunkApiConcurrency || 0);
    const apiConcurrency = apiConcurrencyRaw <= 0 ? chunkJobs.length : Math.max(1, apiConcurrencyRaw);
    let localChain = Promise.resolve();

    const transcribeChunkViaApiWithRetries = async (job: (typeof chunkJobs)[number]) => {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= apiRetries; attempt += 1) {
        log(
          "subtitle",
          `asr chunk start file=${path.basename(sourceName || preparedName)} part=${job.index + 1}/${chunkJobs.length} attempt=${attempt}`
        );
        try {
          const raw = await transcribeViaAsrHttp(job.chunkPath, job.uploadName, sourceName);
          log(
            "subtitle",
            `asr chunk done file=${path.basename(sourceName || preparedName)} part=${job.index + 1}/${chunkJobs.length} provider=asr`
          );
          return raw;
        } catch (err) {
          lastErr = err;
          const message = toMessage(err);
          if (attempt < apiRetries) {
            log(
              "subtitle",
              `asr chunk retry file=${path.basename(sourceName || preparedName)} part=${job.index + 1}/${chunkJobs.length} in=${apiRetryMs * attempt}ms err=${message.slice(0, 120)}`
            );
            await sleep(apiRetryMs * attempt);
            continue;
          }
        }
      }
      throw (lastErr instanceof Error ? lastErr : new Error(String(lastErr || "subtitle_chunk_api_failed")));
    };

    const transcribeChunkViaLocalSequential = (job: (typeof chunkJobs)[number]) => {
      const run = localChain.then(async () => {
        const localOut = path.join(chunkDir, `part_${String(job.index + 1).padStart(3, "0")}.vtt`);
        log(
          "subtitle",
          `local chunk start file=${path.basename(sourceName || preparedName)} part=${job.index + 1}/${chunkJobs.length}`
        );
        const raw = await transcribeViaLocalCommand(job.chunkPath, localOut);
        log(
          "subtitle",
          `local chunk done file=${path.basename(sourceName || preparedName)} part=${job.index + 1}/${chunkJobs.length}`
        );
        return raw;
      });
      localChain = run.then(() => undefined).catch(() => undefined);
      return run;
    };

    const chunkCueLists = await mapWithConcurrency(chunkJobs, apiConcurrency, async (job) => {
      let raw = "";
      try {
        raw = await transcribeChunkViaApiWithRetries(job);
      } catch (apiErr) {
        const apiMessage = toMessage(apiErr);
        if (!config.subtitleLocalCommand) {
          throw apiErr;
        }
        log(
          "subtitle",
          `asr chunk fallback local file=${path.basename(sourceName || preparedName)} part=${job.index + 1}/${chunkJobs.length} err=${apiMessage.slice(0, 140)}`
        );
        raw = await transcribeChunkViaLocalSequential(job);
      }

      let cues = transcriptToChunkCues(raw, job.duration);
      if (job.index > 0 && overlapSec > 0) {
        cues = cues.filter((cue) => cue.end > overlapSec);
      }

      const shifted: SubtitleCue[] = [];
      for (const cue of cues) {
        const shiftedStart = Math.max(0, cue.start + job.range.start);
        const shiftedEnd = Math.min(durationSec, cue.end + job.range.start);
        if (shiftedEnd <= shiftedStart + 0.01) continue;
        shifted.push({ start: shiftedStart, end: shiftedEnd, text: cue.text });
      }
      return shifted;
    });

    const merged: SubtitleCue[] = [];
    for (const cues of chunkCueLists) {
      merged.push(...cues);
    }

    const deduped = dedupeCues(merged);
    if (deduped.length === 0) {
      throw new Error("subtitle_empty");
    }
    return cuesToVtt(deduped);
  } finally {
    await fs.promises.rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function transcribeViaOpenAi(inputPath: string, sourceName: string, audioTrack = 0) {
  if (!config.subtitleAsrEnabled || !config.subtitleAsrApiKey || !config.subtitleAsrModel) {
    throw new Error("subtitle_provider_not_configured");
  }
  const upload = await prepareAsrUploadInput(inputPath, sourceName, audioTrack);
  noteSubtitleProviderAttempt("asr");
  try {
    log("subtitle", `asr start file=${path.basename(sourceName || inputPath)} track=${audioTrack} size=${upload.uploadSize}`);
    if (upload.uploadSize <= config.subtitleAsrMaxBytes) {
      return await transcribeViaAsrHttp(upload.uploadPath, upload.uploadName, sourceName);
    }
    return await transcribeViaOpenAiChunked(upload.uploadPath, upload.uploadName, sourceName, upload.uploadSize);
  } catch (err) {
    noteSubtitleProviderFailure("asr");
    throw err;
  } finally {
    await upload.cleanup();
  }
}

async function transcribeViaLocalCommand(inputPath: string, outputPath: string) {
  if (!config.subtitleLocalCommand) {
    throw new Error("subtitle_local_command_not_configured");
  }
  noteSubtitleProviderAttempt("local");
  const command = config.subtitleLocalCommand
    .replaceAll("{input}", shellEscape(inputPath))
    .replaceAll("{output}", shellEscape(outputPath))
    .replaceAll("{lang}", shellEscape(config.subtitleLanguage || "auto"));
  log("subtitle", `local start file=${path.basename(inputPath)}`);
  try {
    const { stdout } = await runCommand(command);
    if (fs.existsSync(outputPath)) {
      log("subtitle", `local done file=${path.basename(inputPath)}`);
      return fs.promises.readFile(outputPath, "utf8");
    }
    if (stdout.trim()) {
      log("subtitle", `local done(stdout) file=${path.basename(inputPath)}`);
      return stdout;
    }
    throw new Error("subtitle_local_empty");
  } catch (err) {
    noteSubtitleProviderFailure("local");
    throw err;
  }
}

async function generateSubtitleVtt(sourcePath: string, fileName: string, outputPath: string, audioTrack = 0) {
  let raw = "";
  const failures: string[] = [];

  if (config.subtitleAsrEnabled) {
    try {
      raw = await transcribeViaOpenAi(sourcePath, fileName, audioTrack);
    } catch (err) {
      const message = toMessage(err);
      failures.push(`asr:${message}`);
      log("subtitle", `asr failed file=${path.basename(fileName || sourcePath)} err=${message.slice(0, 200)}`);
    }
  }

  if (!raw && config.subtitleLocalCommand) {
    try {
      raw = await transcribeViaLocalCommand(sourcePath, outputPath);
    } catch (err) {
      const message = toMessage(err);
      failures.push(`local:${message}`);
      log("subtitle", `local failed file=${path.basename(fileName || sourcePath)} err=${message.slice(0, 200)}`);
    }
  }

  if (!raw) {
    if (!config.subtitleAsrEnabled && !config.subtitleLocalCommand) {
      throw new Error("subtitle_provider_not_configured");
    }
    throw new Error(`subtitle_all_providers_failed:${failures.join(" | ").slice(0, 800)}`);
  }

  const normalized = normalizeVtt(raw);
  await fs.promises.writeFile(outputPath, normalized, "utf8");
  return normalized;
}

function toProviderDoc(copy: ProviderCopy) {
  return {
    provider: copy.provider,
    url: copy.url,
    messageId: copy.messageId,
    webhookId: copy.webhookId,
    telegramFileId: copy.telegramFileId || "",
    telegramChatId: copy.telegramChatId || ""
  };
}

async function uploadMirrorSubtitle(
  target: PartProvider,
  buffer: Buffer,
  fileName: string,
  content: string,
  webhook?: { id: string; url: string }
) {
  if (target === "telegram") {
    const tg = await uploadBufferToTelegram(buffer, fileName, content);
    return {
      provider: "telegram" as const,
      url: tg.url,
      messageId: tg.messageId,
      webhookId: "telegram",
      telegramFileId: tg.fileId,
      telegramChatId: tg.chatId
    };
  }
  if (!webhook?.url) {
    throw new Error("subtitle_mirror_missing_discord_webhook");
  }
  const dc = await uploadBufferToWebhook(buffer, fileName, webhook.url, content);
  return {
    provider: "discord" as const,
    url: dc.url,
    messageId: dc.messageId,
    webhookId: webhook.id
  };
}

async function uploadSubtitleBackup(archiveId: string, fileIndex: number, localPath: string) {
  const hooks = await Webhook.find({ enabled: true }).lean();
  const webhook = hooks.length > 0 ? hooks[Math.abs(fileIndex) % hooks.length] : null;
  const webhookRef = webhook
    ? { id: String((webhook as any)._id || (webhook as any).id), url: String((webhook as any).url || "") }
    : undefined;
  if (!webhookRef?.url && !isTelegramReady()) {
    return null;
  }
  const buffer = await fs.promises.readFile(localPath);
  const fileName = `subtitle_${archiveId}_${fileIndex}.vtt`;
  const content = `subtitle archive:${archiveId} file:${fileIndex}`;

  const uploaded = await uploadPartMirrored(buffer, fileName, content, webhookRef);

  let mirrorCopy: ProviderCopy | null = null;
  let mirrorPending = false;
  let mirrorError = "";
  if (uploaded.mirrorTarget) {
    try {
      mirrorCopy = await uploadMirrorSubtitle(uploaded.mirrorTarget, buffer, fileName, content, webhookRef);
    } catch (err) {
      mirrorPending = true;
      mirrorError = toMessage(err);
    }
  }

  return {
    primary: uploaded.primary,
    mirrorTarget: uploaded.mirrorTarget,
    mirrorCopy,
    mirrorPending,
    mirrorError
  };
}

function getTrackLanguage(track?: AudioTrackInfo | null) {
  return normalizeTrackLanguage(String(track?.language || config.subtitleLanguage || "auto"));
}

function findStoredSubtitleTrack(file: any, audioTrack: number) {
  if (!file) return null;
  if (!audioTrack) return file.subtitle || null;
  const tracks = Array.isArray(file.subtitleTracks) ? file.subtitleTracks : [];
  return tracks.find((track: any) => Number(track?.audioTrack || 0) === audioTrack) || null;
}

async function upsertSubtitleTrackMeta(
  archiveId: string,
  fileIndex: number,
  audioTrack: number,
  patch: Record<string, unknown>
) {
  const doc = await Archive.findById(archiveId);
  if (!doc) return;
  const file: any = doc.files?.[fileIndex];
  if (!file) return;
  const tracks = Array.isArray(file.subtitleTracks) ? [...file.subtitleTracks] : [];
  const idx = tracks.findIndex((track: any) => Number(track?.audioTrack || 0) === audioTrack);
  if (idx >= 0) {
    tracks[idx] = { ...tracks[idx], ...patch, audioTrack };
  } else {
    tracks.push({ audioTrack, ...patch });
  }
  tracks.sort((a: any, b: any) => Number(a?.audioTrack || 0) - Number(b?.audioTrack || 0));
  file.subtitleTracks = tracks;
  await doc.save();
}

async function persistSubtitleMeta(
  archiveId: string,
  fileIndex: number,
  localPath: string,
  audioTrack = 0,
  track?: AudioTrackInfo
): Promise<SubtitleResult> {
  const stat = await fs.promises.stat(localPath);
  const language = getTrackLanguage(track);
  const contentType = "text/vtt; charset=utf-8";
  if (!audioTrack) {
    const backup = await uploadSubtitleBackup(archiveId, fileIndex, localPath);
    const primary = backup ? toProviderDoc(backup.primary) : null;
    const mirror = backup?.mirrorCopy ? toProviderDoc(backup.mirrorCopy) : null;
    await Archive.updateOne(
      { _id: archiveId },
      {
        $set: {
          [`files.${fileIndex}.subtitle.contentType`]: contentType,
          [`files.${fileIndex}.subtitle.size`]: stat.size,
          [`files.${fileIndex}.subtitle.localPath`]: localPath,
          [`files.${fileIndex}.subtitle.language`]: language,
          [`files.${fileIndex}.subtitle.provider`]: primary?.provider || null,
          [`files.${fileIndex}.subtitle.url`]: primary?.url || "",
          [`files.${fileIndex}.subtitle.messageId`]: primary?.messageId || "",
          [`files.${fileIndex}.subtitle.webhookId`]: primary?.webhookId || "",
          [`files.${fileIndex}.subtitle.telegramFileId`]: primary?.telegramFileId || "",
          [`files.${fileIndex}.subtitle.telegramChatId`]: primary?.telegramChatId || "",
          [`files.${fileIndex}.subtitle.mirrorProvider`]: mirror?.provider || backup?.mirrorTarget || null,
          [`files.${fileIndex}.subtitle.mirrorUrl`]: mirror?.url || "",
          [`files.${fileIndex}.subtitle.mirrorMessageId`]: mirror?.messageId || "",
          [`files.${fileIndex}.subtitle.mirrorWebhookId`]: mirror?.webhookId || "",
          [`files.${fileIndex}.subtitle.mirrorTelegramFileId`]: mirror?.telegramFileId || "",
          [`files.${fileIndex}.subtitle.mirrorTelegramChatId`]: mirror?.telegramChatId || "",
          [`files.${fileIndex}.subtitle.mirrorPending`]: !!backup?.mirrorTarget && !mirror,
          [`files.${fileIndex}.subtitle.mirrorError`]: backup?.mirrorError || "",
          [`files.${fileIndex}.subtitle.updatedAt`]: new Date(),
          [`files.${fileIndex}.subtitle.failedAt`]: null,
          [`files.${fileIndex}.subtitle.error`]: ""
        }
      }
    );
  } else {
    await upsertSubtitleTrackMeta(archiveId, fileIndex, audioTrack, {
      audioTrack,
      label: track?.label || buildTrackLabel(audioTrack, language, ""),
      language,
      contentType,
      size: stat.size,
      localPath,
      updatedAt: new Date(),
      failedAt: null,
      error: ""
    });
  }
  return {
    filePath: localPath,
    contentType,
    size: stat.size,
    language
  };
}

async function syncSubtitleMirrorInternal(archive: ArchiveDoc, fileIndex: number) {
  const file = archive.files?.[fileIndex];
  const subtitle = file?.subtitle;
  if (!file || !subtitle?.mirrorPending || !subtitle?.mirrorProvider) {
    return false;
  }

  const localPath = subtitle.localPath || subtitleTargetPath(archive.id, fileIndex);
  await ensureSubtitleDir();
  if (!fs.existsSync(localPath)) {
    const restored = await tryRestoreSubtitleFromRemote(archive, fileIndex, localPath);
    if (!restored) {
      throw new Error("source_missing");
    }
  }

  const hooks = await Webhook.find({ enabled: true }).lean();
  const webhook = hooks.length > 0 ? hooks[Math.abs(fileIndex) % hooks.length] : null;
  const webhookRef = webhook
    ? { id: String((webhook as any)._id || (webhook as any).id), url: String((webhook as any).url || "") }
    : undefined;
  const buffer = await fs.promises.readFile(localPath);
  const fileName = `subtitle_${archive.id}_${fileIndex}.vtt`;
  const content = `subtitle archive:${archive.id} file:${fileIndex} mirror_sync`;
  try {
    const mirror = await uploadMirrorSubtitle(
      subtitle.mirrorProvider as PartProvider,
      buffer,
      fileName,
      content,
      webhookRef
    );
    const mirrorDoc = toProviderDoc(mirror);
    await Archive.updateOne(
      { _id: archive.id },
      {
        $set: {
          [`files.${fileIndex}.subtitle.mirrorUrl`]: mirrorDoc.url,
          [`files.${fileIndex}.subtitle.mirrorMessageId`]: mirrorDoc.messageId,
          [`files.${fileIndex}.subtitle.mirrorWebhookId`]: mirrorDoc.webhookId,
          [`files.${fileIndex}.subtitle.mirrorTelegramFileId`]: mirrorDoc.telegramFileId,
          [`files.${fileIndex}.subtitle.mirrorTelegramChatId`]: mirrorDoc.telegramChatId,
          [`files.${fileIndex}.subtitle.mirrorPending`]: false,
          [`files.${fileIndex}.subtitle.mirrorError`]: "",
          [`files.${fileIndex}.subtitle.updatedAt`]: new Date()
        }
      }
    );
  } catch (err) {
    const message = toMessage(err);
    await Archive.updateOne(
      { _id: archive.id },
      {
        $set: {
          [`files.${fileIndex}.subtitle.mirrorPending`]: true,
          [`files.${fileIndex}.subtitle.mirrorError`]: message.slice(0, 500)
        }
      }
    );
    throw err;
  }
  return true;
}

export async function syncArchiveSubtitleMirror(archive: ArchiveDoc, fileIndex: number) {
  const key = `${archive.id}:${fileIndex}:mirror`;
  const existing = inFlight.get(key);
  if (existing) {
    await existing;
    return true;
  }
  const promise = (async () => {
    await syncSubtitleMirrorInternal(archive, fileIndex);
    return {
      filePath: "",
      contentType: "text/vtt; charset=utf-8",
      size: 0,
      language: "auto"
    } as SubtitleResult;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  await promise;
  return true;
}

async function generateSubtitleUsingSource(
  archive: ArchiveDoc,
  fileIndex: number,
  fileName: string,
  sourcePath: string,
  localPath: string,
  audioTrack = 0,
  track?: AudioTrackInfo
) {
  const sourceBytes = await fs.promises.stat(sourcePath).then((s) => Number(s.size || 0)).catch(() => 0);
  noteSubtitleStarted(sourceBytes);
  const startedAt = Date.now();
  try {
    await generateSubtitleVtt(sourcePath, fileName, localPath, audioTrack);
  } catch (err) {
    noteSubtitleError();
    const message = toMessage(err);
    if (isPermanentSubtitleFailureMessage(message)) {
      if (!audioTrack) {
        await markSubtitlePermanentFailure(archive.id, fileIndex, message);
      } else {
        await upsertSubtitleTrackMeta(archive.id, fileIndex, audioTrack, {
          audioTrack,
          label: track?.label || buildTrackLabel(audioTrack, track?.language, ""),
          language: getTrackLanguage(track),
          contentType: "text/vtt; charset=utf-8",
          size: 0,
          localPath,
          updatedAt: null,
          failedAt: new Date(),
          error: message.slice(0, 500)
        });
      }
      throw makePermanentSubtitleFailure(message);
    }
    throw err;
  }
  try {
    const result = await persistSubtitleMeta(archive.id, fileIndex, localPath, audioTrack, track);
    noteSubtitleDone(result.size, Date.now() - startedAt);
    return result;
  } catch (err) {
    noteSubtitleError();
    throw err;
  }
}

async function ensureSubtitleTrackFromSource(
  archive: ArchiveDoc,
  fileIndex: number,
  audioTrack: number,
  track: AudioTrackInfo,
  fileName: string,
  sourcePath: string
) {
  await ensureSubtitleDir();
  const localPath = subtitleTargetPath(archive.id, fileIndex, audioTrack);
  if (fs.existsSync(localPath)) {
    const stat = await fs.promises.stat(localPath);
    return {
      filePath: localPath,
      contentType: "text/vtt; charset=utf-8",
      size: stat.size,
      language: getTrackLanguage(track)
    } satisfies SubtitleResult;
  }
  return generateSubtitleUsingSource(archive, fileIndex, fileName, sourcePath, localPath, audioTrack, track);
}

async function ensureAllSubtitleTracksFromSource(archive: ArchiveDoc, fileIndex: number, fileName: string, sourcePath: string) {
  const tracks = await listAudioTracksFromFile(sourcePath).catch(() => [] as AudioTrackInfo[]);
  if (tracks.length === 0) {
    const message = "no_audio_stream";
    await markSubtitlePermanentFailure(archive.id, fileIndex, message);
    throw makePermanentSubtitleFailure(message);
  }
  const primary = tracks.find((track) => track.audioTrack === 0) || tracks[0];
  const first = await ensureSubtitleTrackFromSource(archive, fileIndex, primary.audioTrack, primary, fileName, sourcePath);
  for (const track of tracks) {
    if (track.audioTrack === primary.audioTrack) continue;
    try {
      await ensureSubtitleTrackFromSource(archive, fileIndex, track.audioTrack, track, fileName, sourcePath);
    } catch (err) {
      const message = toMessage(err);
      log("subtitle", `track skip archive=${archive.id} file=${fileIndex} track=${track.audioTrack} err=${message.slice(0, 200)}`);
    }
  }
  return first;
}

async function ensureArchiveSubtitleFromSourceInternal(archive: ArchiveDoc, fileIndex: number, audioTrack = 0, allTracks = true) {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  if (!audioTrack && file.subtitle?.failedAt) {
    throw makePermanentSubtitleFailure(file.subtitle.error || "marked_failed");
  }
  const fileName = (file.originalName || file.name || "").trim();
  if (!supportsSubtitle(fileName, file.detectedKind)) {
    throw new Error("subtitle_unsupported");
  }
  if (!file.path || !fs.existsSync(file.path)) {
    throw new Error("source_missing");
  }
  const trackMeta = await listAudioTracksFromFile(file.path).catch(() => [] as AudioTrackInfo[]);
  if (trackMeta.length === 0) {
    const message = "no_audio_stream";
    if (!audioTrack) {
      await markSubtitlePermanentFailure(archive.id, fileIndex, message);
    } else {
      await markSubtitleTrackPermanentFailure(archive.id, fileIndex, audioTrack, message);
    }
    throw makePermanentSubtitleFailure(message);
  }
  const selected = trackMeta.find((track) => track.audioTrack === audioTrack);
  if (!selected) {
    const message = `audio_track_not_found:${audioTrack}`;
    await markSubtitleTrackPermanentFailure(archive.id, fileIndex, audioTrack, message);
    throw makePermanentSubtitleFailure(message);
  }
  if (allTracks && !audioTrack) {
    return ensureAllSubtitleTracksFromSource(archive, fileIndex, fileName, file.path);
  }
  return ensureSubtitleTrackFromSource(archive, fileIndex, audioTrack, selected, fileName, file.path);
}

export async function ensureArchiveSubtitleFromSource(archive: ArchiveDoc, fileIndex: number, audioTrack = 0) {
  const key = subtitleTrackKey(archive.id, fileIndex, audioTrack);
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const promise = ensureArchiveSubtitleFromSourceInternal(archive, fileIndex, audioTrack, audioTrack === 0).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function ensureSubtitleInternal(archive: ArchiveDoc, fileIndex: number, audioTrack = 0): Promise<SubtitleResult> {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  if (!audioTrack && file.subtitle?.failedAt) {
    throw makePermanentSubtitleFailure(file.subtitle.error || "marked_failed");
  }

  const fileName = (file.originalName || file.name || "").trim();
  if (!supportsSubtitle(fileName, file.detectedKind)) {
    throw new Error("subtitle_unsupported");
  }

  await ensureSubtitleDir();
  const trackMeta = findStoredSubtitleTrack(file, audioTrack);
  const localPath = String(trackMeta?.localPath || subtitleTargetPath(archive.id, fileIndex, audioTrack));
  if (fs.existsSync(localPath)) {
    const stat = await fs.promises.stat(localPath);
    return {
      filePath: localPath,
      contentType: "text/vtt; charset=utf-8",
      size: stat.size,
      language: normalizeTrackLanguage(String(trackMeta?.language || config.subtitleLanguage || "auto"))
    };
  }

  if (file.path && fs.existsSync(file.path) && config.subtitlePreferSource) {
    try {
      return await ensureArchiveSubtitleFromSourceInternal(archive, fileIndex, audioTrack, audioTrack === 0);
    } catch (err) {
      if (isPermanentSubtitleFailureMessage(toMessage(err))) {
        throw err;
      }
      // fallback to remote restore
    }
  }

  if (!audioTrack && (await tryRestoreSubtitleFromRemote(archive, fileIndex, localPath))) {
    const stat = await fs.promises.stat(localPath);
    return {
      filePath: localPath,
      contentType: "text/vtt; charset=utf-8",
      size: stat.size,
      language: file.subtitle?.language || config.subtitleLanguage || "auto"
    };
  }

  if (file.path && fs.existsSync(file.path)) {
    return ensureArchiveSubtitleFromSourceInternal(archive, fileIndex, audioTrack, audioTrack === 0);
  }

  const tempDir = path.join(
    config.cacheDir,
    "subtitle_work",
    `${archive.id}_${fileIndex}_${Math.random().toString(36).slice(2, 8)}`
  );
  await cleanupOrphanSubtitleWorkDirs(archive.id, fileIndex);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const sourcePath = path.join(tempDir, file.name || `${fileIndex}_${Date.now()}`);
  try {
    if (archive.isBundle) {
      await restoreArchiveFileToFile(archive, fileIndex, sourcePath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(archive, sourcePath, config.cacheDir, config.masterKey);
    }
    if (!audioTrack) {
      return await ensureAllSubtitleTracksFromSource(archive, fileIndex, fileName, sourcePath);
    }
    const tracks = await listAudioTracksFromFile(sourcePath).catch(() => [] as AudioTrackInfo[]);
    if (tracks.length === 0) {
      const message = "no_audio_stream";
      await markSubtitleTrackPermanentFailure(archive.id, fileIndex, audioTrack, message);
      throw makePermanentSubtitleFailure(message);
    }
    const selected = tracks.find((track) => track.audioTrack === audioTrack);
    if (!selected) {
      const message = `audio_track_not_found:${audioTrack}`;
      await markSubtitleTrackPermanentFailure(archive.id, fileIndex, audioTrack, message);
      throw makePermanentSubtitleFailure(message);
    }
    return await ensureSubtitleTrackFromSource(archive, fileIndex, audioTrack, selected, fileName, sourcePath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureArchiveSubtitle(archive: ArchiveDoc, fileIndex: number, audioTrack = 0) {
  const key = subtitleTrackKey(archive.id, fileIndex, audioTrack);
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const promise = ensureSubtitleInternal(archive, fileIndex, audioTrack).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export async function listArchiveSubtitleTracks(archive: ArchiveDoc, fileIndex: number) {
  const file = archive.files?.[fileIndex];
  const fileName = file?.originalName || file?.name || "";
  if (!file || !supportsSubtitle(fileName, file.detectedKind)) {
    return [] as AudioTrackInfo[];
  }
  if (file.path && fs.existsSync(file.path)) {
    try {
      return await listAudioTracksFromFile(file.path);
    } catch {
      // fallback to stored metadata
    }
  }
  const tracks: AudioTrackInfo[] = [];
  if (file.subtitle && !file.subtitle?.failedAt) {
    tracks.push({
      audioTrack: 0,
      language: normalizeTrackLanguage(String(file.subtitle?.language || "auto")),
      label: "Track 1"
    });
  }
  const extra = Array.isArray((file as any).subtitleTracks) ? (file as any).subtitleTracks : [];
  for (const item of extra) {
    const audioTrack = Number(item?.audioTrack);
    if (!Number.isInteger(audioTrack) || audioTrack < 0) continue;
    tracks.push({
      audioTrack,
      language: normalizeTrackLanguage(String(item?.language || "auto")),
      label: String(item?.label || buildTrackLabel(audioTrack, item?.language, ""))
    });
  }
  const dedupedByTrack = new Map<number, AudioTrackInfo>();
  for (const track of tracks) {
    if (!dedupedByTrack.has(track.audioTrack)) {
      dedupedByTrack.set(track.audioTrack, track);
    }
  }
  const mergedTracks = Array.from(dedupedByTrack.values()).sort((a, b) => a.audioTrack - b.audioTrack);
  if (mergedTracks.length > 1) {
    return mergedTracks;
  }
  try {
    const probed = await probeAudioTracksFromArchive(archive, fileIndex, fileName);
    if (Array.isArray(probed) && probed.length > 0) {
      return probed.sort((a, b) => a.audioTrack - b.audioTrack);
    }
  } catch {
    // keep stored fallback if probe from archive is unavailable
  }
  return mergedTracks;
}
