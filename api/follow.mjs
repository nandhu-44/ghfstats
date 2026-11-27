// POST /api/follow  {"action": "unfollow" | "follow", "login": "<username>"}
// One follow or unfollow that the signed-in user picked and confirmed on the dashboard.
// - Unfollow: only accounts they follow. Follow: only follow-back of accounts that follow them,
//   so ghfstats can't be used to mass-follow strangers (GitHub bans automated or high-volume following).
// - Server-side limits per hour and per day, and at least a second between actions.
// - Needs the GitHub App's "Followers" account permission (read and write).
import { FOLLOW_LIMITS, followGapMs, githubApi, signInConfigured } from "../lib/config.mjs";
import { fail, handle, json, sameOrigin } from "../lib/http.mjs";
import { currentUser } from "../lib/session.mjs";
import { ReauthError, accessTokenFor } from "../lib/snapshot.mjs";
import { getStore } from "../lib/store.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const hhmm = (d) => d.toISOString().slice(11, 16) + " UTC";

export const POST = handle(async (request) => {
  if (!sameOrigin(request)) return fail(403, "Cross-site request blocked.");
  if (!signInConfigured()) return fail(503, "Sign-in isn't set up on this site yet.");
  let body;
  try { body = await request.json(); } catch { return fail(400, "Send JSON with action and login."); }
  const action = body && body.action, login = body && String(body.login || "").replace(/^@/, "");
  if (!["follow", "unfollow"].includes(action) || !LOGIN.test(login)) return fail(400, "Send action follow or unfollow and a GitHub username.");

  const store = await getStore();
  const user = await currentUser(request, store);
  if (!user) return fail(401, "You're not signed in.");
  if (login.toLowerCase() === String(user.login).toLowerCase()) return fail(400, "You can't follow or unfollow yourself.");

  // Only people already in the user's lists, as of the last snapshot.
  let target;
  if (action === "unfollow") {
    target = await store.findEdge(user.id, "following", login);
    if (!target) return fail(409, `You don't follow @${login}, as of your last snapshot.`);
  } else {
    target = await store.findEdge(user.id, "followers", login);
    if (!target) return fail(409, `Following is only for people who follow you, and @${login} doesn't, as of your last snapshot.`);
    if (await store.findEdge(user.id, "following", login)) return fail(409, `You already follow @${login}.`);
  }

  // Limits.
  const now = new Date();
  const recent = await store.recentActions(user.id, new Date(now.getTime() - 86400e3));
  const last = recent.reduce((m, a) => Math.max(m, new Date(a.at).getTime()), 0);
  if (now.getTime() - last < followGapMs()) return fail(429, "Slow down a little.", { retryAfter: 1 });
  const lim = FOLLOW_LIMITS[action];
  const mine = recent.filter((a) => a.kind === action).map((a) => new Date(a.at).getTime()).sort((a, b) => a - b);
  const inHour = mine.filter((t) => t > now.getTime() - 3600e3);
  const verb = action === "follow" ? "followed" : "unfollowed";
  if (inHour.length >= lim.perHour) {
    const at = new Date(inHour[inHour.length - lim.perHour] + 3600e3);
    return fail(429, `You've ${verb} ${lim.perHour} accounts in the last hour, the most ghfstats allows. You can carry on after ${hhmm(at)}.`, { retryAt: at, limit: true });
  }
  if (mine.length >= lim.perDay) {
    const at = new Date(mine[mine.length - lim.perDay] + 86400e3);
    return fail(429, `You've ${verb} ${lim.perDay} accounts in the last 24 hours, the most ghfstats allows. You can carry on after ${hhmm(at)}.`, { retryAt: at, limit: true });
  }

  let token;
  try { token = await accessTokenFor(store, user); }
  catch (e) {
    if (e instanceof ReauthError) return fail(401, e.message, { reauth: true });
    throw e;
  }

  const res = await fetch(`${githubApi()}/user/following/${encodeURIComponent(target.login)}`, {
    method: action === "follow" ? "PUT" : "DELETE",
    headers: {
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`, "User-Agent": "ghfstats", "Content-Length": "0",
    },
    body: action === "follow" ? "" : undefined,
  });

  if (res.status === 204 || res.status === 304) {
    await store.applyFollowChange(user.id, {
      kind: action === "follow" ? "you_followed" : "you_unfollowed",
      id: target.id, login: target.login, type: target.type, at: now,
    });
    return json({ ok: true, action, login: target.login, id: target.id });
  }

  let message = "";
  try { message = (await res.json()).message || ""; } catch { /* no body */ }
  const retryAfter = Number(res.headers.get("retry-after")) || null;
  // What GitHub said (no tokens or usernames), so failures can be diagnosed from the logs.
  const github = { status: res.status, message: message.slice(0, 200), needs: res.headers.get("x-accepted-github-permissions") || null };
  console.warn("follow failed", JSON.stringify({ action, ...github, remaining: res.headers.get("x-ratelimit-remaining") }));
  if (res.status === 429 || (res.status === 403 && (retryAfter || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) {
    return fail(429, "GitHub asked ghfstats to slow down. Wait a minute, then try again.", { retryAfter: retryAfter || 60, github });
  }
  if (res.status === 403 && /not accessible by integration|permission/i.test(message)) {
    return fail(403, `GitHub refused: this sign-in doesn't have the Followers (read and write) permission.`, { needsPermission: true, github });
  }
  if (res.status === 401) return fail(401, "Your GitHub sign-in expired. Sign in again.", { reauth: true, github });
  if (res.status === 404) return fail(404, `GitHub has no account @${target.login} any more.`, { github });
  if (res.status === 422) return fail(422, "GitHub refused this, which can mean its spam protection kicked in. Stop for now and try later.", { github });
  return fail(502, `GitHub returned an error (${res.status}${github.message ? `: ${github.message}` : ""}).`, { github });
});
