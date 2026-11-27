/* ghfstats dashboard for signed-in users. Data comes from /api/me; lists are worked out here. */
(function () {
  "use strict";

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
  const SVG = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  };
  const fmtTime = (t) => {
    if (!t) return "";
    const d = new Date(t);
    return isNaN(d) ? String(t) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  };
  const fmtNum = (n) => Number(n).toLocaleString();
  const byLogin = (a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase());
  const unpack = (c) => ({ login: c[0], id: c[1], type: c[2] });

  let data = null, view = null, tab = "notFollowingBack";
  const typeFilter = new Set();

  // Following and unfollowing picked accounts. The server enforces the same limits.
  const LIMITS = { unfollow: { batch: 50, perHour: 100, perDay: 300, gapMs: 1500 }, follow: { batch: 10, perHour: 20, perDay: 50, gapMs: 3000 } };
  const TAB_ACTION = { notFollowingBack: "unfollow", following: "unfollow", mutuals: "unfollow", unfollowers: "unfollow",
    youDontFollowBack: "follow", followers: "follow" };
  let selecting = false, running = null;
  const selected = new Map(); // id -> account
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

  function setStatus(msg, isError) {
    $("status").textContent = msg || "";
    $("status").className = isError ? "error" : "";
  }

  function showNotice(msg, cls) {
    const n = $("notice");
    n.hidden = !msg;
    n.className = "notice" + (cls ? " " + cls : "");
    n.replaceChildren();
    if (msg) n.append(msg);
  }

  async function call(path, opts) {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" }, ...opts });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, body: body || {} };
  }

  function compute(d) {
    const followers = d.followers.map(unpack).sort(byLogin);
    const following = d.following.map(unpack).sort(byLogin);
    const fol = new Set(followers.map((a) => a.id)), ing = new Set(following.map((a) => a.id));
    // Unfollowed you: the latest follow event for that account is an unfollow and they still don't follow you.
    const last = new Map();
    for (const e of d.events.slice().reverse()) {
      if (e.kind === "unfollowed_you" || e.kind === "followed_you") last.set(e.id, e);
    }
    const unfollowers = [...last.values()]
      .filter((e) => e.kind === "unfollowed_you" && !fol.has(e.id))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((e) => ({ login: e.login, id: e.id, type: e.type, when: e.at }));
    const weekAgo = Date.now() - 7 * 86400e3;
    const recent = d.events.filter((e) => Date.parse(e.at) >= weekAgo);
    return {
      followers, following,
      mutuals: followers.filter((a) => ing.has(a.id)),
      notFollowingBack: following.filter((a) => !fol.has(a.id)),
      youDontFollowBack: followers.filter((a) => !ing.has(a.id)),
      unfollowers,
      recent,
    };
  }

  const TABS = [
    ["notFollowingBack", "Not following back"],
    ["youDontFollowBack", "You don't follow back"],
    ["mutuals", "Mutuals"],
    ["unfollowers", "Unfollowed you"],
    ["followers", "Followers"],
    ["following", "Following"],
  ];

  function typeCounts(list) {
    const c = {};
    for (const a of list) c[a.type] = (c[a.type] || 0) + 1;
    return c;
  }

  function render() {
    const u = data.user;
    $("results").hidden = false;
    $("toolbar").hidden = false;
    $("profile").replaceChildren(
      u.avatarUrl ? el("img", { src: u.avatarUrl, alt: "" }) : null,
      el("div", null,
        el("div", { class: "name" }, el("a", { href: `https://github.com/${u.login}`, target: "_blank", rel: "noopener" }, u.name || u.login)),
        el("div", { class: "meta" }, `@${u.login} · last snapshot ${u.lastSnapshotAt ? fmtTime(u.lastSnapshotAt) : "not yet"} · tracked daily`)));

    const stat = (key, label, n, sub) => {
      const b = el("button", { class: "stat", type: "button" }, el("b", null, fmtNum(n)), el("span", null, label), sub ? el("small", null, sub) : null);
      b.onclick = () => { setTab(key); $("tabs").scrollIntoView({ behavior: "smooth", block: "start" }); };
      return b;
    };
    $("stats").replaceChildren(
      stat("followers", "Followers", view.followers.length),
      stat("following", "Following", view.following.length),
      stat("mutuals", "Mutuals", view.mutuals.length),
      stat("notFollowingBack", "Not following back", view.notFollowingBack.length),
      stat("youDontFollowBack", "You don't follow back", view.youDontFollowBack.length),
      stat("unfollowers", "Unfollowed you", view.unfollowers.length, "since tracking started"));

    const ch = $("changes");
    ch.replaceChildren();
    const r = view.recent;
    const line = (cls, label, kind) => {
      const list = r.filter((e) => e.kind === kind);
      return list.length ? el("p", { class: cls }, `${label} (${list.length}): `,
        ...list.flatMap((a, i) => [i ? ", " : "", el("a", { href: `https://github.com/${a.login}`, target: "_blank", rel: "noopener" }, a.login)])) : null;
    };
    const parts = [line("bad", "Unfollowed you", "unfollowed_you"), line("good", "New followers", "followed_you"),
      line("", "You unfollowed", "you_unfollowed"), line("", "You followed", "you_followed")].filter(Boolean);
    ch.append(el("p", null, el("strong", null, "Last 7 days")));
    if (parts.length) ch.append(...parts);
    else ch.append(el("p", null, data.events.length || data.daily.length > 1
      ? "No changes." : "Tracking just started. Changes show up after the next daily snapshot."));

    renderChart();
    renderList();
    renderHistory();
  }

  function renderChart() {
    const rows = data.daily;
    const box = $("chart");
    box.replaceChildren();
    if (rows.length < 2) {
      box.append(el("p", { class: "hint" }, "The graph fills in as daily snapshots come in."));
      return;
    }
    const W = 640, H = 180, L = 44, R = 10, T = 10, B = 24;
    const keys = ["followers", "following", "mutuals"];
    const vals = rows.flatMap((d) => keys.map((k) => d[k]));
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min = Math.max(0, min - 1); max += 1; }
    const t0 = Date.parse(rows[0].day), t1 = Date.parse(rows[rows.length - 1].day);
    const x = (d) => L + ((Date.parse(d.day) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": "Follower history" });
    s.append(svg("line", { class: "axis", x1: L, x2: W - R, y1: H - B, y2: H - B }));
    for (const v of [min, Math.round((min + max) / 2), max]) {
      const t = svg("text", { class: "lbl", x: L - 6, y: y(v) + 4, "text-anchor": "end" });
      t.textContent = fmtNum(v);
      s.append(t, svg("line", { class: "axis", x1: L, x2: W - R, y1: y(v), y2: y(v), "stroke-dasharray": "2 4" }));
    }
    for (const [i, d] of [[0, rows[0]], [1, rows[rows.length - 1]]]) {
      const t = svg("text", { class: "lbl", x: x(d), y: H - 6, "text-anchor": i ? "end" : "start" });
      t.textContent = new Date(d.day + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
      s.append(t);
    }
    for (const k of keys) {
      s.append(svg("polyline", { class: `s-${k}`, points: rows.map((d) => `${x(d).toFixed(1)},${y(d[k]).toFixed(1)}`).join(" ") }));
      const lastRow = rows[rows.length - 1];
      s.append(svg("circle", { class: `dot-${k}`, cx: x(lastRow), cy: y(lastRow[k]), r: 3 }));
    }
    box.append(s);
  }

  function renderList() {
    $("tabs").replaceChildren(...TABS.map(([key, label]) => {
      const b = el("button", { type: "button", role: "tab" }, `${label} `, el("b", null, fmtNum(view[key].length)));
      b.setAttribute("aria-selected", String(key === tab));
      b.onclick = () => setTab(key);
      return b;
    }));
    const full = view[tab];
    const counts = typeCounts(full);
    for (const t of [...typeFilter]) if (!counts[t]) typeFilter.delete(t);
    $("typeChips").replaceChildren(...Object.keys(counts).sort().map((t) => {
      const b = el("button", { type: "button" }, `${t} ${counts[t]}`);
      b.setAttribute("aria-pressed", String(typeFilter.has(t)));
      b.onclick = () => { typeFilter.has(t) ? typeFilter.delete(t) : typeFilter.add(t); renderList(); };
      return b;
    }));
    const q = $("filter").value.trim().toLowerCase();
    const shown = full.filter((a) => (!q || a.login.toLowerCase().includes(q)) && (!typeFilter.size || typeFilter.has(a.type)));
    const frag = document.createDocumentFragment();
    const action = TAB_ACTION[tab];
    const avatar = (a) => el("img", { src: `https://avatars.githubusercontent.com/u/${a.id}?v=4&s=64`, alt: "", loading: "lazy", width: 32, height: 32 });
    for (const a of shown) {
      if (selecting) {
        const why = eligibility(a, action);
        const box = el("input", { type: "checkbox", checked: selected.has(a.id), disabled: Boolean(why) || Boolean(running) });
        box.setAttribute("aria-label", `${action === "follow" ? "Follow back" : "Unfollow"} ${a.login}`);
        box.onchange = () => toggle(a, box);
        frag.append(el("label", { class: "acct" + (why ? " off" : ""), title: why || a.login },
          box, avatar(a), el("span", { class: "login" }, a.login),
          why ? el("span", { class: "why" }, why) : el("span", { class: `type ${String(a.type).toLowerCase()}` }, a.type)));
        continue;
      }
      frag.append(el("a", { class: "acct", href: `https://github.com/${a.login}`, target: "_blank", rel: "noopener",
        title: a.when ? `Unfollowed around ${fmtTime(a.when)}` : a.login },
        avatar(a),
        el("span", { class: "login" }, a.login),
        el("span", { class: `type ${String(a.type).toLowerCase()}` }, a.type)));
    }
    $("list").replaceChildren(frag);
    $("emptyList").hidden = shown.length > 0;
    $("emptyList").textContent = tab === "unfollowers" && !full.length ? "No unfollows recorded yet." : "Nobody here.";
    renderSelectControls(shown);
  }

  // ---------------------------------------------------------------- select, confirm, run

  function followingIds() { return new Set(view.following.map((a) => a.id)); }
  function followerIds() { return new Set(view.followers.map((a) => a.id)); }

  /** Why an account can't be picked for this action, or "" if it can. */
  function eligibility(a, action) {
    if (action === "unfollow") return followingIds().has(a.id) ? "" : "you don't follow";
    if (!followerIds().has(a.id)) return "doesn't follow you";
    return followingIds().has(a.id) ? "already following" : "";
  }

  function setTab(key) {
    if (running) return;
    if (key !== tab) selected.clear();
    tab = key;
    renderList();
  }

  function toggle(a, box) {
    const cap = LIMITS[TAB_ACTION[tab]].batch;
    if (box.checked) {
      if (selected.size >= cap) {
        box.checked = false;
        setStatus(`You can pick up to ${cap} at a time.`, true);
        return;
      }
      selected.set(a.id, a);
    } else selected.delete(a.id);
    setStatus("");
    renderSelectControls();
  }

  let lastShown = [];
  function renderSelectControls(shown) {
    if (shown) lastShown = shown;
    const action = TAB_ACTION[tab];
    const lim = LIMITS[action];
    const any = view[tab].some((a) => !eligibility(a, action));
    const btn = $("selectBtn");
    btn.hidden = !any && !selecting;
    btn.textContent = selecting ? "Done selecting" : action === "follow" ? "Select to follow back" : "Select to unfollow";
    btn.setAttribute("aria-pressed", String(selecting));
    btn.disabled = Boolean(running);
    $("selectHint").hidden = !selecting;
    $("selectHint").textContent = action === "follow"
      ? `Pick people who follow you to follow back, up to ${lim.batch} at a time. Each gets a GitHub notification.`
      : `Pick accounts to unfollow, up to ${lim.batch} at a time. GitHub doesn't tell them.`;
    $("actionBar").hidden = !selecting || Boolean(running);
    $("selCount").textContent = `${fmtNum(selected.size)} of ${lim.batch} selected`;
    const act = $("actBtn");
    act.disabled = !selected.size;
    act.className = action === "unfollow" ? "unfollow" : "";
    act.textContent = selected.size ? `${action === "follow" ? "Follow back" : "Unfollow"} ${fmtNum(selected.size)}` : action === "follow" ? "Follow back" : "Unfollow";
    const room = lastShown.filter((a) => !selected.has(a.id) && !eligibility(a, action)).length;
    $("selAllBtn").disabled = !room || selected.size >= lim.batch;
    $("selAllBtn").textContent = room > lim.batch - selected.size ? `Select ${fmtNum(lim.batch - selected.size)} more shown` : "Select all shown";
    $("selClearBtn").disabled = !selected.size;
  }

  $("selectBtn").onclick = () => {
    selecting = !selecting;
    if (!selecting) selected.clear();
    renderList();
  };
  $("selClearBtn").onclick = () => { selected.clear(); renderList(); };
  $("selAllBtn").onclick = () => {
    const action = TAB_ACTION[tab], cap = LIMITS[action].batch;
    for (const a of lastShown) {
      if (selected.size >= cap) break;
      if (!eligibility(a, action)) selected.set(a.id, a);
    }
    renderList();
  };

  $("actBtn").onclick = () => {
    const action = TAB_ACTION[tab], lim = LIMITS[action];
    const people = [...selected.values()];
    if (!people.length) return;
    const n = people.length;
    $("confirmTitle").textContent = action === "follow" ? `Follow back ${plural(n, "person", "people")}?` : `Unfollow ${plural(n, "account", "accounts")}?`;
    $("confirmText").textContent = action === "follow"
      ? "ghfstats will follow these people on GitHub from your account. Each of them gets a notification that you followed them."
      : "ghfstats will unfollow these accounts on GitHub from your account. GitHub doesn't notify them, and you can follow them again later.";
    $("confirmList").replaceChildren(...people.map((a) => el("li", null, "@" + a.login)));
    $("confirmPace").textContent = `They go one at a time, about ${lim.gapMs / 1000} seconds apart, so this takes about ${Math.max(1, Math.round((n * lim.gapMs) / 1000))} seconds. ` +
      `To stay inside GitHub's rules, ghfstats allows ${lim.perHour} ${action === "follow" ? "follows" : "unfollows"} an hour and ${lim.perDay} a day.`;
    $("confirmOk").textContent = action === "follow" ? `Follow back ${fmtNum(n)}` : `Unfollow ${fmtNum(n)}`;
    $("confirmOk").className = action === "unfollow" ? "unfollow" : "";
    const dlg = $("confirmDialog");
    dlg.returnValue = "";
    dlg.onclose = () => { if (dlg.returnValue === "ok") run(action, people); };
    dlg.showModal();
  };

  $("runStop").onclick = () => { if (running) { running.stopped = true; $("runStop").disabled = true; $("runNow").textContent = "Stopping after this one…"; } };

  /** Apply a successful follow or unfollow to the data on the page. */
  function applyLocal(action, a) {
    if (action === "unfollow") data.following = data.following.filter((c) => c[1] !== a.id);
    else if (!data.following.some((c) => c[1] === a.id)) data.following.push([a.login, a.id, a.type]);
    data.events.unshift({ kind: action === "follow" ? "you_followed" : "you_unfollowed", login: a.login, id: a.id, type: a.type, at: new Date().toISOString() });
  }

  async function run(action, people) {
    const lim = LIMITS[action];
    running = { stopped: false };
    const verbing = action === "follow" ? "Following back" : "Unfollowing";
    let done = 0, stopReason = "";
    const errors = [];
    $("runPanel").hidden = false;
    $("runStop").disabled = false;
    $("runErrors").replaceChildren();
    $("runProgress").max = people.length;
    $("runProgress").value = 0;
    renderSelectControls();
    const update = (now) => {
      $("runTitle").textContent = `${verbing} ${fmtNum(Math.min(done + errors.length + 1, people.length))} of ${fmtNum(people.length)}`;
      $("runProgress").value = done + errors.length;
      if (now) $("runNow").textContent = now;
    };

    for (let i = 0; i < people.length; i++) {
      if (running.stopped) { stopReason = "You stopped it."; break; }
      const a = people[i];
      update(`@${a.login}…`);
      let r, retried = false;
      for (;;) {
        r = await call("/api/follow", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ action, login: a.login }) });
        if (r.status === 429 && !r.body.limit && !retried && (r.body.retryAfter || 0) <= 60) {
          retried = true;
          const wait = Math.max(1, r.body.retryAfter || 1);
          update(`GitHub asked to slow down. Waiting ${wait} seconds…`);
          await sleep(wait * 1000);
          continue;
        }
        break;
      }
      if (r.ok) {
        done++;
        selected.delete(a.id);
        applyLocal(action, a);
      } else if (r.status === 409 || r.status === 404) {
        errors.push(`@${a.login}: ${r.body.error || "skipped"}`);
        selected.delete(a.id);
        $("runErrors").append(el("li", null, errors[errors.length - 1]));
      } else {
        if (r.body.needsPermission) {
          showNotice(el("span", null, "To follow or unfollow from ghfstats, GitHub needs you to approve the Followers permission. ",
            el("a", { href: "/api/auth/login" }, "Sign in again to approve it")), "warn");
        } else if (r.status === 401) {
          showNotice(el("span", null, (r.body.error || "Your GitHub sign-in expired.") + " ", el("a", { href: "/api/auth/login" }, "Sign in again")), "warn");
        }
        stopReason = r.body.error || `Stopped: GitHub returned an error (${r.status}).`;
        break;
      }
      update();
      if (i < people.length - 1 && !running.stopped) await sleep(lim.gapMs);
    }

    running = null;
    $("runProgress").value = done + errors.length;
    const did = action === "follow" ? `Followed back ${plural(done, "person", "people")}` : `Unfollowed ${plural(done, "account", "accounts")}`;
    $("runTitle").textContent = done || !stopReason ? `${did}.` : "Nothing changed.";
    const left = people.length - done - errors.length;
    $("runNow").textContent = [stopReason,
      left > 0 ? `${plural(left, "is", "are")} still selected.` : "",
      errors.length ? `${plural(errors.length, "was", "were")} skipped:` : ""].filter(Boolean).join(" ");
    $("runStop").disabled = true;
    view = compute(data);
    render();
  }

  const EV_LABEL = { unfollowed_you: "Unfollowed you", followed_you: "Followed you", you_unfollowed: "You unfollowed", you_followed: "You followed" };

  function renderHistory() {
    const rows = data.events.slice(0, 500).map((e) => el("tr", null,
      el("td", null, fmtTime(e.at)),
      el("td", { class: `ev-${e.kind}` }, EV_LABEL[e.kind] || e.kind),
      el("td", null, el("a", { href: `https://github.com/${e.login}`, target: "_blank", rel: "noopener" }, e.login)),
      el("td", null, e.type)));
    $("history").replaceChildren(...(rows.length ? rows
      : [el("tr", null, el("td", { colspan: 4, class: "empty" }, "No changes recorded yet."))]));
  }

  function renderInsights(d) {
    const person = (a, extra) => el("li", null,
      el("a", { href: `https://github.com/${a.login}`, target: "_blank", rel: "noopener" }, a.login), " ", el("small", null, extra(a)));
    const block = (title, hint, list, extra) => el("section", null, el("h3", null, title), el("p", { class: "hint" }, hint),
      list.length ? el("ol", null, ...list.map((a) => person(a, extra))) : el("p", { class: "empty" }, "None."));
    $("insights").replaceChildren(
      block("Notable followers", "Your followers with the most followers of their own.", d.notable, (a) => `${fmtNum(a.followers)} followers`),
      block("Likely follow-for-follow", "Following at least 500 people and 5× more than follow them.", d.followForFollow,
        (a) => `follows ${fmtNum(a.following)}, ${fmtNum(a.followers)} followers`),
      block("New accounts", "Followers whose GitHub account is less than 90 days old.", d.newAccounts,
        (a) => `joined ${new Date(a.createdAt).toLocaleDateString()}`));
    $("insightsStatus").textContent = `Looked at ${fmtNum(d.analysed)} of ${fmtNum(d.total)} followers` +
      `${d.truncated ? " (the first 3,000)" : ""}. Median follower count: ${fmtNum(d.medianFollowers)}. ` +
      `Combined reach: ${fmtNum(d.combinedReach)}.`;
  }

  function handleAuthError(r) {
    if (r.status === 401 && r.body.reauth) {
      showNotice(el("span", null, r.body.error + " ", el("a", { href: "/api/auth/login" }, "Sign in again")), "warn");
      return true;
    }
    if (r.status === 401) { location.href = "/dashboard"; return true; }
    return false;
  }

  async function load() {
    const r = await call("/api/me");
    if (r.status === 401) {
      setStatus("");
      $("signedOut").hidden = false;
      return;
    }
    if (!r.ok) { setStatus(r.body.error || `Couldn't load your data (${r.status}).`, true); return; }
    data = r.body;
    if (!data.user.lastSnapshotAt && !data.user.needsReauth) {
      setStatus("Taking your first snapshot…");
      const s = await call("/api/sync", { method: "POST" });
      if (!s.ok) { if (!handleAuthError(s)) setStatus(s.body.error || "The first snapshot failed.", true); return; }
      return load();
    }
    view = compute(data);
    if (data.user.needsReauth) {
      showNotice(el("span", null, (data.user.lastError || "Your GitHub sign-in expired.") + " ",
        el("a", { href: "/api/auth/login" }, "Sign in again")), "warn");
    } else if (data.user.lastError) {
      showNotice(`Last snapshot problem: ${data.user.lastError}`, "warn");
    } else showNotice(null);
    render();
    setStatus("");
  }

  $("filter").oninput = () => view && renderList();

  $("syncBtn").onclick = async () => {
    $("syncBtn").disabled = true;
    setStatus("Syncing with GitHub…");
    try {
      const r = await call("/api/sync", { method: "POST" });
      if (!r.ok) { if (!handleAuthError(r)) setStatus(r.body.error || "Sync failed.", true); return; }
      await load();
      setStatus(r.body.skipped ? r.body.message : r.body.changes ? `Synced: ${r.body.changes} change${r.body.changes === 1 ? "" : "s"}.` : "Synced: no changes.");
    } finally { $("syncBtn").disabled = false; }
  };

  $("logoutBtn").onclick = async () => {
    await call("/api/auth/logout", { method: "POST" });
    location.href = "/";
  };

  $("insightsBtn").onclick = async () => {
    $("insightsBtn").disabled = true;
    $("insightsStatus").textContent = "Looking up your followers on GitHub…";
    try {
      const r = await call("/api/insights");
      if (!r.ok) { if (!handleAuthError(r)) $("insightsStatus").textContent = r.body.error || "Couldn't load insights."; return; }
      renderInsights(r.body);
    } finally { $("insightsBtn").disabled = false; }
  };

  $("deleteBtn").onclick = async () => {
    if (!confirm("Delete your follower history from ghfstats, stop daily tracking and remove its access to your GitHub account?")) return;
    const r = await call("/api/account", { method: "DELETE" });
    if (!r.ok) { setStatus(r.body.error || "Couldn't delete your data.", true); return; }
    location.href = "/?signin=deleted";
  };

  load().catch((e) => setStatus(`Something went wrong: ${e.message}`, true));
})();
