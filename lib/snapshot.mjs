// Takes a follower snapshot for a signed-in user with their own GitHub token.
import { MAX_ACCOUNTS_PER_LIST, githubClient } from "./config.mjs";
import { decrypt, encrypt } from "./crypto.mjs";
import { buildEvents, countMutuals, dedupe } from "./diff.mjs";
import { GitHubError, api, fetchList, refreshTokens } from "./github.mjs";

export class ReauthError extends Error {
  constructor(message = "Your GitHub sign-in has expired. Sign in again to resume daily snapshots.") {
    super(message);
    this.name = "ReauthError";
  }
}

/** Encrypts tokens for storage. */
export function sealTokens(t) {
  return {
    accessToken: encrypt(t.accessToken),
    refreshToken: t.refreshToken ? encrypt(t.refreshToken) : null,
    accessExpiresAt: t.accessExpiresAt || null,
    refreshExpiresAt: t.refreshExpiresAt || null,
  };
}

async function needReauth(store, user, err) {
  const e = err || new ReauthError();
  await store.setStatus(user.id, { needsReauth: true, lastError: e.message });
  return e;
}

/** A usable access token, refreshing it first when it expires within 5 minutes. */
export async function accessTokenFor(store, user) {
  if (!user.accessToken) throw await needReauth(store, user);
  const expires = user.accessExpiresAt ? new Date(user.accessExpiresAt).getTime() : null;
  if (expires == null || expires - Date.now() > 5 * 60e3) return decrypt(user.accessToken);
  if (!user.refreshToken) throw await needReauth(store, user);
  try {
    const t = await refreshTokens({ ...githubClient(), refreshToken: decrypt(user.refreshToken) });
    await store.updateTokens(user.id, sealTokens(t));
    return t.accessToken;
  } catch (e) {
    if (e instanceof GitHubError && e.code) throw await needReauth(store, user); // e.g. bad_refresh_token
    throw e;
  }
}

/**
 * Fetches the user's followers and following, records changes since the last snapshot and
 * today's counts. The first snapshot is a baseline with no events.
 */
export async function takeSnapshot(store, user, { now = new Date() } = {}) {
  const token = await accessTokenFor(store, user);
  let me;
  try {
    me = await api("/user", token);
  } catch (e) {
    if (e.unauthorized) throw await needReauth(store, user);
    throw e;
  }
  if (Number(me.id) !== Number(user.id)) throw new Error("The GitHub token belongs to a different account.");
  if ((me.followers || 0) > MAX_ACCOUNTS_PER_LIST || (me.following || 0) > MAX_ACCOUNTS_PER_LIST) {
    const msg = `Accounts with more than ${MAX_ACCOUNTS_PER_LIST.toLocaleString("en-US")} followers or following can't be tracked yet.`;
    await store.setStatus(user.id, { lastError: msg });
    throw new Error(msg);
  }

  const [followers, following] = (await Promise.all([
    fetchList(me.login, "followers", token),
    fetchList(me.login, "following", token),
  ])).map(dedupe);

  const baseline = !user.lastSnapshotAt;
  const prev = baseline ? { followers: [], following: [] } : await store.getEdges(user.id);
  const events = baseline ? [] : buildEvents(prev, followers, following);
  const daily = {
    day: now.toISOString().slice(0, 10),
    followers: followers.length,
    following: following.length,
    mutuals: countMutuals(followers, following),
  };
  await store.saveSnapshot(user.id, {
    login: me.login, name: me.name, avatarUrl: me.avatar_url, followers, following, events, daily, at: now,
  });
  return { baseline, events, daily };
}
