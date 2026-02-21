#!/usr/bin/env node
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const args = new Set(process.argv.slice(2));
const once = args.has("--once");

function readNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const intervalSec = readNumberArg("--interval", 10);
const intervalMs = intervalSec * 1000;
const mongoUri = process.env.MONGODB_URI || "";
const dbName = process.env.MONGODB_DB || "cloud_storage";

if (!mongoUri) {
  console.error("MONGODB_URI is required (env).");
  process.exit(1);
}

function formatInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(n)));
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRate(v1PerHour) {
  if (!Number.isFinite(v1PerHour) || v1PerHour <= 0) return "n/a";
  return `${v1PerHour.toFixed(2)} v1/hour`;
}

async function collectStats() {
  const coll = mongoose.connection.db.collection("archives");
  const baseActive = { deletedAt: null, trashedAt: null };
  const ready = { ...baseActive, status: "ready" };
  const v1Filter = { ...ready, $or: [{ encryptionVersion: { $exists: false } }, { encryptionVersion: { $lt: 2 } }] };
  const v2Filter = { ...ready, encryptionVersion: { $gte: 2 } };

  const [v1Ready, v2Ready, processing, queued, errors] = await Promise.all([
    coll.countDocuments(v1Filter),
    coll.countDocuments(v2Filter),
    coll.countDocuments({ ...baseActive, status: "processing" }),
    coll.countDocuments({ ...baseActive, status: "queued" }),
    coll.countDocuments({ ...baseActive, status: "error" })
  ]);

  const totalMigratable = v1Ready + v2Ready;
  const donePct = totalMigratable > 0 ? (v2Ready / totalMigratable) * 100 : 100;

  return {
    now: new Date(),
    v1Ready,
    v2Ready,
    totalMigratable,
    donePct,
    processing,
    queued,
    errors
  };
}

function render(stats, history) {
  const latest = history[history.length - 1];
  const oldest = history[0];
  const deltaV1 = oldest ? oldest.v1Ready - latest.v1Ready : 0;
  const elapsedMs = oldest ? latest.ts - oldest.ts : 0;
  const ratePerHour = elapsedMs > 0 ? (deltaV1 * 3600000) / elapsedMs : 0;
  const etaMs = ratePerHour > 0 ? (stats.v1Ready / ratePerHour) * 3600000 : NaN;

  const lines = [
    `V1 -> V2 Migration Monitor (${stats.now.toISOString()})`,
    "",
    `Ready V1 remaining : ${formatInt(stats.v1Ready)}`,
    `Ready V2 done      : ${formatInt(stats.v2Ready)}`,
    `Progress           : ${stats.donePct.toFixed(2)}%`,
    "",
    `Worker state       : queued=${formatInt(stats.queued)} processing=${formatInt(stats.processing)} error=${formatInt(stats.errors)}`,
    `Migration speed    : ${formatRate(ratePerHour)}`,
    `ETA                : ${Number.isFinite(etaMs) ? formatDuration(etaMs) : "n/a"}`,
    "",
    `Window             : ${oldest ? formatDuration(elapsedMs) : "n/a"} (${history.length} samples, interval ${intervalSec}s)`,
    "",
    "Tip: Ctrl+C to exit"
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5000 });
  const history = [];

  const tick = async () => {
    const stats = await collectStats();
    history.push({ ts: Date.now(), v1Ready: stats.v1Ready });
    const keepWindowMs = 6 * 3600 * 1000;
    while (history.length > 2 && history[0].ts < Date.now() - keepWindowMs) {
      history.shift();
    }
    if (!once) {
      process.stdout.write("\x1Bc");
    }
    render(stats, history);
  };

  await tick();
  if (once) {
    await mongoose.disconnect();
    return;
  }

  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error(`tick error: ${err instanceof Error ? err.message : err}`);
    });
  }, intervalMs);

  process.on("SIGINT", async () => {
    clearInterval(timer);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
