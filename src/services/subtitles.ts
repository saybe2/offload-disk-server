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
const SUBTITLE_PERMANENT_PREFIX = "subtitle_permanent_failure:";

export interface SubtitleResult {
  filePath: string;
  contentType: string;
  size: number;
  language: string;
}

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

function subtitleTargetPath(archiveId: string, fileIndex: number) {
  return path.join(config.cacheDir, "subtitles", `${archiveId}_${fileIndex}.vtt`);
}

async function ensureSubtitleDir() {
  await fs.promises.mkdir(path.join(config.cacheDir, "subtitles"), { recursive: true });
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

async function transcribeViaOpenAi(inputPath: string, sourceName: string) {
  if (!config.subtitleAsrEnabled || !config.subtitleAsrApiKey || !config.subtitleAsrModel) {
    throw new Error("subtitle_provider_not_configured");
  }
  const stat = await fs.promises.stat(inputPath);
  log("subtitle", `asr start file=${path.basename(sourceName || inputPath)} size=${stat.size}`);
  if (stat.size > config.subtitleAsrMaxBytes && !config.subtitleLocalCommand) {
    throw new Error("subtitle_source_too_large_for_asr");
  }

  const form = new FormData();
  form.append("model", config.subtitleAsrModel);
  form.append("response_format", "vtt");
  if (config.subtitleLanguage && config.subtitleLanguage !== "auto") {
    form.append("language", config.subtitleLanguage);
  }
  if (config.subtitleAsrPrompt) {
    form.append("prompt", config.subtitleAsrPrompt);
  }
  const fileBuffer = await fs.promises.readFile(inputPath);
  form.append("file", new File([fileBuffer], path.basename(sourceName || inputPath)));

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
  log("subtitle", `asr done file=${path.basename(sourceName || inputPath)} size=${stat.size}`);

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

async function transcribeViaLocalCommand(inputPath: string, outputPath: string) {
  if (!config.subtitleLocalCommand) {
    throw new Error("subtitle_local_command_not_configured");
  }
  const command = config.subtitleLocalCommand
    .replaceAll("{input}", shellEscape(inputPath))
    .replaceAll("{output}", shellEscape(outputPath))
    .replaceAll("{lang}", shellEscape(config.subtitleLanguage || "auto"));
  log("subtitle", `local start file=${path.basename(inputPath)}`);
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
}

async function generateSubtitleVtt(sourcePath: string, fileName: string, outputPath: string) {
  let raw = "";
  const failures: string[] = [];

  if (config.subtitleAsrEnabled) {
    try {
      raw = await transcribeViaOpenAi(sourcePath, fileName);
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

async function persistSubtitleMeta(archiveId: string, fileIndex: number, localPath: string): Promise<SubtitleResult> {
  const stat = await fs.promises.stat(localPath);
  const backup = await uploadSubtitleBackup(archiveId, fileIndex, localPath);
  const language = config.subtitleLanguage || "auto";
  const primary = backup ? toProviderDoc(backup.primary) : null;
  const mirror = backup?.mirrorCopy ? toProviderDoc(backup.mirrorCopy) : null;

  await Archive.updateOne(
    { _id: archiveId },
    {
      $set: {
        [`files.${fileIndex}.subtitle.contentType`]: "text/vtt; charset=utf-8",
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

  return {
    filePath: localPath,
    contentType: "text/vtt; charset=utf-8",
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
  localPath: string
) {
  try {
    await generateSubtitleVtt(sourcePath, fileName, localPath);
  } catch (err) {
    const message = toMessage(err);
    if (isPermanentSubtitleFailureMessage(message)) {
      await markSubtitlePermanentFailure(archive.id, fileIndex, message);
      throw makePermanentSubtitleFailure(message);
    }
    throw err;
  }
  return persistSubtitleMeta(archive.id, fileIndex, localPath);
}

export async function ensureArchiveSubtitleFromSource(archive: ArchiveDoc, fileIndex: number) {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  if (file.subtitle?.failedAt) {
    throw makePermanentSubtitleFailure(file.subtitle.error || "marked_failed");
  }
  const fileName = (file.originalName || file.name || "").trim();
  if (!supportsSubtitle(fileName, file.detectedKind)) {
    throw new Error("subtitle_unsupported");
  }
  if (!file.path || !fs.existsSync(file.path)) {
    throw new Error("source_missing");
  }
  await ensureSubtitleDir();
  const localPath = subtitleTargetPath(archive.id, fileIndex);
  if (fs.existsSync(localPath)) {
    const stat = await fs.promises.stat(localPath);
    return {
      filePath: localPath,
      contentType: "text/vtt; charset=utf-8",
      size: stat.size,
      language: file.subtitle?.language || config.subtitleLanguage || "auto"
    };
  }
  return generateSubtitleUsingSource(archive, fileIndex, fileName, file.path, localPath);
}

async function ensureSubtitleInternal(archive: ArchiveDoc, fileIndex: number): Promise<SubtitleResult> {
  const file = archive.files?.[fileIndex];
  if (!file) {
    throw new Error("file_not_found");
  }
  if (file.subtitle?.failedAt) {
    throw makePermanentSubtitleFailure(file.subtitle.error || "marked_failed");
  }

  const fileName = (file.originalName || file.name || "").trim();
  if (!supportsSubtitle(fileName, file.detectedKind)) {
    throw new Error("subtitle_unsupported");
  }

  await ensureSubtitleDir();
  const localPath = subtitleTargetPath(archive.id, fileIndex);
  if (fs.existsSync(localPath)) {
    const stat = await fs.promises.stat(localPath);
    return {
      filePath: localPath,
      contentType: "text/vtt; charset=utf-8",
      size: stat.size,
      language: file.subtitle?.language || config.subtitleLanguage || "auto"
    };
  }

  if (file.path && fs.existsSync(file.path) && config.subtitlePreferSource) {
    try {
      return await generateSubtitleUsingSource(archive, fileIndex, fileName, file.path, localPath);
    } catch (err) {
      if (isPermanentSubtitleFailureMessage(toMessage(err))) {
        throw err;
      }
      // fallback to remote restore
    }
  }

  if (await tryRestoreSubtitleFromRemote(archive, fileIndex, localPath)) {
    const stat = await fs.promises.stat(localPath);
    return {
      filePath: localPath,
      contentType: "text/vtt; charset=utf-8",
      size: stat.size,
      language: file.subtitle?.language || config.subtitleLanguage || "auto"
    };
  }

  if (file.path && fs.existsSync(file.path)) {
    return generateSubtitleUsingSource(archive, fileIndex, fileName, file.path, localPath);
  }

  const tempDir = path.join(
    config.cacheDir,
    "subtitle_work",
    `${archive.id}_${fileIndex}_${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.promises.mkdir(tempDir, { recursive: true });
  const sourcePath = path.join(tempDir, file.name || `${fileIndex}_${Date.now()}`);
  try {
    if (archive.isBundle) {
      await restoreArchiveFileToFile(archive, fileIndex, sourcePath, config.cacheDir, config.masterKey);
    } else {
      await restoreArchiveToFile(archive, sourcePath, config.cacheDir, config.masterKey);
    }
    return await generateSubtitleUsingSource(archive, fileIndex, fileName, sourcePath, localPath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureArchiveSubtitle(archive: ArchiveDoc, fileIndex: number) {
  const key = `${archive.id}:${fileIndex}`;
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const promise = ensureSubtitleInternal(archive, fileIndex).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
