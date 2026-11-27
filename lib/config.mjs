// Settings read from environment variables. See README "Sign in with GitHub".

export function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Neon (Vercel Marketplace) sets DATABASE_URL; some integrations use POSTGRES_URL. */
export function databaseUrl() {
  return env("DATABASE_URL") || env("POSTGRES_URL");
}

/** In-memory store, for local development and tests only. Data is lost on restart. */
export function useMemoryStore() {
  return env("GHFS_MEMORY_STORE") === "1";
}

export function githubClient() {
  return { clientId: env("GITHUB_CLIENT_ID"), clientSecret: env("GITHUB_CLIENT_SECRET") };
}

/** Sign-in is offered only when every piece it needs is configured. */
export function signInConfigured() {
  const { clientId, clientSecret } = githubClient();
  const secret = env("AUTH_SECRET");
  return Boolean(clientId && clientSecret && secret && secret.length >= 32 && (databaseUrl() || useMemoryStore()));
}

export function githubApi() {
  return (env("GHFS_GITHUB_API") || "https://api.github.com").replace(/\/+$/, "");
}

export function githubWeb() {
  return (env("GHFS_GITHUB_WEB") || "https://github.com").replace(/\/+$/, "");
}

/** Seconds a signed-in user must wait between manual syncs. */
export function syncCooldownSeconds() {
  const v = Number(env("GHFS_SYNC_COOLDOWN_SECONDS"));
  return Number.isFinite(v) && v >= 0 ? v : 120;
}

/** Accounts bigger than this aren't tracked (keeps snapshots inside free-tier limits). */
export const MAX_ACCOUNTS_PER_LIST = 10000;

/**
 * Following and unfollowing limits, enforced on the server. GitHub's Acceptable Use Policies ban
 * "automated starring or following" and following accounts "in large volume in a short period of
 * time", and its secondary rate limit allows at most 80 content-changing requests a minute. Each
 * action is one person the signed-in user picked; following is only offered for people who already
 * follow them (follow back), in small batches.
 */
export const FOLLOW_LIMITS = {
  unfollow: { perHour: 100, perDay: 300, batch: 50 },
  follow: { perHour: 20, perDay: 50, batch: 10 },
  minGapMs: 1000,
};

/** Milliseconds required between two follow or unfollow actions (lowered only in tests). */
export function followGapMs() {
  const v = Number(env("GHFS_FOLLOW_GAP_MS"));
  return Number.isFinite(v) && v >= 0 ? v : FOLLOW_LIMITS.minGapMs;
}
