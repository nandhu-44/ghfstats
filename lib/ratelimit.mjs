// Per-IP and per-account request limits for the server endpoints, so one visitor or one script
// can't run up GitHub calls or database work for everyone else. Counts live in the store
// (ghfs_rate in Postgres). Keys are hashed, so no IP address is ever written down.
import { createHash } from "node:crypto";
import { env } from "./config.mjs";
import { fail } from "./http.mjs";

/** Requests allowed per window. Sign-in is per IP; the rest are per signed-in account. */
export const RATE_LIMITS = {
  signin: { limit: 20, windowSec: 600 },     // starting "Continue with GitHub", per IP
  callback: { limit: 20, windowSec: 600 },   // finishing it, per IP
  lookup: { limit: 600, windowSec: 3600 },   // signed-in lookups of other accounts
  insights: { limit: 20, windowSec: 3600 },  // follower insights (one GraphQL sweep each)
  sync: { limit: 30, windowSec: 3600 },      // manual "Sync now"
};

/** The visitor's IP. Vercel sets x-real-ip and x-forwarded-for itself, so clients can't spoof them there. */
export function clientIp(request) {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "local";
}

function keyFor(scope, who) {
  const salt = env("AUTH_SECRET") || "ghfstats";
  return `${scope}:${createHash("sha256").update(`${salt}|${scope}|${who}`).digest("base64url").slice(0, 32)}`;
}

/**
 * Counts one request for `who` (an IP or an account id) in `scope`. Returns null when it's
 * allowed, or a 429 response to send back. If the store can't count, the request is allowed:
 * a limit that breaks the site is worse than a missed count.
 */
export async function rateLimit(store, scope, who) {
  const rule = RATE_LIMITS[scope];
  if (!rule || env("GHFS_RATE_LIMITS") === "off" || typeof store.hit !== "function") return null;
  let r;
  try { r = await store.hit(keyFor(scope, who), rule.windowSec); }
  catch (e) { console.warn("rate limit skipped", e.message); return null; }
  if (r.count <= rule.limit) return null;
  const retryAfter = Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000));
  const res = fail(429, `Too many requests. Try again in ${retryAfter < 120 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`}.`, { retryAfter });
  res.headers.set("retry-after", String(retryAfter));
  return res;
}
