// GET /api/lookup?path=/users/<login>[/followers|/following][?per_page=&page=]
// Lets a signed-in person look up any public account with their own GitHub sign-in, so they get
// GitHub's 5,000-requests-an-hour limit instead of 60. Nothing about the lookup is stored, and the
// token never reaches the browser. Only these three read-only, public endpoints are forwarded.
import { githubApi, signInConfigured } from "../lib/config.mjs";
import { fail, handle } from "../lib/http.mjs";
import { rateLimit } from "../lib/ratelimit.mjs";
import { currentUser } from "../lib/session.mjs";
import { ReauthError, accessTokenFor } from "../lib/snapshot.mjs";
import { getStore } from "../lib/store.mjs";

const ALLOWED = /^\/users\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/(?:followers|following))?$/;
const PASS_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];

export const GET = handle(async (request) => {
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  const raw = new URL(request.url).searchParams.get("path") || "";
  const target = new URL(raw, "https://placeholder.invalid");
  if (target.origin !== "https://placeholder.invalid" || !ALLOWED.test(target.pathname)) return fail(400, "That lookup isn't allowed.");

  const qs = new URLSearchParams();
  const perPage = Number(target.searchParams.get("per_page") || 30);
  const page = Number(target.searchParams.get("page") || 1);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100 || !Number.isInteger(page) || page < 1 || page > 1000) {
    return fail(400, "That lookup isn't allowed.");
  }
  if (target.pathname.split("/").length > 3) { qs.set("per_page", String(perPage)); qs.set("page", String(page)); }

  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");
  const limited = await rateLimit(store, "lookup", user.id);
  if (limited) return limited;
  let token;
  try { token = await accessTokenFor(store, user); }
  catch (e) {
    if (e instanceof ReauthError) return fail(401, e.message, { reauth: true });
    throw e;
  }

  const res = await fetch(`${githubApi()}${target.pathname}${qs.size ? "?" + qs : ""}`, {
    headers: {
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`, "User-Agent": "ghfstats",
    },
  });
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const h of PASS_HEADERS) { const v = res.headers.get(h); if (v !== null) headers.set(h, v); }
  return new Response(await res.text(), { status: res.status, headers });
});
