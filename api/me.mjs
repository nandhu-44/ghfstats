// GET /api/me: everything the dashboard shows for the signed-in user.
import { signInConfigured } from "../lib/config.mjs";
import { fail, handle, json } from "../lib/http.mjs";
import { currentUser } from "../lib/session.mjs";
import { getStore } from "../lib/store.mjs";

const pack = (a) => [a.login, a.id, a.type];

export const GET = handle(async (request) => {
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");
  const [edges, events, daily] = await Promise.all([
    store.getEdges(user.id), store.getEvents(user.id, 1000), store.getDaily(user.id, 400),
  ]);
  return json({
    user: {
      id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl,
      lastSnapshotAt: user.lastSnapshotAt, needsReauth: user.needsReauth, lastError: user.lastError,
      trackingSince: user.createdAt,
    },
    followers: edges.followers.map(pack),
    following: edges.following.map(pack),
    events: events.map((e) => ({ kind: e.kind, login: e.login, id: e.id, type: e.type, at: e.at })),
    daily,
  });
});
