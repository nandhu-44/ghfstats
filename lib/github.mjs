// GitHub REST, GraphQL and OAuth calls (works for GitHub Apps and OAuth Apps).
import { githubApi, githubWeb } from "./config.mjs";

export class GitHubError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { token, method = "GET", body, headers = {} } = {}) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ghfstats",
    ...headers,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: h, body });
    } catch {
      if (attempt < 2) { await sleep(400 * 2 ** attempt); continue; }
      throw new GitHubError("Couldn't reach GitHub.", 0);
    }
    if (res.status >= 500 && attempt < 2) { await sleep(400 * 2 ** attempt); continue; }
    return res;
  }
}

function errorFor(res) {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    return new GitHubError("GitHub's rate limit is used up for now.", res.status, {
      rateLimited: true, reset: Number(res.headers.get("x-ratelimit-reset")) || null,
    });
  }
  if (res.status === 401) return new GitHubError("GitHub rejected the token.", 401, { unauthorized: true });
  if (res.status === 404) return new GitHubError("Not found on GitHub.", 404, { notFound: true });
  return new GitHubError(`GitHub returned an error (${res.status}).`, res.status);
}

export async function api(path, token) {
  const res = await request(githubApi() + path, { token });
  if (!res.ok) throw errorFor(res);
  return res.json();
}

/** All followers or following of a user as [{id, login, type}]. */
export async function fetchList(login, kind, token) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/users/${encodeURIComponent(login)}/${kind}?per_page=100&page=${page}`, token);
    for (const a of batch) out.push({ id: Number(a.id), login: a.login, type: a.type || "User" });
    if (batch.length < 100) return out;
  }
}

export async function graphql(query, variables, token) {
  const res = await request(githubApi() + "/graphql", {
    token, method: "POST", body: JSON.stringify({ query, variables }), headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw errorFor(res);
  const data = await res.json();
  if (data.errors && data.errors.length) throw new GitHubError(data.errors[0].message || "GraphQL error", res.status);
  return data.data;
}

// ------------------------------------------------------------------- OAuth

export function authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  const u = new URL(githubWeb() + "/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Converts GitHub's token response into dates. Expiry fields are absent when token expiry is off. */
export function normalizeTokens(d, now = Date.now()) {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token || null,
    accessExpiresAt: d.expires_in ? new Date(now + Number(d.expires_in) * 1000) : null,
    refreshExpiresAt: d.refresh_token_expires_in ? new Date(now + Number(d.refresh_token_expires_in) * 1000) : null,
  };
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(githubWeb() + "/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "content-type": "application/x-www-form-urlencoded", "User-Agent": "ghfstats" },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new GitHubError("Couldn't reach GitHub.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error || !data.access_token) {
    throw new GitHubError((data && (data.error_description || data.error)) || `Token request failed (${res.status}).`,
      res.status, { code: data && data.error });
  }
  return normalizeTokens(data);
}

export function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  return tokenRequest({
    client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier,
  });
}

export function refreshTokens({ clientId, clientSecret, refreshToken }) {
  return tokenRequest({
    client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken,
  });
}

/** Revokes the app's access for this user on GitHub. Best effort; returns true on success. */
export async function revokeGrant({ clientId, clientSecret, accessToken }) {
  try {
    const res = await fetch(`${githubApi()}/applications/${encodeURIComponent(clientId)}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "content-type": "application/json",
        "User-Agent": "ghfstats",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * Whether a user token can change who the user follows, checked without changing anything:
 * it asks GitHub to unfollow the user's own account, which can never be followed. GitHub checks
 * the Followers permission first, so a missing permission comes back as 403. Returns true, false,
 * or null when GitHub's answer doesn't settle it.
 */
export async function canChangeFollowing(token, login) {
  try {
    const res = await fetch(`${githubApi()}/user/following/${encodeURIComponent(login)}`, {
      method: "DELETE",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`, "User-Agent": "ghfstats" },
    });
    if (res.status === 403 && /followers/.test(res.headers.get("x-accepted-github-permissions") || "")) return false;
    if (res.status === 403) {
      const m = await res.json().catch(() => ({}));
      return /not accessible by integration/i.test(m.message || "") ? false : null;
    }
    return res.status === 204 || res.status === 404 || res.status === 422 ? true : null;
  } catch { return null; }
}
