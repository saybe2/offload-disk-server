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
  proxyUrl: sanitizeProxyUrl(proxyUrl)
};

const loggedHosts = new Set<string>();

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
    if (config.outboundProxyLogMatches) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (!loggedHosts.has(host)) {
          loggedHosts.add(host);
          log("proxy", `route via proxy host=${host}`);
        }
      } catch {
        // ignore parse errors
      }
    }
    return undiciFetch(input as any, { ...(init || {}), dispatcher: proxyAgent! });
  }
  return undiciFetch(input as any, init);
}

