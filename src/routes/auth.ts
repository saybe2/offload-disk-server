import { Router } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ error: "missing_credentials" });
  }
  const user = await User.findOne({ username });
  if (!user) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "invalid_credentials" });
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
  return res.json({ id: user.id, username: user.username, role: user.role, quotaBytes: user.quotaBytes, usedBytes: user.usedBytes });
});
