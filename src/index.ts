import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import { connectDb } from "./db.js";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { adminRouter } from "./routes/admin.js";
import { publicRouter } from "./routes/public.js";
import { startWorker } from "./services/worker.js";
import { User } from "./models/User.js";
import { Setting } from "./models/Setting.js";
import { Webhook } from "./models/Webhook.js";
import { log } from "./logger.js";
import { Archive } from "./models/Archive.js";
import { Folder } from "./models/Folder.js";
import { uniqueParts } from "./services/parts.js";
import { startFuse } from "./smb/fuse.js";
import { startCacheCleanup } from "./services/cleanup.js";
import { startThumbnailWorker } from "./services/thumbnailWorker.js";
import { startSubtitleWorker } from "./services/subtitleWorker.js";
import { startTranscodeWorker } from "./services/transcodeWorker.js";
import { getOutboundProxyStatus } from "./services/outbound.js";
import { initMirrorSyncControl } from "./services/mirrorSyncControl.js";
import { getPrometheusContentType, getPrometheusMetrics } from "./services/metrics.js";
import { initAnalyticsPersistence } from "./services/analytics.js";
import { initRealtimeServer } from "./services/realtime.js";
import { bumpCacheVersion, getRedisRuntimeState, startRedis } from "./services/redis.js";

function isMongoTransientRuntimeError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || "");
  const stack = err instanceof Error ? err.stack || "" : "";
  const name = err && typeof err === "object" ? String((err as any).name || "") : "";
  const source = `${name} ${message} ${stack}`.toLowerCase();
  const looksMongo = /mongo|mongodb|mongoose|connect-mongo|27017/.test(source);
  if (!looksMongo) return false;
  return (
    /econnrefused/.test(source) ||
    /connection <monitor>.*closed/.test(source) ||
    /server selection timed out/.test(source) ||
    /timed out while checking out a connection/.test(source) ||
    /topology.*(closed|destroyed)/.test(source) ||
    /pool.*closed/.test(source) ||
    /not connected/.test(source)
  );
}

process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack || "" : "";
  if (/invalid signature: 0x/i.test(message) && /unzipper\/lib\/parse\.js/i.test(stack)) {
    log("restore", `zip parse guard ${message}`);
    return;
  }
  if (isMongoTransientRuntimeError(err)) {
    log("db", `transient runtime connection failure ${message}`);
    return;
  }
  if (/Archive validation failed: .*files\.\d+\.path: Path `path` is required\./i.test(message)) {
    log("server", `archive path validation guard ${message}`);
    return;
  }
  log("server", `uncaught exception ${message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (isMongoTransientRuntimeError(reason)) {
    log("db", `transient runtime rejection ${message}`);
    return;
  }
  log("server", `unhandled rejection ${message}`);
});

const app = express();

// Trust the first proxy hop (e.g. nginx) so secure cookies and rate-limit
// see the real client protocol/IP via X-Forwarded-* headers.
app.set("trust proxy", 1);

app.use((req, _res, next) => {
  req.on("error", (err) => {
    if ((err as Error)?.message === "aborted") return;
    log("server", `request error ${err instanceof Error ? err.message : err}`);
  });
  next();
});

// Default limit kept tight to reduce DoS surface; specific routes that need
// larger JSON payloads (e.g. archives/import-external for migration) opt in
// to a higher limit at the route level via express.json({ limit: ... }).
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", (req, res, next) => {
  const method = String(req.method || "").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!mutating) {
    return next();
  }
  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 400) {
      void bumpCacheVersion();
    }
  });
  next();
});

const sessionStore = MongoStore.create({ mongoUrl: config.mongoUri, dbName: config.mongoDb });
sessionStore.on("error", (err) => {
  const message = err instanceof Error ? err.message : String(err || "");
  log("db", `session store error ${message}`);
});

const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    // "auto" => Secure flag is set when the request was made over HTTPS
    // (works behind nginx via trust proxy and over plain HTTP on LAN)
    secure: "auto",
    maxAge: 90 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

app.get("/api/ui-config", (_req, res) => {
  res.json({
    streamUploadsEnabled: config.streamUploadsEnabled,
    streamSingleMinMiB: config.streamSingleMinMiB,
    previewMaxMiB: config.previewMaxMiB,
    refreshMs: config.uiRefreshMs,
    etaWindowMs: config.uiEtaWindowMs,
    etaMaxSamples: config.uiEtaMaxSamples,
    archivesPageSize: config.uiArchivesPageSize
  });
});

if (config.metricsEnabled) {
  app.get(config.metricsPath, async (req, res) => {
    const token = config.metricsToken;
    if (token) {
      const auth = String(req.headers.authorization || "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const queryToken = String(req.query.token || "");
      if (bearer !== token && queryToken !== token) {
        return res.status(403).send("forbidden");
      }
    }
    const metrics = await getPrometheusMetrics();
    res.setHeader("Content-Type", getPrometheusContentType());
    return res.send(metrics);
  });
}

const publicDir = path.resolve("public");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.sendFile(path.join(publicDir, "app.html"));
  }
  return res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/admin", (req, res) => {
  if (req.session.role !== "admin") {
    return res.status(403).send("forbidden");
  }
  return res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/share/:token", (_req, res) => {
  return res.sendFile(path.join(publicDir, "share.html"));
});

app.use("/api/auth", authRouter);
app.use("/api", apiRouter);
app.use("/api/admin", adminRouter);
app.use(publicRouter);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === "object" ? (err as any).code : undefined;
  if (message === "aborted" || code === "ECONNRESET") {
    return;
  }
  log("server", `error ${message}`);
  if (!res.headersSent) {
    res.status(500).send("server_error");
  }
});

async function ensureAdminUser() {
  const existing = await User.findOne({ username: config.adminUsername });
  if (existing) return;
  const hash = await bcrypt.hash(config.adminPassword, 10);
  await User.create({
    username: config.adminUsername,
    passwordHash: hash,
    role: "admin",
    quotaBytes: 0,
    usedBytes: 0,
    transcodeCopiesEnabled: true
  });
}

async function ensureMasterKey() {
  const key = await Setting.findOne({ key: "master_key" });
  if (!key) {
    await Setting.create({ key: "master_key", value: config.masterKey });
  }
}

async function ensureWebhookSeed() {
  const count = await Webhook.countDocuments();
  const seedUrl = process.env.DISCORD_WEBHOOK_URL;
  if (count === 0 && seedUrl) {
    await Webhook.create({ url: seedUrl, enabled: true });
  }
}

async function migrateArchives() {
  const cursor = Archive.find({
    $or: [
      { displayName: { $exists: false } },
      { downloadName: { $exists: false } },
      { "files.originalName": { $exists: false } },
      { priority: { $exists: false } },
      { priorityOverride: { $exists: false } },
      { retryCount: { $exists: false } },
      { encryptionVersion: { $exists: false } },
      { archiveKind: { $exists: false } },
      { sourceArchiveId: { $exists: false } },
      { sourceFileIndex: { $exists: false } },
      { transcodeAudioTrack: { $exists: false } },
      { "files.transcode.variants": { $exists: false } },
      { "files.subtitleTracks": { $exists: false } },
      { "files.path": { $exists: false } },
      { "files.path": null },
      { "files.path": "" }
    ]
  }).lean();

  for await (const doc of cursor) {
    const files = (doc.files || []).map((f: any, index: number) => {
      const originalName = String(f?.originalName || f?.name || path.basename(String(f?.path || "")) || `file_${index}`);
      const normalizedPath = String(f?.path || "").trim() || originalName;
      const normalizedName = String(f?.name || "").trim() || path.basename(normalizedPath) || originalName;
      const normalizedVariants = Array.isArray(f?.transcode?.variants)
        ? f.transcode.variants
            .map((variant: any) => ({
              audioTrack: Number(variant?.audioTrack),
              archiveId: String(variant?.archiveId || ""),
              status: variant?.status || null,
              size: Number(variant?.size || 0),
              contentType: String(variant?.contentType || ""),
              updatedAt: variant?.updatedAt || null,
              error: String(variant?.error || "")
            }))
            .filter((variant: any) => Number.isInteger(variant.audioTrack) && variant.audioTrack >= 0)
        : [];
      if (normalizedVariants.length === 0 && String(f?.transcode?.archiveId || "")) {
        normalizedVariants.push({
          audioTrack: 0,
          archiveId: String(f?.transcode?.archiveId || ""),
          status: f?.transcode?.status || null,
          size: Number(f?.transcode?.size || 0),
          contentType: String(f?.transcode?.contentType || ""),
          updatedAt: f?.transcode?.updatedAt || null,
          error: String(f?.transcode?.error || "")
        });
      }
      return {
        ...f,
        path: normalizedPath,
        name: normalizedName,
        originalName,
        subtitleTracks: Array.isArray(f?.subtitleTracks) ? f.subtitleTracks : [],
        transcode: {
          archiveId: String(f?.transcode?.archiveId || ""),
          status: f?.transcode?.status || null,
          size: Number(f?.transcode?.size || 0),
          contentType: String(f?.transcode?.contentType || ""),
          updatedAt: f?.transcode?.updatedAt || null,
          error: String(f?.transcode?.error || ""),
          variants: normalizedVariants
        }
      };
    });

    const firstName = files[0]?.originalName || doc.name || `file_${doc._id}`;
    const displayName = doc.displayName || (doc.isBundle ? `Bundle (${files.length || 1} files)` : firstName);
    const downloadName = doc.downloadName || (doc.isBundle ? `bundle_${Date.now()}.zip` : firstName);
    const parts = uniqueParts(doc.parts);
    const partsChanged = (doc.parts?.length || 0) !== parts.length;

    await Archive.updateOne(
      { _id: doc._id },
      {
        $set: {
          displayName,
          downloadName,
          files,
          priority: typeof doc.priority === "number" ? doc.priority : 2,
          priorityOverride: doc.priorityOverride ?? false,
          retryCount: doc.retryCount ?? 0,
          encryptionVersion: doc.encryptionVersion ?? 1,
          archiveKind: doc.archiveKind || "primary",
          sourceArchiveId: doc.sourceArchiveId || null,
          sourceFileIndex: Number.isInteger(doc.sourceFileIndex) ? doc.sourceFileIndex : null,
          transcodeAudioTrack: Number.isInteger((doc as any).transcodeAudioTrack) ? (doc as any).transcodeAudioTrack : null,
          deleteTotalParts: doc.deleteTotalParts ?? 0,
          deletedParts: doc.deletedParts ?? 0,
          ...(partsChanged ? { parts } : {})
        }
      }
    );
  }
}

async function migrateUsers() {
  await User.updateMany(
    { transcodeCopiesEnabled: { $exists: false } },
    { $set: { transcodeCopiesEnabled: true } }
  );
}

async function migrateTranscodeAudioTracks() {
  await Archive.updateMany(
    {
      archiveKind: "transcoded",
      $or: [
        { transcodeAudioTrack: { $exists: false } },
        { transcodeAudioTrack: null }
      ]
    },
    { $set: { transcodeAudioTrack: 0 } }
  );
}

async function migrateParts() {
  const cursor = Archive.find({ "parts.0": { $exists: true } }).lean();
  for await (const doc of cursor) {
    const parts = uniqueParts(doc.parts);
    if ((doc.parts?.length || 0) !== parts.length) {
      await Archive.updateOne({ _id: doc._id }, { $set: { parts } });
    }
  }
}

async function migrateFolders() {
  try {
    await Folder.collection.dropIndex("userId_1_name_1");
  } catch (err: any) {
    if (err?.codeName !== "IndexNotFound") {
      log("server", `folder index cleanup failed: ${err?.message || err}`);
    }
  }

  await Folder.updateMany(
    { parentId: { $exists: false } },
    { $set: { parentId: null } }
  );
}

async function ensureCacheDirs() {
  const dirs = [
    config.cacheDir,
    path.join(config.cacheDir, "uploads_tmp"),
    path.join(config.cacheDir, "uploads"),
    path.join(config.cacheDir, "work"),
    path.join(config.cacheDir, "restore"),
    path.join(config.cacheDir, "downloads"),
    path.join(config.cacheDir, "folder_dl"),
    path.join(config.cacheDir, "selection"),
    path.join(config.cacheDir, "thumbs"),
    path.join(config.cacheDir, "thumb_work"),
    path.join(config.cacheDir, "subtitles"),
    path.join(config.cacheDir, "subtitle_work"),
    path.join(config.cacheDir, "transcode_work"),
    path.join(config.cacheDir, "preview_public"),
    path.join(config.cacheDir, "smb_read"),
    path.join(config.cacheDir, "smb_write")
  ];
  for (const dir of dirs) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

async function main() {
  await connectDb();
  startRedis();
  const redisState = getRedisRuntimeState();
  if (redisState.enabled) {
    log("redis", "enabled");
  } else {
    log("redis", "disabled");
  }
  await ensureCacheDirs();
  await ensureAdminUser();
  await ensureMasterKey();
  await ensureWebhookSeed();
  await migrateArchives();
  await migrateParts();
  await migrateFolders();
  await migrateUsers();
  await migrateTranscodeAudioTracks();
  await initAnalyticsPersistence();
  await initMirrorSyncControl();

  startWorker();
  startThumbnailWorker();
  startSubtitleWorker();
  startTranscodeWorker();
  startFuse();
  startCacheCleanup();

  const proxyStatus = getOutboundProxyStatus();
  if (proxyStatus.enabled) {
    if (proxyStatus.active) {
      const routeInfo = Array.isArray((proxyStatus as any).routes) && (proxyStatus as any).routes.length > 0
        ? (proxyStatus as any).routes
            .map((route: any) => `${route.proxyUrl}=>${(route.targets || []).join(",")}`)
            .join(";")
        : "";
      log(
        "proxy",
        `enabled ${routeInfo ? `routes=${routeInfo} ` : `url=${proxyStatus.proxyUrl} targets=${proxyStatus.targets.join(",")} `}fallbackDirect=${proxyStatus.fallbackDirect} bypassMs=${config.outboundProxyBypassMs}`
      );
    } else {
      log("proxy", "enabled but inactive (OUTBOUND_PROXY_URL is empty)");
    }
  } else {
    log("proxy", "disabled");
  }

  log(
    "telegram",
    config.telegramEnabled
      ? (config.telegramBotToken && config.telegramChatId ? "enabled and configured" : "enabled but not configured")
      : "disabled"
  );

  const server = app.listen(config.port, () => {
    log("server", `listening on ${config.port}`);
  });
  initRealtimeServer(server, sessionMiddleware);
  // Allow very large uploads without a 5-minute hard cut-off.
  server.requestTimeout = 0;
  // Keep node from killing long-lived upload sockets due inactivity timeout.
  server.timeout = 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
