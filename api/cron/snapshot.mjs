// GET /api/cron/snapshot: run daily by Vercel Cron (see vercel.json). Snapshots signed-in users,
// oldest first, until the time budget runs out; anyone left over goes first next time.
import { env, signInConfigured } from "../../lib/config.mjs";
import { safeEqual } from "../../lib/crypto.mjs";
import { fail, handle, json } from "../../lib/http.mjs";
import { ReauthError, takeSnapshot } from "../../lib/snapshot.mjs";
import { getStore } from "../../lib/store.mjs";

const BUDGET_MS = 240e3;

export const GET = handle(async (request) => {
  const secret = env("CRON_SECRET");
  if (!secret) return fail(503, "CRON_SECRET isn't set.");
  if (!safeEqual(request.headers.get("authorization") || "", `Bearer ${secret}`)) return fail(401, "Unauthorized.");
  if (!signInConfigured()) return json({ ok: true, skipped: "sign-in not configured" });

  const started = Date.now();
  const store = await getStore();
  const users = await store.listUsersForCron(500);
  const result = { ok: true, total: users.length, done: 0, changes: 0, reauth: 0, failed: 0, left: 0 };
  for (const user of users) {
    if (Date.now() - started > BUDGET_MS) { result.left = users.length - result.done - result.reauth - result.failed; break; }
    try {
      const r = await takeSnapshot(store, user);
      result.done++;
      result.changes += r.events.length;
    } catch (e) {
      if (e instanceof ReauthError) { result.reauth++; continue; }
      result.failed++;
      console.error(`Snapshot failed for user ${user.id}:`, e.message);
      if (e.name === "GitHubError") await store.setStatus(user.id, { lastError: e.message }).catch(() => {});
    }
  }
  console.log("cron snapshot", JSON.stringify(result));
  return json(result);
});
