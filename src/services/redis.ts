import { createClient, type RedisClientType } from "redis";
import { config } from "../config.js";
import { log } from "../logger.js";

let client: RedisClientType | null = null;
let reconnecting = false;
let connectStarted = false;

type RedisState = {
  enabled: boolean;
  ready: boolean;
  reconnecting: boolean;
};

function resolveRedisUrl() {
  if (!config.redisEnabled) return "";
  if (config.redisUrl) return config.redisUrl;
  if (!config.redisHost) return "";
  const user = encodeURIComponent(config.redisUsername || "default");
  const pass = config.redisPassword ? `:${encodeURIComponent(config.redisPassword)}` : "";
  const auth = config.redisPassword || config.redisUsername ? `${user}${pass}@` : "";
  return `redis://${auth}${config.redisHost}:${config.redisPort}/${config.redisDb}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectLoop() {
  const redisUrl = resolveRedisUrl();
  if (!redisUrl) {
    log("redis", "disabled (no configuration)");
    return;
  }
  while (config.redisEnabled) {
    try {
      reconnecting = true;
      client = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 5000
        }
      });

      client.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err || "");
        log("redis", `error ${message}`);
      });

      client.on("ready", () => {
        reconnecting = false;
        log("redis", "ready");
      });

      client.on("reconnecting", () => {
        reconnecting = true;
      });

      client.on("end", () => {
        reconnecting = true;
      });

      await client.connect();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "");
      log("redis", `connect failed retry_in=3000ms err=${message}`);
      reconnecting = true;
      client = null;
      await sleep(3000);
    }
  }
}

export function startRedis() {
  if (connectStarted) return;
  connectStarted = true;
  void connectLoop();
}

export function getRedisRuntimeState(): RedisState {
  const ready = !!client?.isReady;
  return {
    enabled: config.redisEnabled,
    ready,
    reconnecting: !ready && reconnecting
  };
}

function buildCacheKey(key: string) {
  const prefix = (config.redisKeyPrefix || "offload").trim() || "offload";
  return `${prefix}:cache:${key}`;
}

export async function redisCacheGet<T>(key: string): Promise<T | null> {
  if (!client?.isReady) return null;
  try {
    const raw = await client.get(buildCacheKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function redisCacheSet<T>(key: string, value: T, ttlSec = config.redisCacheTtlSec) {
  if (!client?.isReady) return;
  const ttl = Math.max(1, Math.trunc(ttlSec || 1));
  try {
    await client.set(buildCacheKey(key), JSON.stringify(value), { EX: ttl });
  } catch {
    // ignore cache write failures
  }
}
