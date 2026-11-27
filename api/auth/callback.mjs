// GET /api/auth/callback: GitHub sends the user back here after they approve sign-in.
import { githubClient, signInConfigured } from "../../lib/config.mjs";
import { decrypt, safeEqual } from "../../lib/crypto.mjs";
import { api, exchangeCode } from "../../lib/github.mjs";
import { handle, parseCookies, redirect } from "../../lib/http.mjs";
import { OAUTH_COOKIE, clearCookie, startSession } from "../../lib/session.mjs";
import { sealTokens } from "../../lib/snapshot.mjs";
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

  const store = await getStore();
  await store.upsertUser({
    id: Number(me.id), login: me.login, name: me.name, avatarUrl: me.avatar_url, ...sealTokens(tokens),
  });
  const session = await startSession(request, store, Number(me.id));
  return redirect("/dashboard", [clear, session]);
});
