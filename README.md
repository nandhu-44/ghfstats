# ghfstats

GitHub follower stats that run entirely in your browser. Enter any username to see:

- **Followers** and **following**, with each account's type (User, Organization, Bot), avatar and profile link
- **Mutuals**
- **Not following back**: accounts you follow that don't follow you
- **You don't follow back**: accounts that follow you that you don't follow
- **Unfollowed you**: who stopped following you, and roughly when
- A **change history** of every follow and unfollow, both ways

The lookup needs no account or backend: the page calls the GitHub REST API straight from the browser.

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

## Continue with GitHub (optional)

On Vercel, people can also sign in with GitHub. Signing in adds:

- **Daily snapshots** taken for you once a day, so unfollows are caught without opening the page
- **History that follows you** across devices and browsers, kept in a database
- A **follower graph** over time, and a list of the last 7 days of changes
- **Follower insights**: your most-followed followers, likely follow-for-follow accounts, brand-new
  accounts, median follower count and combined reach (from GitHub's GraphQL API)

Only the signed-in person's own account is tracked. GitHub tokens are encrypted before they're
stored, and **Delete my data** on the dashboard removes everything and revokes ghfstats' access.
`/privacy` explains what is kept. Without the setup below, the site runs exactly as before: the
sign-in button stays hidden and nothing is stored on a server.

### Setup

1. **Register a GitHub App** at github.com → Settings → Developer settings → GitHub Apps → New GitHub App.
   - Callback URL: `https://<your-site>/api/auth/callback` (add `http://localhost:3000/api/auth/callback` for local use)
   - Tick "Request user authorization (OAuth) during installation" off; leave "Expire user authorization tokens" on.
   - Webhook: untick "Active".
   - Permissions: none. Public follower data needs no permissions.
   - Generate a client secret.
2. **Add a Postgres database.** In the Vercel project, Storage → Create Database → Neon (free plan), and
   connect it to the project. That sets `DATABASE_URL`. Any Postgres works; `POSTGRES_URL` is read too.
   Tables are created on first use.
3. **Set environment variables** in the Vercel project (Production and Preview):

   | Variable | Value |
   | --- | --- |
   | `GITHUB_CLIENT_ID` | The App's client ID |
   | `GITHUB_CLIENT_SECRET` | The App's client secret |
   | `AUTH_SECRET` | 32+ random characters (`openssl rand -base64 48`); encrypts tokens and signs cookies |
   | `CRON_SECRET` | Random string; Vercel sends it to the daily snapshot job |
   | `DATABASE_URL` | Set by the Neon integration |

4. **Redeploy.** The daily job runs at 02:30 UTC (Vercel Hobby runs crons once a day, at some point in that hour).

Changing `AUTH_SECRET` signs everyone out and makes stored tokens unreadable, so people have to sign in again.

## Hosting

The site is static files in `public/` plus serverless functions in `api/`, with no build step.

- **Vercel:** import the repo at vercel.com/new with the framework preset "Other" and no build
  command. `vercel.json` sets `public` as the output directory and adds the daily cron.
- **GitHub Pages or any static host:** serve the `public/` folder. Everything except sign-in works.
- **Locally:** `npm run dev` serves the site and the API at http://localhost:3000. With no environment
  variables, sign-in stays hidden. To try sign-in without a database, set `GHFS_MEMORY_STORE=1` along
  with the GitHub App variables (data is lost when the server stops). You can also just open `public/index.html`.

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
npm test                                           # web app, sign-in, snapshots and cron, against a fake GitHub
cd cli && python3 -m unittest discover -s tests    # CLI, against a fake GitHub API
```
