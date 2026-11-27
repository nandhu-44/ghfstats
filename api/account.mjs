// DELETE /api/account: deletes everything stored for the signed-in user and revokes access on GitHub.
import { githubClient, signInConfigured } from "../lib/config.mjs";
import { decrypt } from "../lib/crypto.mjs";
import { revokeGrant } from "../lib/github.mjs";
import { fail, handle, json, sameOrigin } from "../lib/http.mjs";
import { SESSION_COOKIE, clearCookie, currentUser } from "../lib/session.mjs";
import { getStore } from "../lib/store.mjs";

export const DELETE = handle(async (request) => {
  if (!sameOrigin(request)) return fail(403, "Cross-site request blocked.");
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");

  let revoked = false;
  try {
    if (user.accessToken) revoked = await revokeGrant({ ...githubClient(), accessToken: decrypt(user.accessToken) });
  } catch { revoked = false; }
  await store.deleteUser(user.id);
  return json({ ok: true, revoked }, { headers: { "set-cookie": clearCookie(request, SESSION_COOKIE) } });
});
