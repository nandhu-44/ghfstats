// Richer follower details from GitHub's GraphQL API (needs the signed-in user's token).
import { graphql } from "./github.mjs";

const MAX_FOLLOWERS = 3000;

const QUERY = `query($login: String!, $after: String) {
  user(login: $login) {
    followers(first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { databaseId login name createdAt followers { totalCount } following { totalCount } }
    }
  }
}`;

export async function followerDetails(login, token) {
  const out = [];
  let after = null, total = 0;
  while (out.length < MAX_FOLLOWERS) {
    const data = await graphql(QUERY, { login, after }, token);
    const page = data && data.user && data.user.followers;
    if (!page) break;
    total = page.totalCount;
    for (const n of page.nodes || []) {
      if (!n) continue;
      out.push({
        id: n.databaseId, login: n.login, name: n.name || null, createdAt: n.createdAt,
        followers: n.followers.totalCount, following: n.following.totalCount,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return { followers: out, total, truncated: out.length < total };
}

/** Summaries shown on the dashboard. Pure, so it is easy to test. */
export function summarize(list, now = Date.now()) {
  const byFollowers = (a, b) => b.followers - a.followers || a.login.localeCompare(b.login);
  const notable = list.filter((a) => a.followers > 0).sort(byFollowers).slice(0, 12);
  // Accounts that follow huge numbers of people but have few followers often follow-for-follow.
  const followForFollow = list
    .filter((a) => a.following >= 500 && a.following >= 5 * Math.max(a.followers, 1))
    .sort((a, b) => b.following - a.following)
    .slice(0, 50);
  const newAccounts = list
    .filter((a) => a.createdAt && now - Date.parse(a.createdAt) < 90 * 86400e3)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 50);
  const counts = list.map((a) => a.followers).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor((counts.length - 1) / 2)] : 0;
  const reach = list.reduce((s, a) => s + a.followers, 0);
  return { notable, followForFollow, newAccounts, medianFollowers: median, combinedReach: reach };
}
