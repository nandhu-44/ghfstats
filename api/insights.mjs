// GET /api/insights: follower details from GitHub's GraphQL API, computed on request and not stored.
import { signInConfigured } from "../lib/config.mjs";
import { fail, handle, json } from "../lib/http.mjs";
import { followerDetails, summarize } from "../lib/insights.mjs";
import { currentUser } from "../lib/session.mjs";
import { ReauthError, accessTokenFor } from "../lib/snapshot.mjs";
import { getStore } from "../lib/store.mjs";

export const GET = handle(async (request) => {
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");
  try {
    const token = await accessTokenFor(store, user);
    const d = await followerDetails(user.login, token);
    return json({ ...summarize(d.followers), total: d.total, analysed: d.followers.length, truncated: d.truncated });
  } catch (e) {
    if (e instanceof ReauthError) return fail(401, e.message, { reauth: true });
    if (e.rateLimited) return fail(429, "GitHub's rate limit is used up for now. Try again later.");
    if (e.name === "GitHubError") return fail(502, e.message);
    throw e;
  }
});
