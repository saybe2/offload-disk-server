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
import { getOutboundProxyStatus } from "./services/outbound.js";

process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack || "" : "";
  if (/invalid signature: 0x/i.test(message) && /unzipper\/lib\/parse\.js/i.test(stack)) {
    log("restore", `zip parse guard ${message}`);
    return;
  }
  log("server", `uncaught exception ${message}`);
  process.exit(1);
});

const app = express();

app.use((req, _res, next) => {
  req.on("error", (err) => {
    if ((err as Error)?.message === "aborted") return;
    log("server", `request error ${err instanceof Error ? err.message : err}`);
  });
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: config.mongoUri, dbName: config.mongoDb })
  })
);

app.get("/api/ui-config", (_req, res) => {
  res.json({
    streamUploadsEnabled: config.streamUploadsEnabled,
    streamSingleMinMiB: config.streamSingleMinMiB,
    previewMaxMiB: config.previewMaxMiB,
    refreshMs: config.uiRefreshMs,
    etaWindowMs: config.uiEtaWindowMs,
    etaMaxSamples: config.uiEtaMaxSamples
  });
});

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
    usedBytes: 0
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
      { encryptionVersion: { $exists: false } }
    ]
  }).lean();

  for await (const doc of cursor) {
    const files = (doc.files || []).map((f: any) => ({
      ...f,
      originalName: f.originalName || f.name || path.basename(f.path || "file")
    }));

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
          deleteTotalParts: doc.deleteTotalParts ?? 0,
          deletedParts: doc.deletedParts ?? 0,
          ...(partsChanged ? { parts } : {})
        }
      }
    );
  }
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
  await ensureCacheDirs();
  await ensureAdminUser();
  await ensureMasterKey();
  await ensureWebhookSeed();
  await migrateArchives();
  await migrateParts();
  await migrateFolders();

  startWorker();
  startThumbnailWorker();
  startFuse();
  startCacheCleanup();

  const proxyStatus = getOutboundProxyStatus();
  if (proxyStatus.enabled) {
    if (proxyStatus.active) {
      log(
        "proxy",
        `enabled url=${proxyStatus.proxyUrl} targets=${proxyStatus.targets.join(",")} fallbackDirect=${proxyStatus.fallbackDirect} bypassMs=${config.outboundProxyBypassMs}`
      );
    } else {
      log("proxy", "enabled but inactive (OUTBOUND_PROXY_URL is empty)");
    }
  } else {
    log("proxy", "disabled");
  }

  app.listen(config.port, () => {
    log("server", `listening on ${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
