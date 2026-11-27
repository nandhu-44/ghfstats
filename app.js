/* ghfstats: GitHub follower stats that run entirely in the browser.
 *
 * - Fetches followers and following from the GitHub REST API (paginated).
 * - Saves a snapshot in localStorage on each check and diffs it against the
 *   previous one to find unfollowers (GitHub has no unfollow API).
 * - Optional token is sent only to api.github.com and kept in this browser.
 */
(function (root) {
  "use strict";

  const API = "https://api.github.com";
  const PER_PAGE = 100;
  const STORE_KEY = "ghfstats:v1";
  const TOKEN_KEY = "ghfstats:token";
  const MAX_SNAPSHOTS = 20;

  // ------------------------------------------------------------------ core

  /** Compact account record kept in snapshots: [login, id, type]. */
  function compact(a) { return [a.login, a.id || 0, a.type || "User"]; }
  function expand(c) { return { login: c[0], id: c[1], type: c[2] }; }
  function toMap(list) {
    const m = new Map();
    for (const c of list) m.set(c[0].toLowerCase(), expand(c));
    return m;
  }
  function byLogin(a, b) { return a.login.toLowerCase().localeCompare(b.login.toLowerCase()); }
  function pick(map, keys) { return keys.map(k => map.get(k)).sort(byLogin); }

  /** Compare a snapshot with the previous one. Snapshots: {t, followers:[...], following:[...]} */
  function analyse(snap, prev) {
    const fol = toMap(snap.followers), ing = toMap(snap.following);
    const fk = [...fol.keys()], ik = [...ing.keys()];
    const r = {
      followers: pick(fol, fk),
      following: pick(ing, ik),
      mutuals: pick(fol, fk.filter(k => ing.has(k))),
      notFollowingBack: pick(ing, ik.filter(k => !fol.has(k))),
      youDontFollowBack: pick(fol, fk.filter(k => !ing.has(k))),
      unfollowers: [], newFollowers: [], youUnfollowed: [], youFollowed: [],
      since: prev ? prev.t : null,
    };
    if (prev) {
      const pf = toMap(prev.followers), pi = toMap(prev.following);
      r.unfollowers = pick(pf, [...pf.keys()].filter(k => !fol.has(k)));
      r.newFollowers = pick(fol, fk.filter(k => !pf.has(k)));
      r.youUnfollowed = pick(pi, [...pi.keys()].filter(k => !ing.has(k)));
      r.youFollowed = pick(ing, ik.filter(k => !pi.has(k)));
    }
    return r;
  }

  function hasChanges(r) {
    return r.unfollowers.length + r.newFollowers.length + r.youUnfollowed.length + r.youFollowed.length > 0;
  }

  function buildEvents(r, t) {
    const ev = [];
    const add = (list, e) => list.forEach(a => ev.push({ t, e, login: a.login, id: a.id, type: a.type, since: r.since }));
    add(r.unfollowers, "unfollowed_you");
    add(r.newFollowers, "followed_you");
    add(r.youUnfollowed, "you_unfollowed");
    add(r.youFollowed, "you_followed");
    return ev;
  }

  /** Accounts whose latest follow event is an unfollow and who still don't follow you. */
  function allTimeUnfollowers(events, currentFollowers) {
    const last = new Map();
    for (const e of events) {
      if (e.e === "unfollowed_you" || e.e === "followed_you") last.set(e.login.toLowerCase(), e);
    }
    const cur = new Set(currentFollowers.map(a => a.login.toLowerCase()));
    return [...last.values()]
      .filter(e => e.e === "unfollowed_you" && !cur.has(e.login.toLowerCase()))
      .sort((a, b) => (a.t < b.t ? 1 : -1))
      .map(e => ({ login: e.login, id: e.id, type: e.type, when: e.t }));
  }

  function typeCounts(list) {
    const c = {};
    for (const a of list) c[a.type] = (c[a.type] || 0) + 1;
    return c;
  }

  /** Record a check into the per-user store. Returns {result, saved}. */
  function recordCheck(userStore, snap) {
    const prev = userStore.snapshots[userStore.snapshots.length - 1] || null;
    const r = analyse(snap, prev);
    let saved = false;
    if (!prev || hasChanges(r)) {
      userStore.snapshots.push(snap);
      if (userStore.snapshots.length > MAX_SNAPSHOTS) userStore.snapshots.splice(0, userStore.snapshots.length - MAX_SNAPSHOTS);
      userStore.events.push(...buildEvents(r, snap.t));
      saved = true;
    }
    userStore.lastChecked = snap.t;
    return { result: r, saved };
  }

  /** Merge imported data (our export format or a CLI snapshot file) into store. */
  function mergeImport(store, data) {
    let added = 0;
    const ensure = (login) => {
      const k = login.toLowerCase();
      store.users[k] = store.users[k] || { login, snapshots: [], events: [], lastChecked: null };
      return store.users[k];
    };
    const addSnap = (u, s) => {
      if (!u.snapshots.some(x => x.t === s.t)) { u.snapshots.push(s); added++; }
      u.snapshots.sort((a, b) => (a.t < b.t ? -1 : 1));
      if (u.snapshots.length > MAX_SNAPSHOTS) u.snapshots.splice(0, u.snapshots.length - MAX_SNAPSHOTS);
    };
    if (data && data.users && typeof data.users === "object") {
      for (const src of Object.values(data.users)) {
        if (!src || !src.login) continue;
        const u = ensure(src.login);
        (src.snapshots || []).forEach(s => addSnap(u, s));
        const seen = new Set(u.events.map(e => e.t + e.e + e.login));
        for (const e of src.events || []) if (!seen.has(e.t + e.e + e.login)) u.events.push(e);
        u.events.sort((a, b) => (a.t < b.t ? -1 : 1));
        if (!u.lastChecked || (src.lastChecked && src.lastChecked > u.lastChecked)) u.lastChecked = src.lastChecked;
      }
    } else if (data && data.username && data.taken_at && data.followers) {
      // Snapshot file written by the Python CLI (cli/ghfstats.py).
      const u = ensure(data.username);
      addSnap(u, {
        t: data.taken_at,
        followers: Object.values(data.followers).map(compact),
        following: Object.values(data.following || {}).map(compact),
      });
    } else {
      throw new Error("That file isn't a ghfstats export or snapshot.");
    }
    return added;
  }

  function avatar(a, size) {
    return a.id ? `https://avatars.githubusercontent.com/u/${a.id}?v=4&s=${size || 64}`
                : `https://github.com/${encodeURIComponent(a.login)}.png?size=${size || 64}`;
  }

  // Expose pure functions for tests (Node).
  const core = { analyse, hasChanges, buildEvents, allTimeUnfollowers, typeCounts, recordCheck, mergeImport, compact };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }

  // ------------------------------------------------------------- browser

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k in n && k !== "list") n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  function safeGet(storage, key) { try { return storage.getItem(key); } catch { return null; } }
  function safeSet(storage, key, val) { try { storage.setItem(key, val); return true; } catch { return false; } }
  function safeDel(storage, key) { try { storage.removeItem(key); } catch { /* ignore */ } }

  function loadStore() {
    try {
      const s = JSON.parse(safeGet(localStorage, STORE_KEY) || "null");
      if (s && s.users) return s;
    } catch { /* fall through */ }
    return { version: 1, users: {} };
  }

  function saveStore(store) {
    let json = JSON.stringify(store);
    while (!safeSet(localStorage, STORE_KEY, json)) {
      // Out of space: drop the oldest snapshot of the user with the most.
      const users = Object.values(store.users).filter(u => u.snapshots.length > 1);
      if (!users.length) return false;
      users.sort((a, b) => b.snapshots.length - a.snapshots.length)[0].snapshots.shift();
      json = JSON.stringify(store);
    }
    return true;
  }

  let store = loadStore();
  let view = null; // {login, result, user, unfollowersAll}
  let tab = "notFollowingBack";
  const typeFilter = new Set();

  class ApiError extends Error {}

  async function api(path, token) {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try { res = await fetch(API + path, { headers }); }
    catch { throw new ApiError("Couldn't reach GitHub. Check your connection and try again."); }
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) api.remaining = Number(remaining);
    if (res.ok) return res.json();
    if ((res.status === 403 || res.status === 429) && remaining === "0") {
      const reset = new Date(Number(res.headers.get("x-ratelimit-reset")) * 1000);
      throw new ApiError(`GitHub's rate limit is used up until ${reset.toLocaleTimeString()}.` +
        (token ? "" : " Add a token to get 5,000 requests an hour."));
    }
    if (res.status === 401) throw new ApiError("GitHub rejected the token. Check it or remove it.");
    if (res.status === 404) throw new ApiError("No GitHub account with that username.");
    throw new ApiError(`GitHub returned an error (${res.status}). Try again in a moment.`);
  }

  async function fetchAll(login, kind, token, onPage) {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await api(`/users/${encodeURIComponent(login)}/${kind}?per_page=${PER_PAGE}&page=${page}`, token);
      out.push(...batch.map(compact));
      onPage(out.length);
      if (batch.length < PER_PAGE) return out;
    }
  }

  function setStatus(msg, isError) {
    $("status").textContent = msg;
    $("status").className = isError ? "error" : "";
  }

  function fmtTime(t) {
    if (!t) return "";
    const d = new Date(t);
    return isNaN(d) ? t : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function getToken() { return $("token").value.trim(); }

  async function check(login) {
    login = login.trim().replace(/^@/, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/.*$/, "");
    if (!login) return;
    const token = getToken();
    if ($("rememberToken").checked && token) safeSet(localStorage, TOKEN_KEY, token);
    else safeDel(localStorage, TOKEN_KEY);

    $("go").disabled = true;
    setStatus(`Looking up ${login}…`);
    try {
      const user = await api(`/users/${encodeURIComponent(login)}`, token);
      const total = (user.followers || 0) + (user.following || 0);
      let a = 0, b = 0;
      const progress = () => setStatus(`Fetching ${a + b} of ${total} accounts…`);
      const followers = await fetchAll(user.login, "followers", token, n => { a = n; progress(); });
      const following = await fetchAll(user.login, "following", token, n => { b = n; progress(); });

      const key = user.login.toLowerCase();
      store.users[key] = store.users[key] || { login: user.login, snapshots: [], events: [], lastChecked: null };
      const u = store.users[key];
      u.login = user.login;
      const snap = { t: new Date().toISOString(), followers, following };
      const { result } = recordCheck(u, snap);
      const stored = saveStore(store);

      view = { login: user.login, user, result, events: u.events, first: !result.since };
      try {
        const url = new URL(location.href);
        url.searchParams.set("user", user.login);
        history.replaceState(null, "", url);
      } catch { /* e.g. opened from file:// */ }
      render();
      const rl = api.remaining != null ? ` ${api.remaining} GitHub requests left this hour.` : "";
      setStatus((stored ? `Checked ${fmtTime(snap.t)}.` : "Checked, but this browser couldn't save the snapshot.") + rl, !stored);
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : `Something went wrong: ${e.message}`, true);
    } finally {
      $("go").disabled = false;
      renderDataInfo();
    }
  }

  const TABS = [
    ["notFollowingBack", "Not following back"],
    ["youDontFollowBack", "You don't follow back"],
    ["mutuals", "Mutuals"],
    ["unfollowersAll", "Unfollowed you"],
    ["followers", "Followers"],
    ["following", "Following"],
  ];

  function listFor(key) {
    if (key === "unfollowersAll") return allTimeUnfollowers(view.events, view.result.followers);
    return view.result[key];
  }

  function typeLabel(c) {
    return Object.entries(c).map(([k, v]) => `${v} ${k === "Organization" ? (v === 1 ? "org" : "orgs") : k === "Bot" ? (v === 1 ? "bot" : "bots") : (v === 1 ? "user" : "users")}`).join(", ");
  }

  function render() {
    const r = view.result, user = view.user;
    $("results").hidden = false;

    $("profile").replaceChildren(
      el("img", { src: user.avatar_url, alt: "" }),
      el("div", null,
        el("div", { class: "name" }, el("a", { href: user.html_url, target: "_blank", rel: "noopener" }, user.name || user.login)),
        el("div", { class: "meta" }, `@${user.login} · ${user.type}${user.public_repos != null ? ` · ${user.public_repos} public repos` : ""}`)));

    const stat = (key, label, n, sub) => {
      const b = el("button", { class: "stat", type: "button" }, el("b", null, String(n)), el("span", null, label), sub ? el("small", null, sub) : null);
      b.onclick = () => { tab = key; renderList(); $("tabs").scrollIntoView({ behavior: "smooth", block: "start" }); };
      return b;
    };
    $("stats").replaceChildren(
      stat("followers", "Followers", r.followers.length, typeLabel(typeCounts(r.followers))),
      stat("following", "Following", r.following.length, typeLabel(typeCounts(r.following))),
      stat("mutuals", "Mutuals", r.mutuals.length),
      stat("notFollowingBack", "Not following back", r.notFollowingBack.length),
      stat("youDontFollowBack", "You don't follow back", r.youDontFollowBack.length),
      stat("unfollowersAll", "Unfollowed you", listFor("unfollowersAll").length, "since you started checking"));

    const ch = $("changes");
    ch.replaceChildren();
    if (view.first) {
      ch.append(el("p", null, "First check for this account. A snapshot is saved in this browser; check again later to see who unfollowed."));
    } else {
      const line = (cls, label, list) => list.length
        ? el("p", { class: cls }, `${label} (${list.length}): `, ...list.flatMap((a, i) => [i ? ", " : "", el("a", { href: `https://github.com/${a.login}`, target: "_blank", rel: "noopener" }, a.login)]))
        : null;
      const parts = [
        line("bad", "Unfollowed you", r.unfollowers), line("good", "New followers", r.newFollowers),
        line("", "You unfollowed", r.youUnfollowed), line("", "You followed", r.youFollowed),
      ].filter(Boolean);
      ch.append(el("p", null, el("strong", null, `Since your last change on ${fmtTime(r.since)}`)));
      if (parts.length) ch.append(...parts); else ch.append(el("p", null, "No changes."));
    }

    renderList();
    renderHistory();
  }

  function renderList() {
    if (!view) return;
    $("tabs").replaceChildren(...TABS.map(([key, label]) => {
      const b = el("button", { type: "button", role: "tab" }, `${label} `, el("b", null, String(listFor(key).length)));
      b.setAttribute("aria-selected", String(key === tab));
      b.onclick = () => { tab = key; renderList(); };
      return b;
    }));

    const full = listFor(tab);
    const counts = typeCounts(full);
    for (const t of [...typeFilter]) if (!counts[t]) typeFilter.delete(t);
    $("typeChips").replaceChildren(...Object.keys(counts).sort().map(t => {
      const b = el("button", { type: "button" }, `${t} ${counts[t]}`);
      b.setAttribute("aria-pressed", String(typeFilter.has(t)));
      b.onclick = () => { typeFilter.has(t) ? typeFilter.delete(t) : typeFilter.add(t); renderList(); };
      return b;
    }));

    const q = $("filter").value.trim().toLowerCase();
    const shown = full.filter(a => (!q || a.login.toLowerCase().includes(q)) && (!typeFilter.size || typeFilter.has(a.type)));
    const frag = document.createDocumentFragment();
    for (const a of shown) {
      frag.append(el("a", { class: "acct", href: `https://github.com/${a.login}`, target: "_blank", rel: "noopener", title: a.when ? `Unfollowed around ${fmtTime(a.when)}` : a.login },
        el("img", { src: avatar(a), alt: "", loading: "lazy", width: 32, height: 32 }),
        el("span", { class: "login" }, a.login),
        el("span", { class: `type ${a.type.toLowerCase()}` }, a.type)));
    }
    $("list").replaceChildren(frag);
    $("emptyList").hidden = shown.length > 0;
    $("emptyList").textContent = tab === "unfollowersAll" && !full.length
      ? "No unfollows recorded yet. They show up from your second check on."
      : "Nobody here.";
  }

  const EV_LABEL = { unfollowed_you: "Unfollowed you", followed_you: "Followed you", you_unfollowed: "You unfollowed", you_followed: "You followed" };

  function renderHistory() {
    const rows = view.events.slice(-500).reverse().map(e => el("tr", null,
      el("td", null, fmtTime(e.t)),
      el("td", { class: `ev-${e.e}` }, EV_LABEL[e.e] || e.e),
      el("td", null, el("a", { href: `https://github.com/${e.login}`, target: "_blank", rel: "noopener" }, e.login)),
      el("td", null, e.type)));
    $("history").replaceChildren(...(rows.length ? rows
      : [el("tr", null, el("td", { colspan: 4, class: "empty" }, "No changes recorded yet."))]));
  }

  function renderDataInfo() {
    const users = Object.values(store.users);
    $("dataInfo").textContent = users.length
      ? `Saved: ${users.map(u => `${u.login} (${u.snapshots.length} snapshot${u.snapshots.length === 1 ? "" : "s"}, last checked ${fmtTime(u.lastChecked)})`).join("; ")}.`
      : "Nothing saved yet.";
  }

  function init() {
    const saved = safeGet(localStorage, TOKEN_KEY);
    if (saved) { $("token").value = saved; $("rememberToken").checked = true; }

    $("lookup").onsubmit = (e) => { e.preventDefault(); check($("username").value); };
    $("filter").oninput = renderList;
    $("rememberToken").onchange = () => { if (!$("rememberToken").checked) safeDel(localStorage, TOKEN_KEY); };

    $("exportBtn").onclick = () => {
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `ghfstats-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $("importFile").onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const n = mergeImport(store, JSON.parse(await f.text()));
        saveStore(store);
        setStatus(`Imported ${n} snapshot${n === 1 ? "" : "s"}.`);
        renderDataInfo();
      } catch (err) { setStatus(`Couldn't import that file: ${err.message}`, true); }
    };
    $("clearBtn").onclick = () => {
      if (!confirm("Delete every saved snapshot and your change history from this browser?")) return;
      store = { version: 1, users: {} };
      safeDel(localStorage, STORE_KEY);
      safeDel(localStorage, TOKEN_KEY);
      $("token").value = ""; $("rememberToken").checked = false;
      view = null; $("results").hidden = true;
      setStatus("Saved data cleared.");
      renderDataInfo();
    };

    renderDataInfo();
    const qUser = new URLSearchParams(location.search).get("user");
    const lastUser = Object.values(store.users).sort((a, b) => (a.lastChecked < b.lastChecked ? 1 : -1))[0];
    if (qUser) { $("username").value = qUser; check(qUser); }
    else if (lastUser) $("username").value = lastUser.login;
  }

  init();
})(typeof window !== "undefined" ? window : globalThis);
