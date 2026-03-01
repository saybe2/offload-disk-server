import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAdmin } from "../auth.js";
import { User } from "../models/User.js";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { Share } from "../models/Share.js";
import { Webhook } from "../models/Webhook.js";
import { deleteSmbUser, ensureSmbUser } from "../services/smbUsers.js";
import { isTelegramReady } from "../services/telegram.js";
import { config } from "../config.js";

export const adminRouter = Router();

adminRouter.get("/mirror-sync", requireAdmin, async (_req, res) => {
  const hasDiscord = (await Webhook.countDocuments({ enabled: true })) > 0;
  const telegramReady = isTelegramReady();

  const archives = await Archive.find({
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    "parts.0": { $exists: true }
  })
    .select("parts files originalSize")
    .lean();

  const resolveTarget = (part: any) => {
    if (part?.mirrorProvider === "discord" || part?.mirrorProvider === "telegram") {
      return part.mirrorProvider;
    }
    const primary = part?.provider === "telegram" ? "telegram" : "discord";
    if (primary === "discord" && telegramReady) return "telegram";
    if (primary === "telegram" && hasDiscord) return "discord";
    return null;
  };

  let archivesTotal = 0;
  let archivesDone = 0;
  let filesTotal = 0;
  let filesDone = 0;
  let totalParts = 0;
  let doneParts = 0;
  let pendingParts = 0;
  let errorParts = 0;
  let totalBytes = 0;
  let doneBytes = 0;

  for (const archive of archives as any[]) {
    const activeFilesCount = Array.isArray(archive.files)
      ? archive.files.filter((f: any) => !f?.deletedAt).length
      : 0;
    const parts = Array.isArray(archive.parts) ? archive.parts : [];
    if (parts.length === 0) continue;

    let archiveTargetParts = 0;
    let archiveDoneParts = 0;
    let archivePartBytesTotal = 0;
    let archivePartBytesDone = 0;

    for (const part of parts) {
      const target = resolveTarget(part);
      if (!target) continue;

      const partBytes = Number(part?.plainSize || part?.size || 0);
      const done = !!part?.mirrorUrl && !!part?.mirrorMessageId;
      const pending = !!part?.mirrorPending;
      const hasError = !!part?.mirrorError;

      archiveTargetParts += 1;
      totalParts += 1;
      archivePartBytesTotal += partBytes;

      if (done) {
        archiveDoneParts += 1;
        doneParts += 1;
        archivePartBytesDone += partBytes;
      }
      if (pending) pendingParts += 1;
      if (hasError) errorParts += 1;
    }

    if (archiveTargetParts === 0) continue;

    archivesTotal += 1;
    filesTotal += activeFilesCount;

    const archiveOriginalSize = Number(archive.originalSize || 0);
    if (archiveOriginalSize > 0) {
      totalBytes += archiveOriginalSize;
      doneBytes += archiveOriginalSize * (archiveDoneParts / archiveTargetParts);
    } else {
      totalBytes += archivePartBytesTotal;
      doneBytes += archivePartBytesDone;
    }

    if (archiveDoneParts >= archiveTargetParts) {
      archivesDone += 1;
      filesDone += activeFilesCount;
    }
  }

  const archivesPending = Math.max(0, archivesTotal - archivesDone);
  const filesRemaining = Math.max(0, filesTotal - filesDone);
  const filesPercent = filesTotal > 0 ? Math.floor((filesDone / filesTotal) * 100) : 100;
  const remainingParts = Math.max(0, totalParts - doneParts);
  const partsPercent = totalParts > 0 ? Math.floor((doneParts / totalParts) * 100) : 100;
  const remainingBytes = Math.max(0, totalBytes - doneBytes);
  const bytesPercent = totalBytes > 0 ? Math.floor((doneBytes / totalBytes) * 100) : 100;

  res.json({
    filesTotal,
    filesDone,
    filesRemaining,
    filesPercent,
    totalParts,
    doneParts,
    pendingParts,
    remainingParts,
    errorParts,
    partsPercent,
    totalBytes,
    doneBytes,
    remainingBytes,
    bytesPercent,
    archivesTotal,
    archivesDone,
    archivesPending
  });
});

adminRouter.get("/users", requireAdmin, async (_req, res) => {
  const users = await User.find().sort({ createdAt: -1 }).lean();
  res.json({ users });
});

adminRouter.post("/users", requireAdmin, async (req, res) => {
  const { username, password, role, quotaBytes } = req.body as {
    username?: string;
    password?: string;
    role?: "admin" | "user";
    quotaBytes?: number;
  };
  if (!username || !password) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (config.smbEnabled && !/^[a-zA-Z0-9._-]{1,32}$/.test(username)) {
    return res.status(400).json({ error: "invalid_username" });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({
    username,
    passwordHash: hash,
    role: role || "user",
    quotaBytes: quotaBytes ?? 0,
    usedBytes: 0
  });
  await ensureSmbUser(username, password);
  res.json({ id: user.id });
});

adminRouter.patch("/users/:id", requireAdmin, async (req, res) => {
  const { quotaBytes, role, password } = req.body as { quotaBytes?: number; role?: "admin" | "user"; password?: string };
  const update: Record<string, unknown> = {};
  if (typeof quotaBytes === "number") update.quotaBytes = quotaBytes;
  if (role) update.role = role;
  if (password) update.passwordHash = await bcrypt.hash(password, 10);
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
  if (password && user) {
    await ensureSmbUser(user.username, password);
  }
  res.json({ ok: true });
});

adminRouter.delete("/users/:id", requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  if (req.session.userId && user.id.toString() === req.session.userId.toString()) {
    return res.status(400).json({ error: "cannot_delete_self" });
  }
  if (user.role === "admin") {
    const adminCount = await User.countDocuments({ role: "admin" });
    if (adminCount <= 1) {
      return res.status(400).json({ error: "last_admin" });
    }
  }

  const now = new Date();
  await Archive.updateMany(
    { userId: user._id, deletedAt: null },
    { $set: { deleteRequestedAt: now, deletedParts: 0, deleting: false } }
  );
  await Share.deleteMany({ userId: user._id });
  await Folder.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
  await deleteSmbUser(user.username);
  res.json({ ok: true });
});

adminRouter.get("/webhooks", requireAdmin, async (_req, res) => {
  const webhooks = await Webhook.find().sort({ createdAt: -1 }).lean();
  res.json({ webhooks });
});

adminRouter.post("/webhooks", requireAdmin, async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) {
    return res.status(400).json({ error: "missing_url" });
  }
  const hook = await Webhook.create({ url, enabled: true });
  res.json({ id: hook.id });
});

adminRouter.patch("/webhooks/:id", requireAdmin, async (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "missing_enabled" });
  }
  await Webhook.findByIdAndUpdate(req.params.id, { enabled });
  res.json({ ok: true });
});
