// Pure snapshot logic. Accounts are {id, login, type}; ids make renames harmless.

export function dedupe(list) {
  const seen = new Map();
  for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()];
}

export function diffLists(prev, next) {
  const p = new Set(prev.map((a) => a.id));
  const n = new Set(next.map((a) => a.id));
  return { added: next.filter((a) => !p.has(a.id)), removed: prev.filter((a) => !n.has(a.id)) };
}

/** Follow events between the stored lists and freshly fetched ones. */
export function buildEvents(prev, followers, following) {
  const f = diffLists(prev.followers, followers);
  const g = diffLists(prev.following, following);
  const ev = (kind) => (a) => ({ kind, id: a.id, login: a.login, type: a.type });
  return [
    ...f.removed.map(ev("unfollowed_you")),
    ...f.added.map(ev("followed_you")),
    ...g.removed.map(ev("you_unfollowed")),
    ...g.added.map(ev("you_followed")),
  ];
}

export function countMutuals(followers, following) {
  const s = new Set(followers.map((a) => a.id));
  return following.filter((a) => s.has(a.id)).length;
}
