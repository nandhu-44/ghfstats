<p align="center">
  <img src="public/icon.svg" width="88" alt="ghfstats icon">
</p>

<h1 align="center">ghfstats</h1>

<p align="center">
  See who follows you on GitHub, who doesn't follow back, and who unfollowed you.<br>
  <a href="https://ghfstats.vercel.app"><strong>ghfstats.vercel.app</strong></a>
</p>

## Features

- **Followers, following and mutuals** for any username, with account type (User, Organization, Bot)
- **Not following back** and **you don't follow back** lists
- **Unfollowed you**: who stopped following you, and roughly when
- **Change history** of every follow and unfollow, both ways

Sign in with GitHub and you also get:

- **Daily snapshots** taken for you, so unfollows are caught without opening the site
- **History in the cloud**, the same on every device
- **Follower graph** over time and **follower insights** (most-followed followers, likely
  follow-for-follow accounts, new accounts, combined reach)
- **Unfollow or follow back** up to 10 accounts at a time, from people you tick yourself

## How it works

**Without signing in**, the page calls the GitHub API straight from your browser. Snapshots are
kept in that browser's localStorage, and unfollows are found by comparing each check with the last
one, so the first check is only a baseline. GitHub allows 60 requests an hour without a token
(about 3,000 accounts); paste a token with no permissions for more.

**With "Continue with GitHub"**, ghfstats uses a GitHub App. Signing in stores your account, your
encrypted GitHub token and a first snapshot of your followers and following in Postgres. A daily
job adds a new snapshot and records what changed. Only your own account is tracked, and
**Delete my data** on the dashboard removes everything and revokes access. See
[/privacy](https://ghfstats.vercel.app/privacy).

The data lives in six tables in the `public` schema, created on first use: `ghfs_user`,
`ghfs_session`, `ghfs_edge` (who follows whom now), `ghfs_event` (follows and unfollows),
`ghfs_daily` (counts per day) and `ghfs_action` (unfollows and follow-backs made from the dashboard).

### Unfollowing and following back

GitHub's [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
ban automated or bulk following, so ghfstats keeps it small and deliberate:

- Only accounts you tick and confirm, at most 10 per batch. Nothing runs on a schedule.
- Following is only offered for people who already follow you.
- Changes go out one at a time, 1.5 seconds apart for unfollows and 3 for follows.
- Each account is capped at 100 unfollows an hour and 300 a day, and 20 follows an hour and 50 a
  day (`FOLLOW_LIMITS` in `lib/config.mjs`).

This needs the App's **Followers: Read and write** permission. GitHub only grants a newly added
permission when the person approves the App again, so the dashboard offers **Re-authorize with
GitHub** when it's missing.

## Self-hosting

The site is static files in `public/` plus serverless functions in `api/`, with no build step.

1. **Fork and import** the repo at vercel.com/new (framework preset "Other", no build command).
   With nothing else set up, everything except sign-in already works.
2. **Create a GitHub App** (Settings → Developer settings → GitHub Apps → New GitHub App):
   - Callback URL: `https://<your-site>/api/auth/callback`
   - Keep "Expire user authorization tokens" on, and untick the webhook's "Active"
   - Account permissions → **Followers: Read and write** (only for unfollow and follow back)
   - Generate a client secret
3. **Add a database:** in the Vercel project, Storage → Create Database → Neon, connected to the
   project. That sets `DATABASE_URL`. Any Postgres works.
4. **Set environment variables** (Production and Preview), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `GITHUB_CLIENT_ID` | The App's client ID |
   | `GITHUB_CLIENT_SECRET` | The App's client secret |
   | `AUTH_SECRET` | 32+ random characters (`openssl rand -base64 48`) |
   | `CRON_SECRET` | Any random string, for the daily snapshot job |

The daily job runs at 02:30 UTC. Changing `AUTH_SECRET` signs everyone out.

**Locally**, `npm run dev` serves everything at http://localhost:3000. Set `GHFS_MEMORY_STORE=1`
plus the GitHub App variables to try sign-in without a database. Any static host can serve
`public/` on its own, without sign-in.

## Command line

`cli/ghfstats.py` does the same from a terminal (Python 3, standard library only) and keeps
snapshots in `./data`:

```
python3 cli/ghfstats.py nandhu-44 --html report.html
```

## Tests

```
npm test                                           # web app against a fake GitHub
cd cli && python3 -m unittest discover -s tests    # CLI
```

## Support

If ghfstats saved you some scrolling, you can [sponsor me on GitHub](https://github.com/sponsors/nandhu-44)
or [buy me a chai](https://buymeachai.in/nandhu).
