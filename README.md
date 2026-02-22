# Offload Disk Server

Discord-backed storage server with encryption, chunking, web UI, share links, trash, quotas, and optional SMB.

## Project status
- Server is the primary product.
- Desktop client is considered archived/frozen.
- Recommended download flow: web UI links + Free Download Manager (FDM).

## Features
- AES-256-GCM encryption.
- Chunked upload to Discord webhooks (default chunk limit ~9.8 MiB).
- MongoDB metadata storage (Discord stores file parts only).
- Folders, nested folders, trash (30 days), share links, priorities.
- Small-file preview (image/video/audio/text/code/pdf) with syntax highlighting for code, and image/video thumbnails.
- Automatic thumbnail generation from local upload cache during upload processing + background backfill for existing files.
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

## Download + resume behavior
- HTTP resume (Range) is implemented for `v2` non-bundle files.
- For bundle extraction routes, byte-range resume is not guaranteed.
- FDM should use direct file links from the web UI.

## Recommended FDM settings
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
Core:
- `PORT`
- `MONGODB_URI`
- `MONGODB_DB`
- `SESSION_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `MASTER_KEY`

Discord/chunking:
- `DISCORD_WEBHOOK_URL` (optional seed webhook, first run only)
- `DISCORD_WEBHOOK_MAX_MIB`
- `CHUNK_SIZE_MIB`
- `UPLOAD_PARTS_CONCURRENCY`
- `UPLOAD_RETRY_MAX`
- `UPLOAD_RETRY_BASE_MS`
- `UPLOAD_RETRY_MAX_MS`

Bundling:
- `BUNDLE_SINGLE_FILE_MIB`
- `BUNDLE_MAX_MIB`

Cache/disk:
- `CACHE_DIR`
- `CACHE_DELETE_AFTER_UPLOAD`
- `STREAM_USE_DISK`
- `DISK_SOFT_LIMIT_GB`
- `DISK_HARD_LIMIT_GB`
- `PREVIEW_MAX_MIB`
- `THUMBNAIL_SIZE_PX`
- `THUMBNAIL_QUALITY`
- `THUMB_WORKER_ENABLED`
- `THUMB_WORKER_CONCURRENCY`
- `THUMB_WORKER_POLL_MS`
- `THUMB_BACKFILL_SCAN_LIMIT`
- `THUMB_RETRY_MS`

Worker:
- `WORKER_CONCURRENCY`
- `WORKER_POLL_MS`
- `PROCESSING_STALE_MIN`

SMB:
- `SMB_ENABLED`
- `SMB_PORT`
- `SMB_SHARE_NAME`
- `SMB_MOUNT`

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
