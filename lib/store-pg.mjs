// Postgres store (Neon serverless driver over HTTP). Same interface as store-memory.mjs.
// Tables are created on first use, so there is no separate migration step.

const SCHEMA = [
  `create table if not exists ghfs_user (
     id bigint primary key,
     login text not null,
     name text,
     avatar_url text,
     access_token text,
     refresh_token text,
     access_expires_at timestamptz,
     refresh_expires_at timestamptz,
     needs_reauth boolean not null default false,
     last_error text,
     last_snapshot_at timestamptz,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists ghfs_session (
     id_hash text primary key,
     user_id bigint not null references ghfs_user(id) on delete cascade,
     expires_at timestamptz not null,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists ghfs_session_user on ghfs_session (user_id)`,
  `create table if not exists ghfs_edge (
     user_id bigint not null references ghfs_user(id) on delete cascade,
     direction smallint not null,
     gh_id bigint not null,
     login text not null,
     type text not null,
     first_seen timestamptz not null default now(),
     primary key (user_id, direction, gh_id)
   )`,
  `create table if not exists ghfs_event (
     id bigserial primary key,
     user_id bigint not null references ghfs_user(id) on delete cascade,
     kind text not null,
     gh_id bigint not null,
     login text not null,
     type text not null,
     at timestamptz not null default now()
   )`,
  `create index if not exists ghfs_event_user_at on ghfs_event (user_id, at desc)`,
  `create table if not exists ghfs_daily (
     user_id bigint not null references ghfs_user(id) on delete cascade,
     day date not null,
     followers integer not null,
     following integer not null,
     mutuals integer not null,
     primary key (user_id, day)
   )`,
];

const FOLLOWER = 1, FOLLOWING = 2;
const toDate = (v) => (v == null ? null : v instanceof Date ? v : new Date(v));
const toDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function rowToUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id), login: r.login, name: r.name, avatarUrl: r.avatar_url,
    accessToken: r.access_token, refreshToken: r.refresh_token,
    accessExpiresAt: toDate(r.access_expires_at), refreshExpiresAt: toDate(r.refresh_expires_at),
    needsReauth: Boolean(r.needs_reauth), lastError: r.last_error,
    lastSnapshotAt: toDate(r.last_snapshot_at), createdAt: toDate(r.created_at),
  };
}

const USER_COLS = `u.id, u.login, u.name, u.avatar_url, u.access_token, u.refresh_token, u.access_expires_at,
  u.refresh_expires_at, u.needs_reauth, u.last_error, u.last_snapshot_at, u.created_at`;

export async function createPgStore(url) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  let ready = null;
  const ensure = () => (ready ||= sql.transaction(SCHEMA.map((s) => sql.query(s))).catch((e) => { ready = null; throw e; }));
  const q = async (text, params = []) => { await ensure(); return sql.query(text, params); };

  const edgeStatements = (userId, direction, list, at) => {
    const ids = list.map((a) => a.id), logins = list.map((a) => a.login), types = list.map((a) => a.type);
    return [
      sql.query(`delete from ghfs_edge where user_id = $1 and direction = $2 and not (gh_id = any($3::bigint[]))`,
        [userId, direction, ids]),
      sql.query(`insert into ghfs_edge (user_id, direction, gh_id, login, type, first_seen)
                 select $1, $2, x.id, x.login, x.type, $6
                 from unnest($3::bigint[], $4::text[], $5::text[]) as x(id, login, type)
                 on conflict (user_id, direction, gh_id) do update set login = excluded.login, type = excluded.type`,
        [userId, direction, ids, logins, types, at]),
    ];
  };

  return {
    kind: "postgres",

    async upsertUser(u) {
      const rows = await q(
        `insert into ghfs_user as u (id, login, name, avatar_url, access_token, refresh_token, access_expires_at, refresh_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
           access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at,
           needs_reauth = false, last_error = null
         returning ${USER_COLS}`,
        [u.id, u.login, u.name || null, u.avatarUrl || null, u.accessToken, u.refreshToken || null,
          u.accessExpiresAt || null, u.refreshExpiresAt || null]);
      return rowToUser(rows[0]);
    },

    async getUser(id) {
      const rows = await q(`select ${USER_COLS} from ghfs_user u where u.id = $1`, [id]);
      return rowToUser(rows[0]);
    },

    async updateTokens(id, t) {
      await q(`update ghfs_user set access_token = $2, refresh_token = $3, access_expires_at = $4, refresh_expires_at = $5
               where id = $1`,
        [id, t.accessToken, t.refreshToken || null, t.accessExpiresAt || null, t.refreshExpiresAt || null]);
    },

    async setStatus(id, { needsReauth, lastError }) {
      await q(`update ghfs_user set needs_reauth = coalesce($2, needs_reauth),
                 last_error = case when $3::boolean then $4 else last_error end
               where id = $1`,
        [id, needsReauth === undefined ? null : needsReauth, lastError !== undefined, lastError === undefined ? null : lastError]);
    },

    async createSession(hash, userId, expiresAt) {
      await q(`insert into ghfs_session (id_hash, user_id, expires_at) values ($1, $2, $3)`, [hash, userId, expiresAt]);
      // Opportunistic cleanup of this user's expired sessions.
      await q(`delete from ghfs_session where user_id = $1 and expires_at < now()`, [userId]);
    },

    async getSessionUser(hash) {
      const rows = await q(
        `select ${USER_COLS} from ghfs_session s join ghfs_user u on u.id = s.user_id
         where s.id_hash = $1 and s.expires_at > now()`, [hash]);
      return rowToUser(rows[0]);
    },

    async deleteSession(hash) {
      await q(`delete from ghfs_session where id_hash = $1`, [hash]);
    },

    async getEdges(userId) {
      const rows = await q(`select direction, gh_id, login, type, first_seen from ghfs_edge where user_id = $1`, [userId]);
      const out = { followers: [], following: [] };
      for (const r of rows) {
        const a = { id: Number(r.gh_id), login: r.login, type: r.type, firstSeen: toDate(r.first_seen) };
        (Number(r.direction) === FOLLOWER ? out.followers : out.following).push(a);
      }
      return out;
    },

    async saveSnapshot(userId, s) {
      await ensure();
      const ev = s.events;
      await sql.transaction([
        ...edgeStatements(userId, FOLLOWER, s.followers, s.at),
        ...edgeStatements(userId, FOLLOWING, s.following, s.at),
        sql.query(`insert into ghfs_event (user_id, kind, gh_id, login, type, at)
                   select $1, x.kind, x.id, x.login, x.type, $6
                   from unnest($2::text[], $3::bigint[], $4::text[], $5::text[]) as x(kind, id, login, type)`,
          [userId, ev.map((e) => e.kind), ev.map((e) => e.id), ev.map((e) => e.login), ev.map((e) => e.type), s.at]),
        sql.query(`insert into ghfs_daily (user_id, day, followers, following, mutuals) values ($1, $2::date, $3, $4, $5)
                   on conflict (user_id, day) do update set followers = excluded.followers,
                     following = excluded.following, mutuals = excluded.mutuals`,
          [userId, s.daily.day, s.daily.followers, s.daily.following, s.daily.mutuals]),
        sql.query(`update ghfs_user set login = $2, name = $3, avatar_url = $4, last_snapshot_at = $5, last_error = null
                   where id = $1`,
          [userId, s.login, s.name || null, s.avatarUrl || null, s.at]),
      ]);
    },

    async getEvents(userId, limit = 1000) {
      const rows = await q(`select kind, gh_id, login, type, at from ghfs_event where user_id = $1
                            order by at desc, id desc limit $2`, [userId, limit]);
      return rows.map((r) => ({ kind: r.kind, id: Number(r.gh_id), login: r.login, type: r.type, at: toDate(r.at) }));
    },

    async getDaily(userId, limit = 400) {
      const rows = await q(`select day::text as day, followers, following, mutuals from ghfs_daily where user_id = $1
                            order by day desc limit $2`, [userId, limit]);
      return rows.reverse().map((r) => ({
        day: toDay(r.day), followers: Number(r.followers), following: Number(r.following), mutuals: Number(r.mutuals),
      }));
    },

    async listUsersForCron(limit = 500) {
      const rows = await q(`select ${USER_COLS} from ghfs_user u where not u.needs_reauth
                            order by u.last_snapshot_at asc nulls first limit $1`, [limit]);
      return rows.map(rowToUser);
    },

    async deleteUser(id) {
      await q(`delete from ghfs_user where id = $1`, [id]);
    },
  };
}
