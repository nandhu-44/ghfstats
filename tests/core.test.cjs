// Unit tests for the web app's logic. Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const core = require("../public/app.js");

const acct = (login, type = "User", id = 1) => core.compact({ login, id, type });
const logins = (list) => list.map((a) => a.login);

test("lists, mutuals and follow-back sets", () => {
  const snap = {
    t: "2026-01-01T00:00:00Z",
    followers: [acct("alice"), acct("Bob"), acct("carol")],
    following: [acct("bob"), acct("dave"), acct("acme", "Organization"), acct("dependabot", "Bot")],
  };
  const r = core.analyse(snap, null);
  assert.deepStrictEqual(logins(r.mutuals), ["Bob"]); // case-insensitive match
  assert.deepStrictEqual(logins(r.notFollowingBack), ["acme", "dave", "dependabot"]);
  assert.deepStrictEqual(logins(r.youDontFollowBack), ["alice", "carol"]);
  assert.deepStrictEqual(core.typeCounts(r.following), { User: 2, Organization: 1, Bot: 1 });
  assert.strictEqual(r.since, null);
});

test("unfollowers via snapshot diff, history and all-time list", () => {
  const user = { login: "me", snapshots: [], events: [], lastChecked: null };
  const s1 = { t: "2026-01-01T00:00:00Z", followers: [acct("a"), acct("b"), acct("c")], following: [acct("a"), acct("x")] };
  const first = core.recordCheck(user, s1);
  assert.ok(first.saved);
  assert.strictEqual(user.events.length, 0);

  // No change: no new snapshot.
  const same = core.recordCheck(user, { ...s1, t: "2026-01-02T00:00:00Z" });
  assert.ok(!same.saved);
  assert.strictEqual(user.snapshots.length, 1);
  assert.strictEqual(user.lastChecked, "2026-01-02T00:00:00Z");

  // b and c unfollow, d follows, you unfollow x.
  const s2 = { t: "2026-01-03T00:00:00Z", followers: [acct("a"), acct("d")], following: [acct("a")] };
  const { result } = core.recordCheck(user, s2);
  assert.deepStrictEqual(logins(result.unfollowers), ["b", "c"]);
  assert.deepStrictEqual(logins(result.newFollowers), ["d"]);
  assert.deepStrictEqual(logins(result.youUnfollowed), ["x"]);
  assert.strictEqual(result.since, s1.t);

  // c follows again later: drops out of the all-time unfollowers list.
  const s3 = { t: "2026-01-04T00:00:00Z", followers: [acct("a"), acct("d"), acct("c")], following: [acct("a")] };
  core.recordCheck(user, s3);
  const all = core.allTimeUnfollowers(user.events, core.analyse(s3, null).followers);
  assert.deepStrictEqual(logins(all), ["b"]);
  assert.strictEqual(all[0].when, s2.t);
});

test("import: own export format and Python CLI snapshot", () => {
  const store = { version: 1, users: {} };
  const exported = { version: 1, users: { me: { login: "me", lastChecked: "2026-01-01T00:00:00Z",
    snapshots: [{ t: "2026-01-01T00:00:00Z", followers: [acct("a")], following: [] }],
    events: [{ t: "2026-01-01T00:00:00Z", e: "followed_you", login: "a", id: 1, type: "User" }] } } };
  assert.strictEqual(core.mergeImport(store, exported), 1);
  assert.strictEqual(core.mergeImport(store, exported), 0); // no duplicates
  assert.strictEqual(store.users.me.events.length, 1);

  const cli = { username: "Me", taken_at: "2026-02-01T00:00:00Z",
    followers: { a: { login: "a", id: 1, type: "User" } },
    following: { org: { login: "Org", id: 9, type: "Organization" } } };
  assert.strictEqual(core.mergeImport(store, cli), 1);
  const snaps = store.users.me.snapshots;
  assert.strictEqual(snaps.length, 2);
  assert.deepStrictEqual(snaps[1].following, [["Org", 9, "Organization"]]);
  assert.throws(() => core.mergeImport(store, { nope: true }));
});
