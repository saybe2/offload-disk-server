import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAdmin } from "../auth.js";
import { User } from "../models/User.js";
import { Archive } from "../models/Archive.js";
import { Folder } from "../models/Folder.js";
import { Share } from "../models/Share.js";
import { Webhook } from "../models/Webhook.js";
import { deleteSmbUser, ensureSmbUser } from "../services/smbUsers.js";
import { config } from "../config.js";

export const adminRouter = Router();

adminRouter.get("/mirror-sync", requireAdmin, async (_req, res) => {
  const [partStats] = await Archive.aggregate([
    {
      $match: {
        status: "ready",
        deletedAt: null,
        trashedAt: null
      }
    },
    {
      $project: {
        archiveId: "$_id",
        mirrorParts: {
          $filter: {
            input: "$parts",
            as: "p",
            cond: { $in: ["$$p.mirrorProvider", ["discord", "telegram"]] }
          }
        }
      }
    },
    { $unwind: { path: "$mirrorParts", preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: null,
        totalParts: { $sum: 1 },
        doneParts: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: [{ $ifNull: ["$mirrorParts.mirrorUrl", ""] }, ""] },
                  { $ne: [{ $ifNull: ["$mirrorParts.mirrorMessageId", ""] }, ""] }
                ]
              },
              1,
              0
            ]
          }
        },
        pendingParts: {
          $sum: { $cond: [{ $eq: ["$mirrorParts.mirrorPending", true] }, 1, 0] }
        },
        errorParts: {
          $sum: {
            $cond: [{ $ne: [{ $ifNull: ["$mirrorParts.mirrorError", ""] }, ""] }, 1, 0]
          }
        }
      }
    }
  ]);

  const archivesWithMirror = await Archive.countDocuments({
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    "parts.mirrorProvider": { $in: ["discord", "telegram"] }
  });
  const archivesPending = await Archive.countDocuments({
    status: "ready",
    deletedAt: null,
    trashedAt: null,
    "parts.mirrorPending": true
  });

  const totalParts = Number(partStats?.totalParts || 0);
  const doneParts = Number(partStats?.doneParts || 0);
  const pendingParts = Number(partStats?.pendingParts || 0);
  const errorParts = Number(partStats?.errorParts || 0);
  const remainingParts = Math.max(0, totalParts - doneParts);
  const percent = totalParts > 0 ? Math.floor((doneParts / totalParts) * 100) : 100;

  res.json({
    totalParts,
    doneParts,
    pendingParts,
    remainingParts,
    errorParts,
    percent,
    archivesTotal: archivesWithMirror,
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
