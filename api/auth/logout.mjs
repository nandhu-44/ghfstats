// POST /api/auth/logout: ends this browser's session. Daily snapshots keep running.
import { signInConfigured } from "../../lib/config.mjs";
import { fail, handle, json, sameOrigin } from "../../lib/http.mjs";
import { SESSION_COOKIE, clearCookie, endSession } from "../../lib/session.mjs";
import { getStore } from "../../lib/store.mjs";

export const POST = handle(async (request) => {
  if (!sameOrigin(request)) return fail(403, "Cross-site request blocked.");
  const cookie = signInConfigured() ? await endSession(request, await getStore()) : clearCookie(request, SESSION_COOKIE);
  return json({ ok: true }, { headers: { "set-cookie": cookie } });
});
