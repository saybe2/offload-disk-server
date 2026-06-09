import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Session-bound CSRF protection.
 *
 * Defence-in-depth on top of the SameSite=Lax session cookie. We keep a random
 * per-session token in the (server-side) session store and require mutating
 * requests to echo it back in the `X-CSRF-Token` header. The token is also
 * exposed to the browser via a NON-httpOnly cookie so the SPA can read it and
 * attach the header to its fetch() calls (classic synchroniser-token pattern,
 * but validated against the session rather than a second cookie).
 *
 * No cookie-parser dependency is required: the server validates the header
 * against the value stored in the session, not against the cookie.
 */

const CSRF_COOKIE = "csrfToken";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Ensure the session carries a CSRF token and mirror it into a readable cookie
 * on every response. Mount this BEFORE routes for all session-backed requests.
 */
export function csrfTokenIssuer(req: Request, res: Response, next: NextFunction) {
  const session: any = (req as any).session;
  // Only issue a token for authenticated sessions. Issuing for anonymous
  // visitors would force a Mongo session write per visitor (saveUninitialized
  // is false), and unauthenticated routes don't need CSRF protection anyway.
  if (session && session.userId) {
    if (!session.csrfToken || typeof session.csrfToken !== "string") {
      session.csrfToken = crypto.randomBytes(32).toString("hex");
    }
    // Mirror into a non-httpOnly cookie so the front-end can read & echo it.
    // Secure flag mirrors the session cookie policy (auto over HTTPS).
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      sameSite: "lax",
      secure,
      path: "/"
    });
  }
  next();
}

/**
 * Reject state-changing requests that don't present a valid CSRF token.
 * Safe (read-only) methods are allowed through. Mount on authenticated,
 * session-backed API routers only — NOT on public share routes (which are
 * authorised by an unguessable share token, not a session cookie) and NOT on
 * the login route (no session exists yet).
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }
  const session: any = (req as any).session;
  const expected = session?.csrfToken;
  if (!expected || typeof expected !== "string") {
    return res.status(403).json({ error: "csrf_token_missing" });
  }
  const headerValue = req.headers[CSRF_HEADER];
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof provided !== "string" || !provided || !timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: "csrf_token_invalid" });
  }
  return next();
}
