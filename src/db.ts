import mongoose from "mongoose";
import { config } from "./config.js";
import { log } from "./logger.js";

const INITIAL_RETRY_MS = 1500;
const MAX_RETRY_MS = 15000;

let listenersAttached = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachMongoListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on("connected", () => {
    log("db", "connected");
  });

  mongoose.connection.on("disconnected", () => {
    log("db", "disconnected, waiting for reconnect");
  });

  mongoose.connection.on("reconnected", () => {
    log("db", "reconnected");
  });

  mongoose.connection.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err || "");
    log("db", `connection error ${message}`);
  });
}

export async function connectDb() {
  attachMongoListeners();
  if (mongoose.connection.readyState === 1) return;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await mongoose.connect(config.mongoUri, {
        dbName: config.mongoDb,
        serverSelectionTimeoutMS: 5000
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "");
      const delay = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * Math.max(1, attempt));
      log("db", `connect failed attempt=${attempt} retry_in=${delay}ms err=${message}`);
      await sleep(delay);
    }
  }
}
