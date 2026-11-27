// POST /api/auth/reauthorize: drops this app's GitHub authorization for the signed-in user and
// sends them back through "Continue with GitHub". GitHub only shows a GitHub App's new account
// permissions (such as Followers) when the user authorizes it again, and an ordinary sign-in can
// skip that screen. Their ghfstats data is kept; signing in again picks it back up.
import { githubClient, signInConfigured } from "../../lib/config.mjs";
import { decrypt } from "../../lib/crypto.mjs";
import { revokeGrant } from "../../lib/github.mjs";
import { fail, handle, json, sameOrigin } from "../../lib/http.mjs";
import { endSession, currentUser } from "../../lib/session.mjs";
import { getStore } from "../../lib/store.mjs";

export const POST = handle(async (request) => {
  if (!sameOrigin(request)) return fail(403, "Cross-site request blocked.");
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");

  let revoked = false;
  try {
    if (user.accessToken) revoked = await revokeGrant({ ...githubClient(), accessToken: decrypt(user.accessToken) });
  } catch (e) { console.warn("reauthorize: revoke failed", e.message); }
  await store.setStatus(user.id, { needsReauth: true, lastError: "Sign in again to finish updating ghfstats' GitHub permissions." });
  const cookie = await endSession(request, store);
  return json({ ok: true, revoked, next: "/api/auth/login" }, { headers: { "set-cookie": cookie } });
});
