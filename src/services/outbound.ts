import { fetch as undiciFetch, ProxyAgent, type RequestInit } from "undici";
import { config } from "../config.js";
import { log } from "../logger.js";

type FetchInput = string | URL | { url: string };

function normalizeHost(host: string) {
  return host.trim().toLowerCase();
}

function isHostMatch(hostname: string, target: string) {
  return hostname === target || hostname.endsWith(`.${target}`);
}

function sanitizeProxyUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function resolveInputUrl(input: FetchInput): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input?.url === "string") return input.url;
  return null;
}

const proxyTargets = config.outboundProxyTargets.map(normalizeHost);
const proxyUrl = config.outboundProxyUrl;

let proxyAgent: ProxyAgent | null = null;
if (config.outboundProxyEnabled && proxyUrl) {
  proxyAgent = new ProxyAgent(proxyUrl);
}

const proxyStatus = {
  enabled: config.outboundProxyEnabled,
  active: !!proxyAgent,
  targets: proxyTargets,
  proxyUrl: sanitizeProxyUrl(proxyUrl),
  fallbackDirect: config.outboundProxyFallbackDirect
};

const loggedHosts = new Set<string>();
let proxyBypassUntil = 0;
let proxyDegraded = false;

export function getOutboundProxyStatus() {
  return proxyStatus;
}

export function shouldUseProxyForUrl(rawUrl: string) {
  if (!proxyAgent) return false;
  try {
    const parsed = new URL(rawUrl);
    const hostname = normalizeHost(parsed.hostname);
    return proxyTargets.some((target) => isHostMatch(hostname, target));
  } catch {
    return false;
  }
}

export async function outboundFetch(input: FetchInput, init?: RequestInit) {
  const url = resolveInputUrl(input);
  if (url && shouldUseProxyForUrl(url)) {
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return "unknown";
      }
    })();

    if (config.outboundProxyLogMatches) {
      if (!loggedHosts.has(host)) {
        loggedHosts.add(host);
        log("proxy", `route via proxy host=${host}`);
      }
    }

    const now = Date.now();
    if (config.outboundProxyFallbackDirect && now < proxyBypassUntil) {
      return undiciFetch(input as any, init);
    }

    try {
      const response = await undiciFetch(input as any, { ...(init || {}), dispatcher: proxyAgent! });
      if (proxyDegraded) {
        proxyDegraded = false;
        log("proxy", "recovered; proxy routing resumed");
      }
      return response;
    } catch (err) {
      if (!config.outboundProxyFallbackDirect) {
        throw err;
      }
      proxyDegraded = true;
      proxyBypassUntil = Date.now() + config.outboundProxyBypassMs;
      const message = err instanceof Error ? err.message : String(err);
      log(
        "proxy",
        `proxy failed host=${host}; fallback=direct for ${config.outboundProxyBypassMs}ms reason=${message}`
      );
      return undiciFetch(input as any, init);
    }
  }
  return undiciFetch(input as any, init);
}
