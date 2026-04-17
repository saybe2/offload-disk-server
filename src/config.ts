import dotenv from "dotenv";
import path from "path";

dotenv.config();

const toNumber = (value: string | undefined, fallback: number) => {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const toList = (value: string | undefined, fallback: string[]) => {
  if (!value || !value.trim()) return fallback;
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
};

type ProxyRouteConfig = {
  targets: string[];
  proxyUrl: string;
};

const parseProxyRoutes = (value: string | undefined): ProxyRouteConfig[] => {
  if (!value || !value.trim()) return [];
  const routes: ProxyRouteConfig[] = [];
  for (const chunk of value.split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq >= trimmed.length - 1) continue;
    const targetsRaw = trimmed.slice(0, eq).trim();
    const proxyUrl = trimmed.slice(eq + 1).trim();
    if (!targetsRaw || !proxyUrl) continue;
    const targets = targetsRaw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (targets.length === 0) continue;
    routes.push({ targets, proxyUrl });
  }
  return routes;
};

const defaultProxyTargets = [
  "discord.com",
  "discordapp.com",
  "discordapp.net",
  "discordcdn.com",
  "telegram.org",
  "t.me",
  "telegra.ph",
  "telegram-cdn.org"
];

const defaultSubtitleVideoCodecs = ["h264", "hevc", "vp9", "av1", "mpeg4", "mjpeg", "vp8", "theora", "prores"];
const defaultTranscodeSkipVideoExt: string[] = [];
const defaultTranscodeSkipAudioExt: string[] = [];
const defaultTranscodeCompatibleVideoCodecs = ["h264", "hevc", "av1", "vp9"];
const defaultTranscodeCompatibleAudioCodecs = ["aac", "mp3", "opus", "vorbis", "flac"];

export const config = {
  port: toNumber(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGODB_DB || "cloud_storage",
  redisEnabled: (process.env.REDIS_ENABLED || "false") === "true",
  redisUrl: (process.env.REDIS_URL || "").trim(),
  redisHost: (process.env.REDIS_HOST || "").trim(),
  redisPort: Math.max(1, toNumber(process.env.REDIS_PORT, 6379)),
  redisUsername: (process.env.REDIS_USERNAME || "").trim(),
  redisPassword: (process.env.REDIS_PASSWORD || "").trim(),
  redisDb: Math.max(0, toNumber(process.env.REDIS_DB, 0)),
  redisKeyPrefix: (process.env.REDIS_KEY_PREFIX || "offload").trim(),
  redisCacheTtlSec: Math.max(1, toNumber(process.env.REDIS_CACHE_TTL_SEC, 8)),
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
  uploadRetryMaxMs: toNumber(process.env.UPLOAD_RETRY_MAX_MS, 15000),
  uploadMaxFiles: toNumber(process.env.UPLOAD_MAX_FILES, 10000),
  uploadTmpTtlHours: toNumber(process.env.UPLOAD_TMP_TTL_HOURS, 6),
  uploadTmpCleanupMinutes: toNumber(process.env.UPLOAD_TMP_CLEANUP_MINUTES, 30),
  streamUseDisk: (process.env.STREAM_USE_DISK || "false") === "true",
  deleteStagingAfterEncrypt: (process.env.DELETE_STAGING_AFTER_ENCRYPT || "true") === "true",
  previewMaxMiB: toNumber(process.env.PREVIEW_MAX_MIB, 5),
  thumbnailSizePx: toNumber(process.env.THUMBNAIL_SIZE_PX, 320),
  thumbnailQuality: toNumber(process.env.THUMBNAIL_QUALITY, 76),
  thumbWorkerEnabled: (process.env.THUMB_WORKER_ENABLED || "true") === "true",
  thumbWorkerConcurrency: Math.max(1, toNumber(process.env.THUMB_WORKER_CONCURRENCY, 1)),
  thumbWorkerPollMs: Math.max(1000, toNumber(process.env.THUMB_WORKER_POLL_MS, 5000)),
  thumbBackfillScanLimit: Math.max(20, toNumber(process.env.THUMB_BACKFILL_SCAN_LIMIT, 300)),
  thumbRetryMs: Math.max(5000, toNumber(process.env.THUMB_RETRY_MS, 60000)),
  streamUploadsEnabled: (process.env.STREAM_UPLOADS_ENABLED || "false") === "true",
  streamSingleMinMiB: toNumber(process.env.STREAM_SINGLE_MIN_MIB, 8),
  uiRefreshMs: toNumber(process.env.UI_REFRESH_MS, 5000),
  uiEtaWindowMs: toNumber(process.env.UI_ETA_WINDOW_MS, 120000),
  uiEtaMaxSamples: toNumber(process.env.UI_ETA_MAX_SAMPLES, 30),
  uiArchivesPageSize: Math.max(40, Math.min(500, toNumber(process.env.UI_ARCHIVES_PAGE_SIZE, 160))),
  outboundProxyEnabled: (process.env.OUTBOUND_PROXY_ENABLED || "false") === "true",
  outboundProxyUrl: (process.env.OUTBOUND_PROXY_URL || "").trim(),
  outboundProxyTargets: toList(process.env.OUTBOUND_PROXY_TARGETS, defaultProxyTargets),
  outboundProxyRoutes: parseProxyRoutes(process.env.OUTBOUND_PROXY_ROUTES),
  outboundProxyLogMatches: (process.env.OUTBOUND_PROXY_LOG_MATCHES || "false") === "true",
  outboundProxyFallbackDirect: (process.env.OUTBOUND_PROXY_FALLBACK_DIRECT || "true") === "true",
  outboundProxyBypassMs: Math.max(1000, toNumber(process.env.OUTBOUND_PROXY_BYPASS_MS, 15000)),
  telegramEnabled: (process.env.TELEGRAM_ENABLED || "false") === "true",
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  telegramChatId: (process.env.TELEGRAM_CHAT_ID || "").trim(),
  mirrorSyncConcurrency: Math.max(1, toNumber(process.env.MIRROR_SYNC_CONCURRENCY, 3)),
  mirrorSyncConcurrencyMin: Math.max(1, toNumber(process.env.MIRROR_SYNC_CONCURRENCY_MIN, 1)),
  mirrorSyncConcurrencyMax: Math.max(1, toNumber(process.env.MIRROR_SYNC_CONCURRENCY_MAX, 6)),
  mirrorSyncAutoTune: (process.env.MIRROR_SYNC_AUTO_TUNE || "true") === "true",
  metricsEnabled: (process.env.METRICS_ENABLED || "true") === "true",
  metricsPath: (process.env.METRICS_PATH || "/metrics").trim() || "/metrics",
  metricsToken: (process.env.METRICS_TOKEN || "").trim(),
  subtitleWorkerEnabled: (process.env.SUBTITLE_WORKER_ENABLED || "true") === "true",
  subtitleWorkerConcurrency: Math.max(1, toNumber(process.env.SUBTITLE_WORKER_CONCURRENCY, 1)),
  subtitleWorkerPollMs: Math.max(1000, toNumber(process.env.SUBTITLE_WORKER_POLL_MS, 7000)),
  subtitleBackfillScanLimit: Math.max(20, toNumber(process.env.SUBTITLE_BACKFILL_SCAN_LIMIT, 200)),
  subtitleRetryMs: Math.max(5000, toNumber(process.env.SUBTITLE_RETRY_MS, 120000)),
  subtitleLanguage: (process.env.SUBTITLE_LANGUAGE || "auto").trim() || "auto",
  subtitleAsrEnabled: (process.env.SUBTITLE_ASR_ENABLED || "false") === "true",
  subtitleAsrUrl: (process.env.SUBTITLE_ASR_URL || "https://api.openai.com/v1/audio/transcriptions").trim(),
  subtitleAsrModel: (process.env.SUBTITLE_ASR_MODEL || "whisper-1").trim(),
  subtitleAsrApiKey: (process.env.SUBTITLE_ASR_API_KEY || "").trim(),
  subtitleAsrResponseFormat: (process.env.SUBTITLE_ASR_RESPONSE_FORMAT || "").trim(),
  subtitleAsrMaxBytes: Math.max(1024 * 1024, toNumber(process.env.SUBTITLE_ASR_MAX_BYTES, 24 * 1024 * 1024)),
  subtitleAsrChunkApiConcurrency: Math.max(0, toNumber(process.env.SUBTITLE_ASR_CHUNK_API_CONCURRENCY, 0)),
  subtitleAsrChunkApiRetries: Math.max(1, toNumber(process.env.SUBTITLE_ASR_CHUNK_API_RETRIES, 3)),
  subtitleAsrChunkApiRetryMs: Math.max(250, toNumber(process.env.SUBTITLE_ASR_CHUNK_API_RETRY_MS, 2000)),
  subtitleAsrPrompt: (process.env.SUBTITLE_ASR_PROMPT || "").trim(),
  subtitleLocalCommand: (process.env.SUBTITLE_LOCAL_COMMAND || "").trim(),
  subtitlePreferSource: (process.env.SUBTITLE_PREFER_SOURCE || "true") === "true",
  transcodeWorkerEnabled: (process.env.TRANSCODE_WORKER_ENABLED || "true") === "true",
  transcodeWorkerConcurrency: Math.max(1, toNumber(process.env.TRANSCODE_WORKER_CONCURRENCY, 1)),
  transcodeWorkerPollMs: Math.max(1000, toNumber(process.env.TRANSCODE_WORKER_POLL_MS, 9000)),
  transcodeBackfillScanLimit: Math.max(20, toNumber(process.env.TRANSCODE_BACKFILL_SCAN_LIMIT, 160)),
  transcodeRetryMs: Math.max(5000, toNumber(process.env.TRANSCODE_RETRY_MS, 120000)),
  transcodeForceAll: (process.env.TRANSCODE_FORCE_ALL || "true") === "true",
  transcodeVideoCrf: Math.max(16, Math.min(32, toNumber(process.env.TRANSCODE_VIDEO_CRF, 23))),
  transcodeVideoPreset: (process.env.TRANSCODE_VIDEO_PRESET || "veryfast").trim() || "veryfast",
  transcodeAudioBitrateKbps: Math.max(64, toNumber(process.env.TRANSCODE_AUDIO_BITRATE_KBPS, 160)),
  transcodeSkipVideoExt: toList(process.env.TRANSCODE_SKIP_VIDEO_EXT, defaultTranscodeSkipVideoExt),
  transcodeSkipAudioExt: toList(process.env.TRANSCODE_SKIP_AUDIO_EXT, defaultTranscodeSkipAudioExt),
  transcodeCompatibleVideoCodecs: toList(process.env.TRANSCODE_COMPATIBLE_VIDEO_CODECS, defaultTranscodeCompatibleVideoCodecs),
  transcodeCompatibleAudioCodecs: toList(process.env.TRANSCODE_COMPATIBLE_AUDIO_CODECS, defaultTranscodeCompatibleAudioCodecs),
  mediaPreviewVideoCodecs: toList(process.env.MEDIA_PREVIEW_VIDEO_CODECS, defaultSubtitleVideoCodecs),
  smbEnabled: (process.env.SMB_ENABLED || "false") === "true",
  smbMount: process.env.SMB_MOUNT || "/home/container/offload_mount",
  smbShareName: process.env.SMB_SHARE_NAME || "offload",
  smbUnlimitedBytes: toNumber(process.env.SMB_UNLIMITED_BYTES, 18 * 1000 * 1000 * 1000 * 1000)
};

const safeChunkMiB = Math.min(config.chunkSizeMiB, config.webhookMaxMiB);

export const computed = {
  chunkSizeBytes: Math.floor(safeChunkMiB * 1024 * 1024),
  webhookMaxBytes: Math.floor(config.webhookMaxMiB * 1024 * 1024),
  bundleMaxBytes: Math.floor(config.bundleMaxMiB * 1024 * 1024),
  bundleSingleFileBytes: Math.floor(config.bundleSingleFileMiB * 1024 * 1024)
};
