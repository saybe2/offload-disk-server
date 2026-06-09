import { Router } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { getUserTranscodeUsageStats } from "../services/transcodes.js";
import { ensureSmbUser } from "../services/smbUsers.js";
import { log } from "../logger.js";

export const authRouter = Router();

// A fixed bcrypt hash used to spend roughly the same time on the "no such user"
// path as on a real comparison, removing the username-enumeration timing oracle.
const DUMMY_BCRYPT_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8DvL3aB2j6pQ1aQ6m3y3O9q1zS7Hy";

authRouter.post("/login", async (req, res) => {
  // Force string types: with the JSON body parser, an object value like
  // {"username":{"$gt":""}} would otherwise become a Mongo operator and allow
  // NoSQL operator injection / arbitrary user selection.
  const rawUsername = (req.body as any)?.username;
  const rawPassword = (req.body as any)?.password;
  if (typeof rawUsername !== "string" || typeof rawPassword !== "string") {
    return res.status(400).json({ error: "missing_credentials" });
  }
  const username = rawUsername;
  const password = rawPassword;
  if (!username || !password) {
    return res.status(400).json({ error: "missing_credentials" });
  }
  const user = await User.findOne({ username });
  if (!user) {
    // Spend comparable time to avoid leaking whether the username exists.
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => false);
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  // Prevent session fixation: issue a fresh session id on privilege change.
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  // Keep SMB credentials in sync with web credentials for existing accounts.
  try {
    await ensureSmbUser(username, password);
  } catch (err) {
    log("smb", `sync user failed for ${username}: ${err instanceof Error ? err.message : err}`);
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  return res.json({ ok: true, role: user.role });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

authRouter.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "auth_required" });
  }
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }
  const transcodeStats = await getUserTranscodeUsageStats(user.id);
  return res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    quotaBytes: user.quotaBytes,
    usedBytes: user.usedBytes,
    transcodedUsedBytes: transcodeStats.totalBytes,
    transcodedCount: transcodeStats.totalCount,
    transcodeCopiesEnabled: !!user.transcodeCopiesEnabled
  });
});
