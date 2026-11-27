// In-memory store with the same interface as store-pg.mjs. For local development and tests.

export function createMemoryStore() {
  const rates = new Map();
  const users = new Map(), sessions = new Map(), edges = new Map(), events = new Map(), daily = new Map(), actions = new Map();
  let eventSeq = 0;
  const copy = (u) => (u ? { ...u } : null);

  return {
    kind: "memory",

    async upsertUser(u) {
      const prev = users.get(u.id);
      const next = {
        lastSnapshotAt: null, createdAt: new Date(), ...prev,
        id: u.id, login: u.login, name: u.name || null, avatarUrl: u.avatarUrl || null,
        accessToken: u.accessToken, refreshToken: u.refreshToken || null,
        accessExpiresAt: u.accessExpiresAt || null, refreshExpiresAt: u.refreshExpiresAt || null,
        needsReauth: false, lastError: null,
      };
      users.set(u.id, next);
      return copy(next);
    },

    async getUser(id) { return copy(users.get(id)); },

    async updateTokens(id, t) {
      const u = users.get(id);
      if (u) Object.assign(u, {
        accessToken: t.accessToken, refreshToken: t.refreshToken || null,
        accessExpiresAt: t.accessExpiresAt || null, refreshExpiresAt: t.refreshExpiresAt || null,
      });
    },

    async setStatus(id, { needsReauth, lastError }) {
      const u = users.get(id);
      if (!u) return;
      if (needsReauth !== undefined) u.needsReauth = needsReauth;
      if (lastError !== undefined) u.lastError = lastError;
    },

    async createSession(hash, userId, expiresAt) { sessions.set(hash, { userId, expiresAt }); },

    async getSessionUser(hash) {
      const s = sessions.get(hash);
      if (!s) return null;
      if (s.expiresAt.getTime() <= Date.now()) { sessions.delete(hash); return null; }
      return copy(users.get(s.userId));
    },

    async deleteSession(hash) { sessions.delete(hash); },

    async getEdges(userId) {
      const e = edges.get(userId) || { followers: [], following: [] };
      return { followers: e.followers.map((a) => ({ ...a })), following: e.following.map((a) => ({ ...a })) };
    },

    async saveSnapshot(userId, s) {
      const prev = edges.get(userId) || { followers: [], following: [] };
      const keep = (old, list) => {
        const firstSeen = new Map(old.map((a) => [a.id, a.firstSeen]));
        return list.map((a) => ({ id: a.id, login: a.login, type: a.type, firstSeen: firstSeen.get(a.id) || s.at }));
      };
      edges.set(userId, { followers: keep(prev.followers, s.followers), following: keep(prev.following, s.following) });
      const list = events.get(userId) || [];
      for (const e of s.events) list.push({ seq: ++eventSeq, ...e, at: s.at });
      events.set(userId, list);
      const d = daily.get(userId) || new Map();
      d.set(s.daily.day, { ...s.daily });
      daily.set(userId, d);
      const u = users.get(userId);
      if (u) Object.assign(u, {
        login: s.login, name: s.name || null, avatarUrl: s.avatarUrl || null, lastSnapshotAt: s.at, lastError: null,
      });
    },

    async getEvents(userId, limit = 1000) {
      return (events.get(userId) || []).slice().sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, limit)
        .map(({ seq, ...e }) => ({ ...e }));
    },

    async getDaily(userId, limit = 400) {
      return [...(daily.get(userId) || new Map()).values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-limit);
    },

    async findEdge(userId, direction, login) {
      const e = edges.get(userId);
      const list = e ? (direction === "followers" ? e.followers : e.following) : [];
      const hit = list.find((a) => a.login.toLowerCase() === String(login).toLowerCase());
      return hit ? { ...hit } : null;
    },

    async recentActions(userId, since) {
      return (actions.get(userId) || []).filter((a) => a.at >= since).map((a) => ({ ...a }));
    },

    /** Records a follow or unfollow the user made from ghfstats: list, history and the action log. */
    async applyFollowChange(userId, { kind, id, login, type, at }) {
      const e = edges.get(userId) || { followers: [], following: [] };
      e.following = e.following.filter((a) => a.id !== id);
      if (kind === "you_followed") e.following.push({ id, login, type, firstSeen: at });
      edges.set(userId, e);
      const list = events.get(userId) || [];
      list.push({ seq: ++eventSeq, kind, id, login, type, at });
      events.set(userId, list);
      const log = actions.get(userId) || [];
      log.push({ kind: kind === "you_followed" ? "follow" : "unfollow", at });
      actions.set(userId, log);
    },

    async listUsersForCron(limit = 500) {
      return [...users.values()].filter((u) => !u.needsReauth)
        .sort((a, b) => (a.lastSnapshotAt ? a.lastSnapshotAt.getTime() : 0) - (b.lastSnapshotAt ? b.lastSnapshotAt.getTime() : 0))
        .slice(0, limit).map(copy);
    },

    async deleteUser(id) {
      users.delete(id); edges.delete(id); events.delete(id); daily.delete(id); actions.delete(id);
      for (const [h, s] of sessions) if (s.userId === id) sessions.delete(h);
    },

    async hit(key, windowSec) {
      const now = Date.now(), bucket = Math.floor(now / (windowSec * 1000));
      const resetAt = new Date((bucket + 1) * windowSec * 1000);
      const k = `${key}|${bucket}`;
      const count = ((rates.get(k) || {}).count || 0) + 1;
      rates.set(k, { count, resetAt });
      if (rates.size > 5000) for (const [old, v] of rates) if (v.resetAt.getTime() < now) rates.delete(old);
      return { count, resetAt };
    },
  };
}
