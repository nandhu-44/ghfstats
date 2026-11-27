// POST /api/sync: takes a snapshot now for the signed-in user.
import { signInConfigured, syncCooldownSeconds } from "../lib/config.mjs";
import { fail, handle, json, sameOrigin } from "../lib/http.mjs";
import { rateLimit } from "../lib/ratelimit.mjs";
import { currentUser } from "../lib/session.mjs";
import { ReauthError, takeSnapshot } from "../lib/snapshot.mjs";
import { getStore } from "../lib/store.mjs";

export const POST = handle(async (request) => {
  if (!sameOrigin(request)) return fail(403, "Cross-site request blocked.");
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");

  const cooldown = syncCooldownSeconds() * 1000;
  if (user.lastSnapshotAt && Date.now() - new Date(user.lastSnapshotAt).getTime() < cooldown) {
    return json({ ok: true, skipped: true, message: "Already up to date. Try again in a couple of minutes." });
  }
  const limited = await rateLimit(store, "sync", user.id);
  if (limited) return limited;
  try {
    const r = await takeSnapshot(store, user);
    return json({ ok: true, baseline: r.baseline, changes: r.events.length, counts: r.daily });
  } catch (e) {
    if (e instanceof ReauthError) return fail(401, e.message, { reauth: true });
    if (e.rateLimited) return fail(429, "GitHub's rate limit is used up for now. Try again later.");
    if (e.name === "GitHubError") return fail(502, e.message);
    if (/can't be tracked/.test(e.message)) return fail(422, e.message);
    throw e;
  }
});
