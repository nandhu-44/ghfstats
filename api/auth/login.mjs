// GET /api/auth/login: starts "Continue with GitHub" (OAuth web flow with PKCE).
import { githubClient, signInConfigured } from "../../lib/config.mjs";
import { encrypt, pkceChallenge, randomToken } from "../../lib/crypto.mjs";
import { authorizeUrl } from "../../lib/github.mjs";
import { handle, isSecure, redirect, serializeCookie } from "../../lib/http.mjs";
import { clientIp, rateLimit } from "../../lib/ratelimit.mjs";
import { OAUTH_COOKIE } from "../../lib/session.mjs";
import { getStore } from "../../lib/store.mjs";

export const GET = handle(async (request) => {
  if (!signInConfigured()) return redirect("/?signin=unavailable");
  if (await rateLimit(await getStore(), "signin", clientIp(request))) return redirect("/?signin=busy");
  const origin = new URL(request.url).origin;
  const state = randomToken(16), verifier = randomToken(48);
  const cookie = serializeCookie(OAUTH_COOKIE, encrypt(JSON.stringify({ s: state, v: verifier, t: Date.now() })), {
    maxAge: 600, secure: isSecure(request),
  });
  const url = authorizeUrl({
    clientId: githubClient().clientId,
    redirectUri: `${origin}/api/auth/callback`,
    state,
    codeChallenge: pkceChallenge(verifier),
  });
  return redirect(url, [cookie]);
});
