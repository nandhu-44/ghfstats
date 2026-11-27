// GET /api/config: tells the page whether sign-in is offered and who is signed in.
import { signInConfigured } from "../lib/config.mjs";
import { handle, json } from "../lib/http.mjs";
import { currentUser } from "../lib/session.mjs";
import { getStore } from "../lib/store.mjs";

export const GET = handle(async (request) => {
  if (!signInConfigured()) return json({ signIn: false, signedIn: false });
  const user = await currentUser(request, await getStore());
  return json({ signIn: true, signedIn: Boolean(user), login: user ? user.login : null });
});
