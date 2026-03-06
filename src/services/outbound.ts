import { fetch as undiciFetch, ProxyAgent, type RequestInit } from "undici";
import { config } from "../config.js";
import { log } from "../logger.js";

type FetchInput = string | URL | { url: string };

type ProxyRouteRuntime = {
  id: string;
  proxyUrl: string;
  targets: string[];
  agent: ProxyAgent;
  bypassUntil: number;
  degraded: boolean;
};

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

function makeRouteId(proxyUrl: string, targets: string[]) {
  return `${proxyUrl}|${targets.join(",")}`;
}

function buildConfiguredRoutes() {
  if (!config.outboundProxyEnabled) {
    return [] as { proxyUrl: string; targets: string[] }[];
  }

  const configured = config.outboundProxyRoutes
    .map((route) => ({
      proxyUrl: route.proxyUrl.trim(),
      targets: route.targets.map(normalizeHost).filter(Boolean)
    }))
    .filter((route) => route.proxyUrl && route.targets.length > 0);
  if (configured.length > 0) {
    return configured;
  }

  if (!config.outboundProxyUrl) {
    return [] as { proxyUrl: string; targets: string[] }[];
  }
  return [
    {
      proxyUrl: config.outboundProxyUrl,
      targets: config.outboundProxyTargets.map(normalizeHost).filter(Boolean)
    }
  ];
}

function pickRoute(url: string, routes: ProxyRouteRuntime[]) {
  let hostname = "";
  try {
    hostname = normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }

  let picked: ProxyRouteRuntime | null = null;
  let bestTargetLength = -1;
  for (const route of routes) {
    for (const target of route.targets) {
      if (!isHostMatch(hostname, target)) continue;
      if (target.length <= bestTargetLength) continue;
      bestTargetLength = target.length;
      picked = route;
    }
  }
  if (!picked) return null;
  return { route: picked, hostname };
}

const configuredRoutes = buildConfiguredRoutes();

const proxyRoutes: ProxyRouteRuntime[] = configuredRoutes.map((route) => {
  const targets = route.targets;
  const id = makeRouteId(route.proxyUrl, targets);
  return {
    id,
    proxyUrl: route.proxyUrl,
    targets,
    agent: new ProxyAgent(route.proxyUrl),
    bypassUntil: 0,
    degraded: false
  };
});

const proxyStatus = {
  enabled: config.outboundProxyEnabled,
  active: proxyRoutes.length > 0,
  proxyUrl: sanitizeProxyUrl(config.outboundProxyUrl),
  targets: config.outboundProxyTargets.map(normalizeHost),
  routes: proxyRoutes.map((route) => ({
    proxyUrl: sanitizeProxyUrl(route.proxyUrl),
    targets: route.targets
  })),
  fallbackDirect: config.outboundProxyFallbackDirect
};

const loggedMatches = new Set<string>();

export function getOutboundProxyStatus() {
  return proxyStatus;
}

export function shouldUseProxyForUrl(rawUrl: string) {
  return !!pickRoute(rawUrl, proxyRoutes);
}

export async function outboundFetch(input: FetchInput, init?: RequestInit) {
  const url = resolveInputUrl(input);
  if (!url || proxyRoutes.length === 0) {
    return undiciFetch(input as any, init);
  }

  const matched = pickRoute(url, proxyRoutes);
  if (!matched) {
    return undiciFetch(input as any, init);
  }

  const { route, hostname } = matched;
  if (config.outboundProxyLogMatches) {
    const key = `${hostname}|${route.id}`;
    if (!loggedMatches.has(key)) {
      loggedMatches.add(key);
      log("proxy", `route via proxy host=${hostname}`);
    }
  }

  const now = Date.now();
  if (config.outboundProxyFallbackDirect && now < route.bypassUntil) {
    return undiciFetch(input as any, init);
  }

  try {
    const response = await undiciFetch(input as any, { ...(init || {}), dispatcher: route.agent });
    if (route.degraded) {
      route.degraded = false;
      log("proxy", `recovered route=${sanitizeProxyUrl(route.proxyUrl)} targets=${route.targets.join(",")}`);
    }
    return response;
  } catch (err) {
    if (!config.outboundProxyFallbackDirect) {
      throw err;
    }
    route.degraded = true;
    route.bypassUntil = Date.now() + config.outboundProxyBypassMs;
    const message = err instanceof Error ? err.message : String(err);
    log(
      "proxy",
      `proxy failed host=${hostname}; fallback=direct for ${config.outboundProxyBypassMs}ms reason=${message}`
    );
    return undiciFetch(input as any, init);
  }
}

