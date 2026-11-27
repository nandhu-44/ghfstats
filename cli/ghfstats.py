#!/usr/bin/env python3
"""GitHub follower stats.

Shows, for any GitHub username:
  - followers and following (with account type: User / Organization / Bot)
  - mutuals
  - accounts you follow that don't follow you back
  - followers you don't follow back
  - unfollowers and new followers since the last run (GitHub has no unfollow
    API, so each run saves a snapshot and the next run diffs against it)

Only the Python standard library is used.

Usage:
  python3 ghfstats.py nandhu-44
  python3 ghfstats.py nandhu-44 --html report.html
  GITHUB_TOKEN=... python3 ghfstats.py nandhu-44     # higher rate limit

The token is read from --token, GITHUB_TOKEN or GH_TOKEN and is never printed
or written to disk.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("GHFS_API_BASE", "https://api.github.com").rstrip("/")
PER_PAGE = 100


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #

class GitHubError(RuntimeError):
    pass


def _request(url: str, token: str | None) -> tuple[object, dict]:
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "ghfstats")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp), dict(resp.headers)
        except urllib.error.HTTPError as e:
            headers = dict(e.headers or {})
            if e.code in (403, 429) and headers.get("X-RateLimit-Remaining") == "0":
                reset = int(headers.get("X-RateLimit-Reset", "0"))
                when = dt.datetime.fromtimestamp(reset).strftime("%H:%M:%S")
                hint = "" if token else " Set GITHUB_TOKEN for 5000 requests/hour."
                raise GitHubError(f"Rate limit hit; resets at {when}.{hint}") from None
            if e.code == 404:
                raise GitHubError(f"Not found: {url}") from None
            if e.code >= 500 and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise GitHubError(f"HTTP {e.code} for {url}") from None
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise GitHubError(f"Network error: {e.reason}") from None
    raise GitHubError(f"Failed after retries: {url}")


def fetch_user(username: str, token: str | None) -> dict:
    data, _ = _request(f"{API}/users/{username}", token)
    return data  # type: ignore[return-value]


def fetch_list(username: str, kind: str, token: str | None) -> dict[str, dict]:
    """kind is 'followers' or 'following'. Returns {login_lower: account}."""
    out: dict[str, dict] = {}
    page = 1
    while True:
        url = f"{API}/users/{username}/{kind}?per_page={PER_PAGE}&page={page}"
        data, _ = _request(url, token)
        if not isinstance(data, list) or not data:
            break
        for a in data:
            out[a["login"].lower()] = {
                "login": a["login"],
                "id": a.get("id"),
                "type": a.get("type", "User"),
                "avatar_url": a.get("avatar_url", ""),
                "html_url": a.get("html_url", f"https://github.com/{a['login']}"),
            }
        if len(data) < PER_PAGE:
            break
        page += 1
    return out


# --------------------------------------------------------------------------- #
# Snapshots
# --------------------------------------------------------------------------- #

def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot_dir(data_dir: Path, username: str) -> Path:
    return data_dir / username.lower() / "snapshots"


def load_latest_snapshot(data_dir: Path, username: str) -> dict | None:
    d = snapshot_dir(data_dir, username)
    if not d.is_dir():
        return None
    files = sorted(d.glob("*.json"))
    if not files:
        return None
    return json.loads(files[-1].read_text(encoding="utf-8"))


def save_snapshot(data_dir: Path, snap: dict) -> Path:
    d = snapshot_dir(data_dir, snap["username"])
    d.mkdir(parents=True, exist_ok=True)
    name = snap["taken_at"].replace(":", "").replace("-", "") + ".json"
    path = d / name
    n = 1
    while path.exists():  # two runs in the same second
        path = d / name.replace(".json", f"-{n}.json")
        n += 1
    path.write_text(json.dumps(snap, indent=2, sort_keys=True), encoding="utf-8")
    return path


def append_events(data_dir: Path, username: str, events: list[dict]) -> None:
    if not events:
        return
    path = data_dir / username.lower() / "events.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, sort_keys=True) + "\n")


def load_events(data_dir: Path, username: str) -> list[dict]:
    path = data_dir / username.lower() / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #

def _sorted(accounts: dict[str, dict], keys) -> list[dict]:
    return sorted((accounts[k] for k in keys), key=lambda a: a["login"].lower())


def analyse(snap: dict, prev: dict | None) -> dict:
    fol, ing = snap["followers"], snap["following"]
    fk, ik = set(fol), set(ing)
    r = {
        "followers": _sorted(fol, fk),
        "following": _sorted(ing, ik),
        "mutuals": _sorted(fol, fk & ik),
        "not_following_back": _sorted(ing, ik - fk),   # you follow them, they don't follow you
        "you_dont_follow_back": _sorted(fol, fk - ik),  # they follow you, you don't follow them
        "unfollowers": [],
        "new_followers": [],
        "you_unfollowed": [],
        "you_newly_followed": [],
        "previous_snapshot": prev["taken_at"] if prev else None,
    }
    if prev:
        pf, pi = prev["followers"], prev["following"]
        r["unfollowers"] = _sorted(pf, set(pf) - fk)
        r["new_followers"] = _sorted(fol, fk - set(pf))
        r["you_unfollowed"] = _sorted(pi, set(pi) - ik)
        r["you_newly_followed"] = _sorted(ing, ik - set(pi))
    return r


def type_counts(accounts: list[dict]) -> dict[str, int]:
    c: dict[str, int] = {}
    for a in accounts:
        c[a["type"]] = c.get(a["type"], 0) + 1
    return dict(sorted(c.items()))


def build_events(r: dict, taken_at: str) -> list[dict]:
    ev = []
    for key, kind in (("unfollowers", "unfollowed_you"),
                      ("new_followers", "followed_you"),
                      ("you_unfollowed", "you_unfollowed"),
                      ("you_newly_followed", "you_followed")):
        for a in r[key]:
            ev.append({"at": taken_at, "event": kind, "login": a["login"],
                       "type": a["type"], "since": r["previous_snapshot"]})
    return ev


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

SECTIONS = [
    ("not_following_back", "You follow, they don't follow back"),
    ("you_dont_follow_back", "Follow you, you don't follow back"),
    ("mutuals", "Mutuals"),
    ("unfollowers", "Unfollowed you since last run"),
    ("new_followers", "New followers since last run"),
    ("you_unfollowed", "You unfollowed since last run"),
    ("you_newly_followed", "You newly followed since last run"),
    ("followers", "Followers"),
    ("following", "Following"),
]


def print_report(username: str, snap: dict, r: dict, show_all: bool, limit: int) -> None:
    def tc(lst):
        c = type_counts(lst)
        return ", ".join(f"{v} {k}" for k, v in c.items()) or "none"

    print(f"\nGitHub follower stats for {username}  ({snap['taken_at']})")
    print("=" * 60)
    print(f"Followers            {len(r['followers']):>6}   ({tc(r['followers'])})")
    print(f"Following            {len(r['following']):>6}   ({tc(r['following'])})")
    print(f"Mutuals              {len(r['mutuals']):>6}")
    print(f"Not following back   {len(r['not_following_back']):>6}")
    print(f"You don't follow back{len(r['you_dont_follow_back']):>6}")
    if r["previous_snapshot"]:
        print(f"\nSince {r['previous_snapshot']}:")
        print(f"  Unfollowed you     {len(r['unfollowers']):>6}")
        print(f"  New followers      {len(r['new_followers']):>6}")
        print(f"  You unfollowed     {len(r['you_unfollowed']):>6}")
        print(f"  You followed       {len(r['you_newly_followed']):>6}")
    else:
        print("\nFirst run: snapshot saved. Run again later to see unfollowers.")

    for key, title in SECTIONS:
        if key in ("followers", "following", "mutuals") and not show_all:
            continue
        lst = r[key]
        if not lst:
            continue
        print(f"\n{title} ({len(lst)}):")
        shown = lst if limit <= 0 else lst[:limit]
        for a in shown:
            print(f"  - {a['login']:<30} {a['type']:<13} {a['html_url']}")
        if len(shown) < len(lst):
            print(f"  ... and {len(lst) - len(shown)} more (use --limit 0)")
    print()


def write_html(path: Path, username: str, snap: dict, r: dict, events: list[dict]) -> None:
    esc = html.escape

    def card(a):
        av = a["avatar_url"]
        av = f'{av}{"&" if "?" in av else "?"}s=64' if av else ""
        return (f'<a class="acct" href="{esc(a["html_url"])}" target="_blank" rel="noopener">'
                f'<img src="{esc(av)}" alt="" loading="lazy">'
                f'<span class="login">{esc(a["login"])}</span>'
                f'<span class="type t-{esc(a["type"].lower())}">{esc(a["type"])}</span></a>')

    stats = [("Followers", len(r["followers"])), ("Following", len(r["following"])),
             ("Mutuals", len(r["mutuals"])), ("Not following back", len(r["not_following_back"])),
             ("You don't follow back", len(r["you_dont_follow_back"]))]
    if r["previous_snapshot"]:
        stats += [("Unfollowed you", len(r["unfollowers"])), ("New followers", len(r["new_followers"]))]

    tabs, panels = [], []
    for i, (key, title) in enumerate(SECTIONS):
        lst = r[key]
        tabs.append(f'<button data-tab="{key}"{" class=on" if i == 0 else ""}>'
                    f'{esc(title)} <b>{len(lst)}</b></button>')
        body = "".join(card(a) for a in lst) or '<p class="empty">Nobody here.</p>'
        panels.append(f'<section id="{key}"{" class=on" if i == 0 else ""}>'
                      f'<div class="grid">{body}</div></section>')

    ev_rows = "".join(
        f'<tr><td>{esc(e["at"])}</td><td>{esc(e["event"].replace("_", " "))}</td>'
        f'<td><a href="https://github.com/{esc(e["login"])}">{esc(e["login"])}</a></td>'
        f'<td>{esc(e["type"])}</td></tr>'
        for e in reversed(events[-500:])
    ) or '<tr><td colspan="4" class="empty">No changes recorded yet. Run again later.</td></tr>'

    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Follower stats: {esc(username)}</title>
<style>
:root{{--bg:#fff;--fg:#1f2328;--muted:#656d76;--card:#f6f8fa;--line:#d0d7de;--accent:#0969da}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--card:#161b22;--line:#30363d;--accent:#4493f8}}}}
*{{box-sizing:border-box}}body{{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}}
main{{max-width:1100px;margin:0 auto}}h1{{margin:0 0 4px;font-size:24px}}.sub{{color:var(--muted);margin:0 0 20px}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}}
.stat{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}}
.stat b{{display:block;font-size:26px}}.stat span{{color:var(--muted);font-size:13px}}
.tabs{{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}}
.tabs button{{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px}}
.tabs button.on{{border-color:var(--accent);color:var(--accent)}}
input{{width:100%;padding:8px 12px;margin-bottom:12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}}
section{{display:none}}section.on{{display:block}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}}
.acct{{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);text-decoration:none;min-width:0}}
.acct img{{width:32px;height:32px;border-radius:50%;flex:none}}.login{{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.type{{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}}
.t-organization{{color:#bf8700;border-color:#bf8700}}.t-bot{{color:#8250df;border-color:#8250df}}
h2{{margin:28px 0 8px;font-size:18px}}table{{width:100%;border-collapse:collapse;font-size:14px}}
td{{padding:6px 8px;border-bottom:1px solid var(--line)}}a{{color:var(--accent)}}.empty{{color:var(--muted)}}
.table-wrap{{overflow-x:auto}}
</style></head><body><main>
<h1>Follower stats: <a href="https://github.com/{esc(username)}">{esc(username)}</a></h1>
<p class="sub">Snapshot {esc(snap['taken_at'])}{' · compared with ' + esc(r['previous_snapshot']) if r['previous_snapshot'] else ' · first run, no comparison yet'}</p>
<div class="stats">{''.join(f'<div class="stat"><b>{v}</b><span>{esc(k)}</span></div>' for k, v in stats)}</div>
<div class="tabs">{''.join(tabs)}</div>
<input id="q" placeholder="Filter by username" autocomplete="off">
{''.join(panels)}
<h2>Change history</h2>
<div class="table-wrap"><table>{ev_rows}</table></div>
</main>
<script>
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{{
  document.querySelectorAll('.tabs button,section').forEach(e=>e.classList.remove('on'));
  b.classList.add('on');document.getElementById(b.dataset.tab).classList.add('on');}});
document.getElementById('q').oninput=e=>{{const q=e.target.value.toLowerCase();
  document.querySelectorAll('.acct').forEach(a=>a.style.display=a.textContent.toLowerCase().includes(q)?'':'none');}};
</script></body></html>
"""
    path.write_text(doc, encoding="utf-8")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="GitHub follower stats with unfollower tracking.")
    p.add_argument("username", help="GitHub username to analyse")
    p.add_argument("--token", help="GitHub token (default: $GITHUB_TOKEN or $GH_TOKEN)")
    p.add_argument("--data-dir", default="data", help="where snapshots are kept (default: ./data)")
    p.add_argument("--html", metavar="FILE", help="also write an HTML report to FILE")
    p.add_argument("--json", metavar="FILE", help="also write the full analysis as JSON to FILE")
    p.add_argument("--all", action="store_true", help="also list every follower, following and mutual")
    p.add_argument("--limit", type=int, default=50, help="max names per list in the terminal (0 = no limit)")
    p.add_argument("--no-save", action="store_true", help="don't save a snapshot this run")
    args = p.parse_args(argv)

    token = args.token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    data_dir = Path(args.data_dir)

    try:
        user = fetch_user(args.username, token)
        username = user["login"]
        print(f"Fetching followers and following for {username} ...", file=sys.stderr)
        snap = {
            "username": username,
            "taken_at": now_utc(),
            "account_type": user.get("type", "User"),
            "followers": fetch_list(username, "followers", token),
            "following": fetch_list(username, "following", token),
        }
    except GitHubError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    prev = load_latest_snapshot(data_dir, username)
    r = analyse(snap, prev)

    if not args.no_save:
        save_snapshot(data_dir, snap)
        append_events(data_dir, username, build_events(r, snap["taken_at"]))

    print_report(username, snap, r, args.all, args.limit)

    if args.html:
        write_html(Path(args.html), username, snap, r, load_events(data_dir, username))
        print(f"HTML report written to {args.html}", file=sys.stderr)
    if args.json:
        out = {k: v for k, v in r.items()}
        out["counts"] = {k: len(v) for k, v in r.items() if isinstance(v, list)}
        out["username"], out["taken_at"] = username, snap["taken_at"]
        Path(args.json).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"JSON written to {args.json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
