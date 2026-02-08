# Offload Disk Server

Discord-backed storage with encryption, chunking, web UI, sharing, and optional SMB access.

## What it does
- Encrypts files (AES-256-GCM), chunks them, and uploads to Discord webhooks.
- Stores metadata in MongoDB (files themselves live in Discord).
- Web UI for uploads, folders, trash (30 days), sharing, and priorities.
- Background workers for upload and delete queues.
- Optional SMB share (read/write) backed by a FUSE view of your files.

## Quick start (local)
1) Install deps
```
npm install
```

2) Create .env
```
cp .env.example .env
```
Set at least:
- MONGODB_URI
- SESSION_SECRET
- MASTER_KEY
- ADMIN_USERNAME / ADMIN_PASSWORD
- DISCORD_WEBHOOK_URL (optional seed)

3) Run
```
npm run dev
```
Open http://localhost:PORT

## Admin bootstrap
ADMIN_USERNAME and ADMIN_PASSWORD are only used on first boot to create the initial admin user.
If the admin already exists, changing .env will NOT change the password. Use the admin panel to update users.

## Environment variables
Core:
- PORT: HTTP port (default 3000)
- MONGODB_URI: Mongo connection string
- MONGODB_DB: Database name
- SESSION_SECRET: Express session secret
- ADMIN_USERNAME / ADMIN_PASSWORD: bootstrap admin credentials
- MASTER_KEY: encryption key seed (any strong random string)
- MASTER_KEY_EXPORT: set true to allow the client app to fetch the key after login

Discord / chunking:
- DISCORD_WEBHOOK_URL: optional seed webhook (first run only)
- DISCORD_WEBHOOK_MAX_MIB: max upload size per webhook message (default 9.8)
- CHUNK_SIZE_MIB: chunk size for uploads (default 9.8)
- UPLOAD_PARTS_CONCURRENCY: parallel uploads per archive
- UPLOAD_RETRY_MAX / UPLOAD_RETRY_BASE_MS / UPLOAD_RETRY_MAX_MS: retry policy

Bundles:
- BUNDLE_SINGLE_FILE_MIB: files >= this go into their own archive
- BUNDLE_MAX_MIB: max size of a small-file bundle

Cache / disk:
- CACHE_DIR: where staging/work files live
- CACHE_DELETE_AFTER_UPLOAD: delete staging/work after upload
- STREAM_USE_DISK: when true, stream uploads are also written to disk
- DISK_SOFT_LIMIT_GB: below this free space, workers slow down
- DISK_HARD_LIMIT_GB: below this free space, uploads are rejected

Worker:
- WORKER_CONCURRENCY: number of archives processed in parallel
- WORKER_POLL_MS: worker loop interval
- PROCESSING_STALE_MIN: reset stuck processing jobs after this time

SMB:
- SMB_ENABLED: enable FUSE + SMB share
- SMB_PORT: SMB port (use 445 for Windows default)
- SMB_SHARE_NAME: share name (default offload)
- SMB_MOUNT: FUSE mount path inside container

## SMB notes
- SMB users are synced from app users (same username/password).
- Unlimited quota is reported as 18 TB (18e12 bytes) in SMB views.
- Requires /dev/fuse and smbd in the runtime image.
- Typical Docker run needs:
  - --device /dev/fuse
  - --cap-add SYS_ADMIN
  - --cap-add NET_BIND_SERVICE
  - --security-opt apparmor:unconfined

## Scripts
- npm run dev: start dev server
- npm run build: build TypeScript
- npm run start: run built server

## Security
- Keep .env private.
- MASTER_KEY is required to decrypt files. If it is lost, files cannot be restored.
- Webhook URLs are stored unencrypted in MongoDB by design.
