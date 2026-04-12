# Offload Disk Server

Discord-backed storage server with encryption, chunking, web UI, share links, trash, quotas, and optional SMB.

## Project status
- Server is the primary product.
- Desktop client is considered archived/frozen.
- Recommended download flow: use direct links from the web UI.

## Features
- AES-256-GCM encryption.
- Chunked upload to Discord webhooks (default chunk limit ~9.8 MiB).
- Optional Telegram bot mirror storage (parallel with Discord) with background sync.
- MongoDB metadata storage (Discord stores file parts only).
- Folders, nested folders, trash (30 days), share links, priorities.
- Small-file preview (image/video/audio/text/code/pdf) with syntax highlighting for code, and image/video thumbnails.
- Automatic thumbnail generation from local upload cache during upload processing + background backfill for existing files.
- Streaming media preview endpoint (`Range`) for large audio/video files (no full browser download required for seek on non-bundle files).
- Automatic subtitles for audio/video preview (new uploads + background backfill), stored locally and mirrored to Discord/Telegram.
  - ASR upload path is normalized to compact `mp3` (mono/16k/64k) and sent with minimal multipart payload (`model` + `file` by default).
- Background workers for upload/delete jobs.
- Optional SMB 2/3 access via FUSE view.

## Quick start
1) Install dependencies:
```bash
npm install
```

2) Create config:
```bash
cp .env.example .env
```

3) Fill required values in `.env`:
- `MONGODB_URI`
- `SESSION_SECRET`
- `MASTER_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

4) Start:
```bash
npm run dev
```

Open `http://localhost:<PORT>`.

## Deploy/update (Docker)
One-line update/build/restart:
```bash
git pull && docker build -t offload-smb . && docker restart offload && docker logs -f offload
```

## Docker: sidecar Xray (VLESS) for Discord/Telegram only
This repo includes `docker-compose.proxy.yml` for 2-container setup:
- `offload` (server)
- `offload-xray` (local HTTP proxy over VLESS)

Setup:
1) Create Xray config from template:
```bash
cp deploy/xray/config.example.json deploy/xray/config.json
```
Fill `deploy/xray/config.json` with your VLESS params.

2) In `.env` set:
```env
OUTBOUND_PROXY_ENABLED=true
OUTBOUND_PROXY_URL=http://xray:10808
OUTBOUND_PROXY_FALLBACK_DIRECT=true
OUTBOUND_PROXY_BYPASS_MS=15000
```

3) Start:
```bash
docker compose -f docker-compose.proxy.yml up -d --build
```

4) Check logs:
```bash
docker compose -f docker-compose.proxy.yml logs -f offload
docker compose -f docker-compose.proxy.yml logs -f xray
```

## Monitoring stack on same server (Prometheus + Grafana + Loki + Promtail)
Monitoring runs in separate containers (not inside `offload`) via `docker-compose.monitoring.yml`.

### 1) Enable metrics in `.env`
```env
METRICS_ENABLED=true
METRICS_PATH=/metrics
METRICS_TOKEN=
```
If you set `METRICS_TOKEN`, Prometheus must call `/metrics?token=...` (or use `Authorization: Bearer`).

### 2) Start offload/xray (creates shared docker network `offload_net`)
```bash
docker compose -f docker-compose.proxy.yml up -d --build
```

### 3) Start monitoring stack
```bash
docker compose -f docker-compose.monitoring.yml up -d
```
Loki storage has a hard size cap of `5GB` (tmpfs-backed `loki_data` volume).
When this cap is reached, oldest logs are effectively dropped by pressure, and Loki data is not preserved across host reboot.

### 4) Open UIs
- Grafana: `http://SERVER_IP:3001` (default: `admin` / `admin`)
- Prometheus: `http://SERVER_IP:9090`
- Loki API: `http://SERVER_IP:3100`

### 4.1) Grafana first clicks (UI)
1. Open Grafana, login `admin/admin`, set a new password.
2. Left menu -> **Dashboards** -> **Manage**.
3. Open folder **Offload**.
4. Open dashboard **Offload Overview**.
5. Time range (top-right): set `Last 1 hour` (or your preferred range), refresh `5s`.
6. For logs: left menu -> **Explore** -> datasource `Loki`, query example:
   - `{container="offload"}`
   - `{container="offload-xray"}`
   - `{container="offload-promtail"}`
7. Prometheus targets check: `http://SERVER_IP:9090/targets` and ensure `offload` is `UP`.

### 5) Logs and status
```bash
docker compose -f docker-compose.monitoring.yml ps
docker compose -f docker-compose.monitoring.yml logs -f grafana
docker compose -f docker-compose.monitoring.yml logs -f prometheus
docker compose -f docker-compose.monitoring.yml logs -f promtail
docker compose -f docker-compose.monitoring.yml logs -f loki
```

## Download + resume behavior
- HTTP resume (Range) is implemented for `v2` non-bundle files.
- For bundle extraction routes, byte-range resume is not guaranteed.
- Use direct file links from the web UI.

## Recommended download client settings
- Connections per download: `4-8`
- Retry count: `10`
- Retry interval: `5s`
- Auto-resume unfinished downloads on startup: `ON`
- Do not force mirror search for local/private links

## Nginx reverse proxy (large uploads/downloads)
For large uploads through domain proxy, use:
- `client_max_body_size` large enough (for example `20G`)
- `proxy_request_buffering off`
- `proxy_buffering off`
- `proxy_read_timeout 600s`
- `proxy_send_timeout 600s`
- `proxy_force_ranges on`

## Admin bootstrap
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` are used only on first startup for initial admin creation.
- After first boot, change user passwords from admin panel/API, not from `.env`.

## Environment variables
Defaults are from `.env.example`.

### Server / DB / Auth
- `PORT` (`3000`) - HTTP port for the web/API server.
- `MONGODB_URI` - MongoDB connection string.
- `MONGODB_DB` (`cloud_storage`) - database name used by the app.
- `SESSION_SECRET` - cookie/session signing secret (change in production).
- `ADMIN_USERNAME` (`admin`) - bootstrap admin login (first startup).
- `ADMIN_PASSWORD` (`admin`) - bootstrap admin password (first startup).

### Redis (optional cache)
- `REDIS_ENABLED` (`false`) - enable Redis integration.
- `REDIS_URL` (empty) - full connection URL; if set, host/port/user/pass/db fields are ignored.
- `REDIS_HOST` (`127.0.0.1`) - Redis host for split config mode.
- `REDIS_PORT` (`6379`) - Redis port.
- `REDIS_USERNAME` (`offload`) - ACL username used for auth.
- `REDIS_PASSWORD` (empty) - ACL password used for auth.
- `REDIS_DB` (`0`) - logical DB index.
- `REDIS_KEY_PREFIX` (`offload`) - key prefix namespace.
- `REDIS_CACHE_TTL_SEC` (`8`) - TTL for API cache entries.

### Encryption
- `MASTER_KEY` - master key for archive part encryption/decryption. Losing it means data loss.

### Storage / cache / limits
- `CACHE_DIR` (`./data/cache`) - root for staging, restore, thumbs, subtitles, transcode temp/cache.
- `CACHE_DELETE_AFTER_UPLOAD` (`true`) - remove temp cache after archive is fully processed.
- `DISK_SOFT_LIMIT_GB` (`15`) - soft limit: app still works, but may throttle/degrade behavior.
- `DISK_HARD_LIMIT_GB` (`5`) - hard guard threshold used by internal disk checks.
- `STREAM_USE_DISK` (`false`) - stream pipeline mode toggle for upload internals.
- `DELETE_STAGING_AFTER_ENCRYPT` (`true`) - remove per-upload staging files after encryption phase.
- `SMB_UNLIMITED_BYTES` (`18000000000000`) - virtual SMB size exposed for unlimited users.

### Discord / chunking / upload
- `DISCORD_WEBHOOK_URL` - optional seed webhook used for bootstrap convenience.
- `DISCORD_WEBHOOK_MAX_MIB` (`9.8`) - max allowed part size for Discord uploads.
- `CHUNK_SIZE_MIB` (`9.8`) - encryption/upload chunk size (must be compatible with provider limits).
- `UPLOAD_PARTS_CONCURRENCY` (`2`) - concurrent part uploads per archive.
- `UPLOAD_RETRY_MAX` (`5`) - max retry attempts for upload operations.
- `UPLOAD_RETRY_BASE_MS` (`1500`) - initial retry delay.
- `UPLOAD_RETRY_MAX_MS` (`15000`) - upper bound for retry backoff delay.
- `UPLOAD_MAX_FILES` (`10000`) - per-request max number of files accepted by API.
- `UPLOAD_TMP_TTL_HOURS` (`6`) - TTL for unfinished browser upload temp dirs.
- `UPLOAD_TMP_CLEANUP_MINUTES` (`30`) - interval for temp upload cleanup pass.
- `STREAM_UPLOADS_ENABLED` (`false`) - enable streaming upload mode for large inbound uploads.
- `STREAM_SINGLE_MIN_MIB` (`8`) - minimum size where single-file streaming mode is considered.
- `PREVIEW_MAX_MIB` (`5`) - max size for non-stream media/text preview path.

### Bundling
- `BUNDLE_SINGLE_FILE_MIB` (`8`) - files bigger than this are stored as standalone archives.
- `BUNDLE_MAX_MIB` (`32`) - max estimated bundle size before splitting into multiple archives.

### Main worker / queue behavior
- `WORKER_POLL_MS` (`2000`) - main upload/delete worker tick interval.
- `WORKER_CONCURRENCY` (`1`) - number of concurrent main worker jobs.
- `PROCESSING_STALE_MIN` (`30`) - time after which stuck `processing` archives are reset/recovered.
- `UI_REFRESH_MS` (`5000`) - client polling interval for file list/status refresh.
- `UI_ETA_WINDOW_MS` (`120000`) - smoothing window for ETA/speed estimation.
- `UI_ETA_MAX_SAMPLES` (`30`) - max sample count used for ETA smoothing.

### Thumbnails
- `THUMBNAIL_SIZE_PX` (`320`) - output thumbnail side size target.
- `THUMBNAIL_QUALITY` (`76`) - output quality level for generated thumbnails.
- `THUMB_WORKER_ENABLED` (`true`) - enable thumbnail background worker.
- `THUMB_WORKER_CONCURRENCY` (`1`) - concurrent thumbnail jobs.
- `THUMB_WORKER_POLL_MS` (`5000`) - thumbnail worker tick interval.
- `THUMB_BACKFILL_SCAN_LIMIT` (`300`) - archives scanned per backfill tick.
- `THUMB_RETRY_MS` (`60000`) - retry delay after transient thumbnail errors.

### Selective outbound proxy (Discord/Telegram/API routing)
- `OUTBOUND_PROXY_ENABLED` (`false`) - enable selective outbound proxying.
- `OUTBOUND_PROXY_URL` (`http://127.0.0.1:10808`) - default proxy URL (HTTP proxy inbound).
- `OUTBOUND_PROXY_TARGETS` - comma-separated host suffixes routed via default proxy URL.
- `OUTBOUND_PROXY_ROUTES` - advanced per-target mapping, format: `targets=url;targets=url`.
- `OUTBOUND_PROXY_LOG_MATCHES` (`false`) - log every matched proxied host.
- `OUTBOUND_PROXY_FALLBACK_DIRECT` (`true`) - on proxy failure, temporarily use direct internet.
- `OUTBOUND_PROXY_BYPASS_MS` (`15000`) - direct-bypass TTL before trying proxy again.

### Telegram mirror
- `TELEGRAM_ENABLED` (`false`) - enable Telegram provider integration.
- `TELEGRAM_BOT_TOKEN` - bot token for Telegram API.
- `TELEGRAM_CHAT_ID` - chat/channel ID where parts are uploaded.
- `MIRROR_SYNC_CONCURRENCY` (`3`) - baseline parallelism for background mirror sync.
- `MIRROR_SYNC_CONCURRENCY_MIN` (`1`) - lower bound for auto-tuned mirror sync.
- `MIRROR_SYNC_CONCURRENCY_MAX` (`6`) - upper bound for auto-tuned mirror sync.
- `MIRROR_SYNC_AUTO_TUNE` (`true`) - dynamic concurrency tuning based on error/rate-limit behavior.

Mirror behavior summary:
- New part uploads race providers; first success becomes primary part source.
- If the second provider fails, mirror is marked pending and synced later in background.
- Old ready archives are also backfilled by mirror workers.

### Metrics / Prometheus
- `METRICS_ENABLED` (`true`) - expose Prometheus endpoint.
- `METRICS_PATH` (`/metrics`) - metrics endpoint path.
- `METRICS_TOKEN` (empty) - optional token; if set, scrape must include token or bearer auth.

### Subtitles
- `SUBTITLE_WORKER_ENABLED` (`true`) - enable subtitle background worker.
- `SUBTITLE_WORKER_CONCURRENCY` (`1`) - concurrent subtitle jobs.
- `SUBTITLE_WORKER_POLL_MS` (`7000`) - subtitle worker tick interval.
- `SUBTITLE_BACKFILL_SCAN_LIMIT` (`200`) - archives scanned per subtitle backfill tick.
- `SUBTITLE_RETRY_MS` (`120000`) - retry delay for transient subtitle failures.
- `SUBTITLE_LANGUAGE` (`auto`) - preferred language hint (`auto` = detect).

ASR provider:
- `SUBTITLE_ASR_ENABLED` (`false`) - enable HTTP ASR provider.
- `SUBTITLE_ASR_URL` (`https://api.openai.com/v1/audio/transcriptions`) - ASR endpoint.
- `SUBTITLE_ASR_MODEL` (`whisper-1`) - model name sent in multipart request.
- `SUBTITLE_ASR_API_KEY` - bearer token for ASR provider.
- `SUBTITLE_ASR_RESPONSE_FORMAT` (empty) - optional response format. For Whisper-compatible APIs, `verbose_json` is recommended; this server converts returned `segments` to timed subtitles locally. Avoid `srt`/`vtt` if provider does not support them reliably.
- `SUBTITLE_ASR_MAX_BYTES` (`25165824`) - max upload size per ASR request.
- `SUBTITLE_ASR_CHUNK_API_CONCURRENCY` (`0`) - parallel ASR chunk requests (`0` = no explicit limit, all chunks).
- `SUBTITLE_ASR_CHUNK_API_RETRIES` (`3`) - retries per ASR chunk before fallback.
- `SUBTITLE_ASR_CHUNK_API_RETRY_MS` (`2000`) - base delay for ASR chunk retry backoff.
- `SUBTITLE_ASR_PROMPT` (empty) - optional prompt sent to ASR provider.

Local fallback:
- `SUBTITLE_LOCAL_COMMAND` (empty) - fallback command template with `{input}` `{output}` `{lang}` placeholders.
- `SUBTITLE_PREFER_SOURCE` (`true`) - prefer local source file over remote restore when possible.
- Built-in Docker helper scripts:
  - `tools/subtitle_local.sh`
  - `tools/subtitle_local.py`
- Recommended command:
  - `SUBTITLE_LOCAL_COMMAND=bash /home/container/tools/subtitle_local.sh {input} {output} {lang}`
- Optional local model tuning:
  - `SUBTITLE_LOCAL_MODEL` (`small`)
  - `SUBTITLE_LOCAL_MODEL_DIR` (`/home/container/data/asr_models`)
  - `SUBTITLE_LOCAL_DEVICE` (`cpu`)
  - `SUBTITLE_LOCAL_COMPUTE_TYPE` (`int8`)

### Media preview compatibility hints
- `MEDIA_PREVIEW_VIDEO_CODECS` (`h264,hevc,vp9,av1,mpeg4,mjpeg,vp8,theora,prores`) - codec allowlist treated as browser-preview friendly.

### Transcoded copies
- `TRANSCODE_FORCE_ALL` (`true`) - if true, transcode all supported media; if false, skip already-compatible codecs.
- `TRANSCODE_WORKER_ENABLED` (`true`) - enable transcode backfill worker.
- `TRANSCODE_WORKER_CONCURRENCY` (`1`) - concurrent transcode jobs.
- `TRANSCODE_WORKER_POLL_MS` (`9000`) - transcode worker tick interval.
- `TRANSCODE_BACKFILL_SCAN_LIMIT` (`160`) - archives scanned per transcode backfill tick.
- `TRANSCODE_RETRY_MS` (`120000`) - retry delay for transient transcode errors.
- `TRANSCODE_VIDEO_CRF` (`23`) - ffmpeg quality target for video transcode.
- `TRANSCODE_VIDEO_PRESET` (`veryfast`) - ffmpeg speed/quality preset.
- `TRANSCODE_AUDIO_BITRATE_KBPS` (`160`) - audio bitrate for converted copies.
- `TRANSCODE_SKIP_VIDEO_EXT` (empty) - comma list of video extensions to never transcode.
- `TRANSCODE_SKIP_AUDIO_EXT` (empty) - comma list of audio extensions to never transcode.
- `TRANSCODE_COMPATIBLE_VIDEO_CODECS` (`h264,hevc,av1,vp9`) - codec set considered compatible.
- `TRANSCODE_COMPATIBLE_AUDIO_CODECS` (`aac,mp3,opus,vorbis,flac`) - codec set considered compatible.

### SMB
- `SMB_ENABLED` (`false`) - enable SMB service.
- `SMB_PORT` (`445`) - SMB TCP port.
- `SMB_SHARE_NAME` (`offload`) - visible share name.
- `SMB_MOUNT` (`/home/container/offload_mount`) - internal FUSE mount path exposed via Samba.

## SMB notes
- SMB users sync from app users (same login/password).
- Unlimited users are exposed as fixed virtual disk size in SMB.
- Container needs FUSE and Samba runtime.
- Typical Docker flags:
  - `--device /dev/fuse`
  - `--cap-add SYS_ADMIN`
  - `--cap-add NET_BIND_SERVICE`
  - `--security-opt apparmor:unconfined`

## Scripts
- `npm run dev` - dev server
- `npm run build` - TypeScript build
- `npm run start` - run built server

## Security notes
- Never commit `.env`.
- `MASTER_KEY` is mandatory to decrypt data; losing it means data loss.
- Discord webhook URLs are intentionally stored in MongoDB as plain text.
