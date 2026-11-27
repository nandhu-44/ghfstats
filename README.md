# ghfstats

GitHub follower stats that run entirely in your browser. Enter any username to see:

- **Followers** and **following**, with each account's type (User, Organization, Bot), avatar and profile link
- **Mutuals**
- **Not following back**: accounts you follow that don't follow you
- **You don't follow back**: accounts that follow you that you don't follow
- **Unfollowed you**: who stopped following you, and roughly when
- A **change history** of every follow and unfollow, both ways

There is no backend. The page calls the GitHub REST API straight from the browser.

## How unfollows are detected

GitHub has no "who unfollowed me" API. Each time you check, ghfstats saves a snapshot of the
follower and following lists in your browser's localStorage and compares it with the last one.
The first check only records a baseline, so unfollowers show up from the second check on.

Snapshots stay in that browser. Use **Export snapshots** to back them up or move them to another
device, and **Import snapshots** to load them back. Import also accepts snapshot files from the CLI below.

## Token (optional)

Without a token GitHub allows 60 requests an hour per IP, which covers about 3,000 followers plus following.
For bigger accounts, paste a token under "GitHub token". A fine-grained token with no permissions
(public data only) is enough. It is sent only to `api.github.com`, and it is saved only if you tick
"Remember on this device".

## Hosting

It's three static files (`index.html`, `style.css`, `app.js`) with no build step.

- **Vercel:** import the repo at vercel.com/new, keep the framework preset as "Other", no build command,
  and deploy. Works with private repos on the free plan.
- **GitHub Pages:** repo Settings → Pages → Source "Deploy from a branch" → `main` / root.
  Pages on a private repo needs GitHub Pro (included in the GitHub Student Developer Pack); a public repo works on the free plan.
- **Locally:** open `index.html` in a browser, or run `npx http-server .`.

Link straight to a user with `?user=<username>`, for example `https://your-site/?user=nandhu-44`.

## Command-line version

`cli/ghfstats.py` does the same from a terminal (Python 3, standard library only) and keeps
snapshots as JSON files in `./data`:

```
python3 cli/ghfstats.py nandhu-44 --html report.html
```

`cli/snapshot-workflow.example.yml` is a GitHub Action that runs the CLI daily and commits the
snapshots. It is not active; copy it to `.github/workflows/` if you want automatic snapshots
(they'll be visible to anyone who can read the repo).

## Tests

```
node --test tests/core.test.js                     # web app logic
cd cli && python3 -m unittest discover -s tests    # CLI, against a fake GitHub API
```
