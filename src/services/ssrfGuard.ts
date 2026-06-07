import dns from "dns/promises";
import net from "net";
import { fetch as undiciFetch, type RequestInit } from "undici";
import { log } from "../logger.js";

/**
 * SSRF protection for user-controlled outbound URLs (e.g. external import part
 * URLs that the server later fetches and relays back to the client).
 *
 * Hardening rules:
 *  - only http(s) schemes are allowed
 *  - embedded credentials are rejected (user:pass@host)
 *  - the hostname is resolved and EVERY resolved address must be a public,
 *    routable unicast address (blocks loopback, private, link-local, CGNAT,
 *    multicast, reserved, IPv4-mapped IPv6, etc.)
 *
 * Resolving and validating the IPs here narrows (but does not fully eliminate)
 * DNS-rebinding: callers should treat the returned address as the one to pin
 * when possible. For the relay use-case the window is small and this blocks the
 * overwhelmingly common metadata/internal-service exfiltration vectors.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ipv4ToParts(ip);
  if (!parts) return true; // fail closed
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (test-net)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51) return true; // test-net-2 198.51.100.0/24
  if (a === 203 && b === 0) return true; // test-net-3 203.0.113.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved 240.0.0.0/4
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (lower.includes(".")) {
    const tail = lower.split(":").pop() || "";
    if (tail.includes(".")) return isPrivateIPv4(tail);
  }
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not a literal IP => fail closed
}

/**
 * Validate a user-supplied outbound URL and resolve it to safe public IPs.
 * Throws SsrfBlockedError when the URL is unsafe.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("invalid_url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError("scheme_not_allowed");
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError("credentials_not_allowed");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    throw new SsrfBlockedError("missing_host");
  }

  // Literal IP in the URL: validate directly.
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isBlockedAddress(hostname)) {
      throw new SsrfBlockedError("blocked_address");
    }
    return;
  }

  // Hostname: resolve and validate every address.
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError("dns_resolution_failed");
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError("dns_no_records");
  }
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw new SsrfBlockedError("blocked_address");
    }
  }
}

/**
 * Drop-in replacement for raw `fetch`/`undiciFetch` that enforces the SSRF
 * guard before issuing the request. Use for any fetch of a user-controlled
 * URL (import-external parts, archived part.url, mirrorUrl, thumbnailUrl,
 * subtitleUrl). Bypasses validation for empty URLs.
 */
export async function safeOutboundFetch(input: string | URL, init?: RequestInit) {
  const url = input instanceof URL ? input.toString() : String(input || "");
  if (!url) {
    throw new SsrfBlockedError("missing_url");
  }
  try {
    await assertSafeOutboundUrl(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      log("ssrf", `blocked url=${redactUrl(url)} reason=${err.message}`);
    }
    throw err;
  }
  return undiciFetch(input as any, init);
}

function redactUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}
