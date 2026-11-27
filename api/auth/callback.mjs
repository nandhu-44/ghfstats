// GET /api/auth/callback: GitHub sends the user back here after they approve sign-in.
import { appInstallUrl, githubClient, signInConfigured } from "../../lib/config.mjs";
import { decrypt, safeEqual } from "../../lib/crypto.mjs";
import { api, appInstallation, exchangeCode } from "../../lib/github.mjs";
import { handle, parseCookies, redirect } from "../../lib/http.mjs";
import { clientIp, rateLimit } from "../../lib/ratelimit.mjs";
import { OAUTH_COOKIE, clearCookie, startSession } from "../../lib/session.mjs";
import { sealTokens, takeSnapshot } from "../../lib/snapshot.mjs";
import { getStore } from "../../lib/store.mjs";

export const GET = handle(async (request) => {
  const clear = clearCookie(request, OAUTH_COOKIE);
  const fail = (why) => redirect(`/?signin=${why}`, [clear]);
  if (!signInConfigured()) return fail("unavailable");

  const url = new URL(request.url);
  if (url.searchParams.get("error")) return fail("cancelled");

  let st = null;
  try { st = JSON.parse(decrypt(parseCookies(request)[OAUTH_COOKIE]) || "null"); } catch { st = null; }
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  if (!st || Date.now() - st.t > 600e3 || !safeEqual(st.s, state)) return fail("expired");
  if (!code) return fail("failed");
  const store = await getStore();
  if (await rateLimit(store, "callback", clientIp(request))) return fail("busy");

  let tokens, me;
  try {
    tokens = await exchangeCode({
      ...githubClient(), code, redirectUri: `${url.origin}/api/auth/callback`, codeVerifier: st.v,
    });
    me = await api("/user", tokens.accessToken);
  } catch (e) {
    console.error("GitHub sign-in failed:", e.message);
    return fail("failed");
  }

  const user = await store.upsertUser({
    id: Number(me.id), login: me.login, name: me.name, avatarUrl: me.avatar_url, ...sealTokens(tokens),
  });
  // Take the first snapshot here so the account has data stored as soon as sign-in finishes.
  // The dashboard retries if this fails, so a failure doesn't block the sign-in.
  const firstSignIn = !user.lastSnapshotAt;
  let first = "existing";
  if (firstSignIn) {
    try { await takeSnapshot(store, user); first = "taken"; }
    catch (e) { first = `failed: ${e.message}`; }
  }
  // Following and unfollowing need the App installed on the account. On a first sign-in without it,
  // go straight to GitHub's install page (its Setup URL brings people back to the dashboard).
  // After that, the dashboard offers the install step instead, so nobody is bounced every time.
  const app = await appInstallation(tokens.accessToken);
  console.log("signin", JSON.stringify({ firstSnapshot: first, appInstalled: app.installed }));
  const session = await startSession(request, store, Number(me.id));
  const installUrl = appInstallUrl();
  if (app.installed === false) return redirect(firstSignIn && installUrl ? installUrl : "/dashboard?install=needed", [clear, session]);
  return redirect("/dashboard", [clear, session]);
});
