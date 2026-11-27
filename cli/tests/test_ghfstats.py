"""End-to-end test against a fake GitHub API (no network needed).

Run:  python3 -m unittest discover -s tests
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATE = {"followers": [], "following": [], "auth": []}


def acct(login, typ="User", i=0):
    return {"login": login, "id": i, "type": typ,
            "avatar_url": f"https://avatars.githubusercontent.com/u/{i}?v=4",
            "html_url": f"https://github.com/{login}"}


class FakeGitHub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        STATE["auth"].append(self.headers.get("Authorization"))
        u = urlparse(self.path)
        parts = u.path.strip("/").split("/")
        q = parse_qs(u.query)
        if parts[:1] == ["users"] and len(parts) == 2:
            body = {"login": "Tester", "type": "User"}
        elif parts[:1] == ["users"] and len(parts) == 3 and parts[2] in ("followers", "following"):
            per = int(q.get("per_page", ["30"])[0])
            page = int(q.get("page", ["1"])[0])
            items = STATE[parts[2]]
            body = items[(page - 1) * per: page * per]
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeGitHub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        os.environ["GHFS_API_BASE"] = f"http://127.0.0.1:{cls.server.server_port}"
        os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1"
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import importlib
        import ghfstats
        cls.g = importlib.reload(ghfstats)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = self.g.main(list(args))
        self.assertEqual(rc, 0)
        return out.getvalue()

    def test_full_flow(self):
        # 250 followers -> 3 pages; 120 following incl. orgs and a bot.
        followers = [acct(f"user{i}", i=i) for i in range(250)]
        following = ([acct(f"user{i}", i=i) for i in range(0, 100)]            # 100 mutuals
                     + [acct(f"org{i}", "Organization", 1000 + i) for i in range(15)]
                     + [acct(f"celeb{i}", i=2000 + i) for i in range(4)]
                     + [acct("dependabot", "Bot", 3000)])
        STATE["followers"], STATE["following"] = followers, following

        with tempfile.TemporaryDirectory() as d:
            html_path = Path(d) / "r.html"
            json_path = Path(d) / "r.json"
            out = self.run_cli("tester", "--data-dir", d, "--token", "SECRET123",
                               "--html", str(html_path), "--json", str(json_path))
            res = json.loads(json_path.read_text())
            c = res["counts"]
            self.assertEqual(c["followers"], 250)
            self.assertEqual(c["following"], 120)
            self.assertEqual(c["mutuals"], 100)
            self.assertEqual(c["not_following_back"], 20)
            self.assertEqual(c["you_dont_follow_back"], 150)
            self.assertEqual(c["unfollowers"], 0)
            types = self.g.type_counts(res["not_following_back"])
            self.assertEqual(types, {"Bot": 1, "Organization": 15, "User": 4})
            self.assertIn("First run", out)
            self.assertIn("Bearer SECRET123", STATE["auth"])
            # Token must never be written to disk or stdout.
            for p in Path(d).rglob("*"):
                if p.is_file():
                    self.assertNotIn("SECRET123", p.read_text())
            self.assertNotIn("SECRET123", out)

            # Second run: user5 and user200 unfollow, newbie follows,
            # you unfollow org0 and follow newbie.
            STATE["followers"] = [a for a in followers if a["login"] not in ("user5", "user200")] \
                + [acct("newbie", i=4000)]
            STATE["following"] = [a for a in following if a["login"] != "org0"] + [acct("newbie", i=4000)]
            out2 = self.run_cli("tester", "--data-dir", d, "--json", str(json_path),
                                "--html", str(html_path))
            res2 = json.loads(json_path.read_text())
            self.assertEqual([a["login"] for a in res2["unfollowers"]], ["user200", "user5"])
            self.assertEqual([a["login"] for a in res2["new_followers"]], ["newbie"])
            self.assertEqual([a["login"] for a in res2["you_unfollowed"]], ["org0"])
            self.assertEqual([a["login"] for a in res2["you_newly_followed"]], ["newbie"])
            self.assertIn("Unfollowed you since last run (2)", out2)

            events = self.g.load_events(Path(d), "Tester")
            kinds = sorted(e["event"] for e in events)
            self.assertEqual(kinds, ["followed_you", "unfollowed_you", "unfollowed_you",
                                     "you_followed", "you_unfollowed"])
            html_text = html_path.read_text()
            self.assertIn("user200", html_text)
            self.assertIn("unfollowed you", html_text)
            snaps = list((Path(d) / "tester" / "snapshots").glob("*.json"))
            self.assertGreaterEqual(len(snaps), 1)


if __name__ == "__main__":
    unittest.main()
