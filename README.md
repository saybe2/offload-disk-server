# Offload Disk

Discord-backed cloud storage with encryption, chunking, web UI, folders, trash, sharing, and background uploads.

## Features
- Upload files (single or bundle) with encryption and chunking
- Background upload to Discord via webhook pool
- Streaming downloads (single files or bundles)
- Folders + trash (30-day retention) + priorities
- Shared links with optional expiration
- Admin UI for users and webhooks

## Requirements
- Node.js 20+ (22 works)
- MongoDB

## Setup
1) Install dependencies
```
npm install
```

2) Create `.env`
Example:
```
MONGODB_URI=mongodb://USER:PASS@HOST:27017/?directConnection=true
MONGODB_DB=cloud_storage
SESSION_SECRET=change-me
MASTER_KEY=change-me
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

3) Run
```
npm run dev
```

## Scripts
- `npm run dev` – start dev server
- `npm run build` – build TypeScript
- `npm run start` – run built server

## Stop server (Windows)
```
powershell -ExecutionPolicy Bypass -File tools\stop_server.ps1
```

## Notes
- Discord file size limit is controlled by `DISCORD_WEBHOOK_MAX_MIB` (default 9.8 MiB).
- Chunk size is `CHUNK_SIZE_MIB` (default 9.8 MiB).
- Bundle behavior:
  - `BUNDLE_SINGLE_FILE_MIB` (default 8) => files >= this go to their own archive
  - `BUNDLE_MAX_MIB` (default 32) => max size of a bundle of small files
- Deletions are delayed: files go to trash, then are deleted after 30 days or on manual purge.

## Security
- Keep `.env` private.
- Webhook URLs are stored in DB (unencrypted) by design.
