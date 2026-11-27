// End-to-end tests for sign-in, snapshots, insights, cron and deletion, against a fake GitHub
// and the in-memory store, through the same local server as `npm run dev`.
// Run: node --test tests/
import assert from "node:assert";
import { after, before, test } from "node:test";
import { createFakeGitHub } from "./fake-github.mjs";

const CLIENT_ID = "Iv1.testclient", CLIENT_SECRET = "test-secret";
const fake = createFakeGitHub({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessTtl: 60 }); // short-lived: forces refresh
const acct = (id, login, type = "User") => ({ id, login, type });

let base, server, diff, cryptoLib, insights, storeLib, memory;

before(async () => {
  const gh = await fake.listen();
  Object.assign(process.env, { GHFS_GITHUB_API: gh, GHFS_GITHUB_WEB: gh, GHFS_SYNC_COOLDOWN_SECONDS: "0" });
  delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL;
  ({ startDevServer: server } = await import("../scripts/dev.mjs"));
  server = await server(0);
  base = `http://localhost:${server.address().port}`;
  diff = await import("../lib/diff.mjs");
  cryptoLib = await import("../lib/crypto.mjs");
  insights = await import("../lib/insights.mjs");
  storeLib = await import("../lib/store.mjs");
  memory = (await import("../lib/store-memory.mjs")).createMemoryStore();
  storeLib.setStoreForTests(memory);
});

after(async () => { server.close(); await fake.close(); });

function enableSignIn() {
  Object.assign(process.env, {
    GITHUB_CLIENT_ID: CLIENT_ID, GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    AUTH_SECRET: "x".repeat(40), GHFS_MEMORY_STORE: "1", CRON_SECRET: "cron-secret-value",
  });
}

/** Minimal cookie jar around fetch with manual redirects. */
function client() {
  const jar = new Map();
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || !value) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const go = async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url.startsWith("http") ? url : base + url, { redirect: "manual", ...opts, headers });
    absorb(res);
    return res;
  };
  const getJson = async (url, opts) => { const r = await go(url, opts); return { status: r.status, body: await r.json() }; };
  async function signIn() {
    const start = await go("/api/auth/login");
    assert.strictEqual(start.status, 302);
    const authorize = start.headers.get("location");
    assert.ok(authorize.startsWith(process.env.GHFS_GITHUB_WEB + "/login/oauth/authorize"));
    const back = await fetch(authorize, { redirect: "manual" });
    const cb = await go(back.headers.get("location"));
    return cb;
  }
  return { jar, go, getJson, signIn };
}

// ------------------------------------------------------------------ unit

test("diff finds follows and unfollows by id, so renames aren't changes", () => {
  const prev = { followers: [acct(1, "a"), acct(2, "b"), acct(3, "c")], following: [acct(1, "a"), acct(9, "x")] };
  const ev = diff.buildEvents(prev, [acct(1, "a"), acct(3, "c-renamed"), acct(4, "d")], [acct(1, "a"), acct(5, "e")]);
  assert.deepStrictEqual(ev.map((e) => `${e.kind}:${e.login}`).sort(),
    ["followed_you:d", "unfollowed_you:b", "you_followed:e", "you_unfollowed:x"]);
  assert.strictEqual(diff.countMutuals([acct(1, "a"), acct(2, "b")], [acct(2, "b"), acct(3, "c")]), 1);
  assert.deepStrictEqual(diff.dedupe([acct(1, "a"), acct(1, "a"), acct(2, "b")]).map((a) => a.id), [1, 2]);
});

test("tokens are encrypted and cookies signed; tampering is rejected", () => {
  enableSignIn();
  const sealed = cryptoLib.encrypt("ghu_secret");
  assert.ok(!sealed.includes("ghu_secret"));
  assert.strictEqual(cryptoLib.decrypt(sealed), "ghu_secret");
  const parts = sealed.split(".");
  parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("A") ? "BB" : "AA");
  assert.throws(() => cryptoLib.decrypt(parts.join(".")));
  const s = cryptoLib.sign("abc");
  assert.strictEqual(cryptoLib.unsign(s), "abc");
  assert.strictEqual(cryptoLib.unsign(s.replace("abc", "abd")), null);
  assert.strictEqual(cryptoLib.unsign("garbage"), null);
});

test("insight summaries", () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  const list = [
    { login: "star", followers: 5000, following: 10, createdAt: "2012-01-01T00:00:00Z" },
    { login: "f4f", followers: 20, following: 3000, createdAt: "2020-01-01T00:00:00Z" },
    { login: "fresh", followers: 0, following: 2, createdAt: "2026-11-01T00:00:00Z" },
    { login: "mid", followers: 50, following: 50, createdAt: "2019-01-01T00:00:00Z" },
  ];
  const s = insights.summarize(list, now);
  assert.deepStrictEqual(s.notable.map((a) => a.login), ["star", "mid", "f4f"]);
  assert.deepStrictEqual(s.followForFollow.map((a) => a.login), ["f4f"]);
  assert.deepStrictEqual(s.newAccounts.map((a) => a.login), ["fresh"]);
  assert.strictEqual(s.medianFollowers, 20);
  assert.strictEqual(s.combinedReach, 5070);
});

// ------------------------------------------------------------ end to end

test("static page is served and sign-in stays hidden until configured", async () => {
  for (const k of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET", "GHFS_MEMORY_STORE"]) delete process.env[k];
  const home = await fetch(base + "/");
  assert.strictEqual(home.status, 200);
  const html = await home.text();
  assert.match(html, /id="lookup"/);
  assert.match(html, /account\.js/);
  const c = client();
  assert.deepStrictEqual((await c.getJson("/api/config")).body, { signIn: false, signedIn: false });
  const login = await c.go("/api/auth/login");
  assert.strictEqual(login.headers.get("location"), "/?signin=unavailable");
  assert.strictEqual((await c.getJson("/api/me")).status, 503);
  assert.strictEqual((await fetch(base + "/dashboard")).status, 200);
});

test("full flow: sign in, baseline, changes, refresh, insights, cron, re-auth, sign out, delete", async () => {
  enableSignIn();
  fake.state.followers = [acct(1, "alice"), acct(2, "bob"), acct(3, "carol"), acct(4, "acme-bot", "Bot")];
  fake.state.following = [acct(2, "bob"), acct(7, "dave"), acct(8, "acme", "Organization")];
  fake.state.details.set(1, { followers: 9000, following: 3, createdAt: "2011-01-01T00:00:00Z" });

  const c = client();

  // A callback with a wrong state is refused.
  const bad = await c.go("/api/auth/callback?code=x&state=nope");
  assert.strictEqual(bad.headers.get("location"), "/?signin=expired");

  // Sign in.
  const cb = await c.signIn();
  assert.strictEqual(cb.status, 302);
  assert.strictEqual(cb.headers.get("location"), "/dashboard");
  assert.ok(c.jar.has("ghfs_session"));
  assert.ok(!c.jar.has("ghfs_oauth"));
  assert.deepStrictEqual((await c.getJson("/api/config")).body, { signIn: true, signedIn: true, login: "octo" });

  // Tokens are stored encrypted.
  const stored = await memory.getUser(1001);
  assert.ok(stored.accessToken.startsWith("v1.") && !stored.accessToken.includes("ghu_"));

  // Cross-site posts are blocked.
  const evil = await c.go("/api/sync", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.strictEqual(evil.status, 403);

  // Sign-in already stored the first snapshot as a baseline.
  let me = (await c.getJson("/api/me")).body;
  assert.ok(me.user.lastSnapshotAt, "sign-in should take the first snapshot");
  assert.strictEqual(me.followers.length, 4);
  assert.strictEqual(me.daily[0].mutuals, 1);

  // A sync with nothing changed records no changes.
  let r = await c.getJson("/api/sync", { method: "POST", headers: { origin: base } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.baseline, false);
  assert.strictEqual(r.body.changes, 0);
  assert.ok(fake.state.refreshCount >= 1, "short-lived token should have been refreshed");

  me = (await c.getJson("/api/me")).body;
  assert.strictEqual(me.followers.length, 4);
  assert.strictEqual(me.following.length, 3);
  assert.strictEqual(me.events.length, 0);
  assert.strictEqual(me.daily.length, 1);

  // Bob unfollows, erin follows, you unfollow dave; carol renames (not a change).
  fake.state.followers = [acct(1, "alice"), acct(3, "carol2"), acct(4, "acme-bot", "Bot"), acct(5, "erin")];
  fake.state.following = [acct(2, "bob"), acct(8, "acme", "Organization")];
  r = await c.getJson("/api/sync", { method: "POST", headers: { origin: base } });
  assert.strictEqual(r.body.changes, 3);
  me = (await c.getJson("/api/me")).body;
  assert.deepStrictEqual(me.events.map((e) => `${e.kind}:${e.login}`).sort(),
    ["followed_you:erin", "unfollowed_you:bob", "you_unfollowed:dave"]);
  assert.ok(me.followers.some((f) => f[0] === "carol2"));

  // Pagination over 100 accounts.
  fake.state.followers = Array.from({ length: 250 }, (_, i) => acct(100 + i, `user${i}`));
  r = await c.getJson("/api/sync", { method: "POST", headers: { origin: base } });
  me = (await c.getJson("/api/me")).body;
  assert.strictEqual(me.followers.length, 250);

  // Insights via GraphQL.
  fake.state.followers = [acct(1, "alice"), acct(5, "erin")];
  const ins = await c.getJson("/api/insights");
  assert.strictEqual(ins.status, 200, JSON.stringify(ins.body));
  assert.strictEqual(ins.body.notable[0].login, "alice");
  assert.strictEqual(ins.body.total, 2);

  // Signed-in lookups go through the server with the user's own token; only public user endpoints are allowed.
  const look = await c.go("/api/lookup?path=" + encodeURIComponent("/users/octo/followers?per_page=1&page=2"));
  assert.strictEqual(look.status, 200);
  assert.deepStrictEqual((await look.json()).map((a) => a.login), ["erin"]);
  assert.strictEqual((await c.getJson("/api/lookup?path=" + encodeURIComponent("/users/octo"))).body.login, "octo");
  assert.strictEqual((await c.getJson("/api/lookup?path=" + encodeURIComponent("/users/nobody-here"))).status, 404);
  for (const bad of ["/user", "/users/octo/repos", "/users/octo/../../user", "https://evil.example/users/octo", "/users/octo/followers?per_page=500"]) {
    assert.strictEqual((await c.getJson("/api/lookup?path=" + encodeURIComponent(bad))).status, 400, bad);
  }
  assert.strictEqual((await client().getJson("/api/lookup?path=%2Fusers%2Focto")).status, 401);

  // Cron needs the secret, then snapshots everyone.
  assert.strictEqual((await c.getJson("/api/cron/snapshot")).status, 401);
  const cron = await c.getJson("/api/cron/snapshot", { headers: { authorization: "Bearer cron-secret-value" } });
  assert.strictEqual(cron.status, 200);
  assert.strictEqual(cron.body.done, 1);

  // If GitHub stops accepting the refresh token, the user is asked to sign in again.
  fake.state.refresh.clear();
  const u = await memory.getUser(1001);
  await memory.updateTokens(1001, { ...u, accessExpiresAt: new Date(Date.now() - 1000) });
  r = await c.getJson("/api/sync", { method: "POST", headers: { origin: base } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.reauth, true);
  me = (await c.getJson("/api/me")).body;
  assert.strictEqual(me.user.needsReauth, true);
  const cron2 = await c.getJson("/api/cron/snapshot", { headers: { authorization: "Bearer cron-secret-value" } });
  assert.strictEqual(cron2.body.total, 0, "users needing re-auth are skipped");
  const eventsBefore = me.events.length;
  assert.ok(eventsBefore > 3);
  await c.signIn();
  me = (await c.getJson("/api/me")).body;
  assert.strictEqual(me.user.needsReauth, false);
  assert.strictEqual(me.events.length, eventsBefore, "history survives signing in again");

  // Sign out ends the session but keeps data.
  const out = await c.getJson("/api/auth/logout", { method: "POST", headers: { origin: base } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual((await c.getJson("/api/me")).status, 401);
  assert.ok(await memory.getUser(1001));

  // Delete removes everything and revokes the grant on GitHub.
  await c.signIn();
  const del = await c.getJson("/api/account", { method: "DELETE", headers: { origin: base } });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.revoked, true);
  assert.strictEqual(fake.state.revoked.length, 1);
  assert.strictEqual(await memory.getUser(1001), null);
  assert.strictEqual((await c.getJson("/api/me")).status, 401);
});

test("a stolen session cookie can't be forged", async () => {
  enableSignIn();
  const c = client();
  c.jar.set("ghfs_session", "made-up.signature");
  assert.strictEqual((await c.getJson("/api/me")).status, 401);
});

test("follow and unfollow: only picked people in your lists, follow-back only, limits, permission errors", async () => {
  enableSignIn();
  process.env.GHFS_FOLLOW_GAP_MS = "0";
  fake.state.followMode = "ok";
  fake.state.followCalls = [];
  fake.state.followers = [acct(1, "alice"), acct(2, "bob")];
  fake.state.following = [acct(2, "bob"), acct(7, "dave")];
  const c = client();
  await c.signIn();
  assert.strictEqual((await c.getJson("/api/sync", { method: "POST", headers: { origin: base } })).status, 200);
  const post = (body, origin = base) => c.getJson("/api/follow", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  assert.strictEqual((await post({ action: "unfollow", login: "dave" }, "https://evil.example")).status, 403);
  assert.strictEqual((await client().getJson("/api/follow", { method: "POST", headers: { origin: base }, body: JSON.stringify({ action: "unfollow", login: "dave" }) })).status, 401);
  assert.strictEqual((await post({ action: "unfollow", login: "../user" })).status, 400);
  assert.strictEqual((await post({ action: "block", login: "dave" })).status, 400);

  // Unfollow someone you follow: GitHub is called and your lists and history update.
  let r = await post({ action: "unfollow", login: "Dave" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(fake.state.followCalls.at(-1), { method: "DELETE", login: "dave" });
  let me = (await c.getJson("/api/me")).body;
  assert.ok(!me.following.some((f) => f[0] === "dave"));
  assert.ok(me.events.some((e) => e.kind === "you_unfollowed" && e.login === "dave"));

  // You can't unfollow someone you don't follow, or follow a stranger; follow-back works.
  assert.strictEqual((await post({ action: "unfollow", login: "dave" })).status, 409);
  assert.strictEqual((await post({ action: "follow", login: "stranger" })).status, 409);
  assert.strictEqual((await post({ action: "follow", login: "bob" })).status, 409, "already following");
  r = await post({ action: "follow", login: "alice" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(fake.state.followCalls.at(-1), { method: "PUT", login: "alice" });
  me = (await c.getJson("/api/me")).body;
  assert.ok(me.following.some((f) => f[0] === "alice"));
  const calls = fake.state.followCalls.length;

  // A sync afterwards sees no new change (the store already matches GitHub).
  r = await c.getJson("/api/sync", { method: "POST", headers: { origin: base } });
  assert.strictEqual(r.body.changes, 0);

  // Missing Followers permission and GitHub's rate limit come back as clear errors.
  fake.state.followMode = "no-permission";
  r = await post({ action: "unfollow", login: "bob" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.needsPermission, true);
  fake.state.followMode = "rate-limited";
  r = await post({ action: "unfollow", login: "bob" });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.retryAfter, 30);
  fake.state.followMode = "ok";
  me = (await c.getJson("/api/me")).body;
  assert.ok(me.following.some((f) => f[0] === "bob"), "failed calls change nothing");

  // The minimum gap between actions.
  process.env.GHFS_FOLLOW_GAP_MS = "60000";
  r = await post({ action: "unfollow", login: "bob" });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(fake.state.followCalls.length, calls + 2, "GitHub isn't called when ghfstats says slow down");
  process.env.GHFS_FOLLOW_GAP_MS = "0";

  // The hourly limit on follows (20): pretend 19 more follow-backs happened in the last hour.
  const u = (await c.getJson("/api/me")).body.user;
  const now = Date.now();
  for (let i = 0; i < 19; i++) {
    await memory.applyFollowChange(u.id, { kind: "you_followed", id: 500 + i, login: `x${i}`, type: "User", at: new Date(now - 60000 + i) });
  }
  fake.state.followers.push(acct(3, "carol"));
  await c.getJson("/api/sync", { method: "POST", headers: { origin: base } });
  r = await post({ action: "follow", login: "carol" });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.limit, true);
  assert.match(r.body.error, /20 accounts in the last hour/);
  delete process.env.GHFS_FOLLOW_GAP_MS;

  // Re-authorize: revokes the grant so GitHub shows its consent screen again, ends the session, keeps the data.
  const revokedBefore = fake.state.revoked.length;
  assert.strictEqual((await c.go("/api/auth/reauthorize", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  r = await c.getJson("/api/auth/reauthorize", { method: "POST", headers: { origin: base } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.revoked, true);
  assert.strictEqual(r.body.next, "/api/auth/login");
  assert.strictEqual(fake.state.revoked.length, revokedBefore + 1);
  assert.strictEqual((await c.getJson("/api/me")).status, 401, "session ended");
  assert.ok(await memory.getUser(u.id), "data kept");
  fake.state.installed = false;
  const back = await c.signIn();
  assert.strictEqual(back.headers.get("location"), "/dashboard?install=needed", "sign-in checks the App is installed");
  me = (await c.getJson("/api/me")).body;
  assert.ok(me.following.some((f) => f[0] === "alice"), "history is still there after signing in again");

  // Without the App installed, GitHub refuses follows; ghfstats turns that into the install step.
  process.env.GITHUB_APP_SLUG = "ghf-stats-test";
  process.env.GHFS_FOLLOW_GAP_MS = "0";
  fake.state.followMode = "no-permission";
  r = await post({ action: "unfollow", login: "bob" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.needsInstall, true);
  assert.match(r.body.installUrl, /\/apps\/ghf-stats-test\/installations\/new$/);
  assert.match((await c.getJson("/api/me")).body.installUrl, /\/apps\/ghf-stats-test\/installations\/new$/);
  // Installed but still refused: the permission message and re-authorize.
  fake.state.installed = true;
  r = await post({ action: "unfollow", login: "bob" });
  assert.strictEqual(r.body.needsPermission, true);
  fake.state.followMode = "ok";
  delete process.env.GITHUB_APP_SLUG;
  delete process.env.GHFS_FOLLOW_GAP_MS;
});

test("rate limits: sign-in per IP, and the limiter counts by hashed key", async () => {
  enableSignIn();
  const { RATE_LIMITS, rateLimit } = await import("../lib/ratelimit.mjs");
  const ipA = { headers: { "x-real-ip": "203.0.113.7" }, redirect: "manual" };
  const ipB = { headers: { "x-real-ip": "198.51.100.4" }, redirect: "manual" };
  for (let i = 0; i < RATE_LIMITS.signin.limit; i++) {
    const r = await fetch(base + "/api/auth/login", ipA);
    assert.ok(r.headers.get("location").startsWith(process.env.GHFS_GITHUB_WEB), `sign-in ${i + 1} allowed`);
  }
  const blocked = await fetch(base + "/api/auth/login", ipA);
  assert.strictEqual(blocked.headers.get("location"), "/?signin=busy");
  const other = await fetch(base + "/api/auth/login", ipB);
  assert.ok(other.headers.get("location").startsWith(process.env.GHFS_GITHUB_WEB), "another IP still gets in");

  // The limiter itself: allowed up to the limit, then a 429 with Retry-After. Keys never hold the raw id.
  const seen = [];
  const fakeStore = { counts: new Map(), async hit(key, w) { seen.push(key); const n = (this.counts.get(key) || 0) + 1; this.counts.set(key, n); return { count: n, resetAt: new Date(Date.now() + w * 1000) }; } };
  for (let i = 0; i < RATE_LIMITS.insights.limit; i++) assert.strictEqual(await rateLimit(fakeStore, "insights", 4242), null);
  const res = await rateLimit(fakeStore, "insights", 4242);
  assert.strictEqual(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.ok(seen.every((k) => !k.includes("4242")), "keys are hashed");
  // A store that can't count never blocks.
  assert.strictEqual(await rateLimit({ async hit() { throw new Error("down"); } }, "insights", 1), null);
});

test("first sign-in without the App installed goes straight to GitHub's install page", async () => {
  enableSignIn();
  process.env.GITHUB_APP_SLUG = "ghf-stats-test";
  const prevMe = fake.state.me;
  fake.state.me = { id: 777001, login: "newcomer", name: "New Comer", avatar_url: "" };
  fake.state.installed = false;
  try {
    const c = client();
    const first = await c.signIn();
    assert.match(first.headers.get("location"), /\/apps\/ghf-stats-test\/installations\/new$/);
    assert.strictEqual((await c.getJson("/api/me")).status, 200, "signed in before leaving for GitHub");
    const again = await client().signIn();
    assert.strictEqual(again.headers.get("location"), "/dashboard?install=needed", "later sign-ins aren't bounced");
  } finally {
    fake.state.me = prevMe; fake.state.installed = true; delete process.env.GITHUB_APP_SLUG;
  }
});
