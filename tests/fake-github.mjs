// A tiny fake of the parts of GitHub that ghfstats uses: OAuth (with PKCE and refresh tokens),
// REST followers/following, GraphQL follower details and grant revocation.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const b64url = (s) => createHash("sha256").update(s).digest("base64url");
const rnd = () => randomBytes(12).toString("hex");

export function createFakeGitHub({ clientId, clientSecret, accessTtl = 28800 }) {
  const state = {
    me: { id: 1001, login: "octo", name: "Octo Cat", avatar_url: "https://example.test/a.png" },
    followers: [], following: [],
    codes: new Map(), access: new Map(), refresh: new Map(),
    refreshCount: 0, revoked: [], accessTtl,
    details: new Map(), // id -> {followers, following, createdAt}
  };

  const issue = () => {
    const access = "ghu_" + rnd(), refresh = "ghr_" + rnd();
    state.access.set(access, { exp: Date.now() + state.accessTtl * 1000 });
    state.refresh.set(refresh, true);
    return { access_token: access, expires_in: state.accessTtl, refresh_token: refresh,
      refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" };
  };

  const authed = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const t = m && state.access.get(m[1]);
    return t && t.exp > Date.now() ? m[1] : null;
  };

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }

  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(data === undefined ? "" : JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const p = url.pathname;

    if (p === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== clientId) return send(res, 400, { error: "bad client" });
      if (url.searchParams.get("code_challenge_method") !== "S256") return send(res, 400, { error: "pkce required" });
      const code = rnd();
      state.codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") });
      const to = new URL(url.searchParams.get("redirect_uri"));
      to.searchParams.set("code", code);
      to.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }

    if (p === "/login/oauth/access_token" && req.method === "POST") {
      const f = new URLSearchParams(await body(req));
      if (f.get("client_id") !== clientId || f.get("client_secret") !== clientSecret) return send(res, 200, { error: "incorrect_client_credentials" });
      if (f.get("grant_type") === "refresh_token") {
        if (!state.refresh.get(f.get("refresh_token"))) return send(res, 200, { error: "bad_refresh_token" });
        state.refresh.delete(f.get("refresh_token"));
        state.refreshCount++;
        return send(res, 200, issue());
      }
      const c = state.codes.get(f.get("code"));
      state.codes.delete(f.get("code"));
      if (!c || c.redirect !== f.get("redirect_uri") || b64url(f.get("code_verifier") || "") !== c.challenge) {
        return send(res, 200, { error: "bad_verification_code" });
      }
      return send(res, 200, issue());
    }

    if (p.startsWith("/applications/") && p.endsWith("/grant") && req.method === "DELETE") {
      const expect = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      if (req.headers.authorization !== expect) return send(res, 401, { message: "bad creds" });
      const { access_token } = JSON.parse(await body(req));
      state.revoked.push(access_token);
      state.access.delete(access_token);
      res.writeHead(204);
      return res.end();
    }

    const token = authed(req);
    if (!token) return send(res, 401, { message: "Bad credentials" });

    if (p === "/user") {
      return send(res, 200, { ...state.me, type: "User", followers: state.followers.length, following: state.following.length });
    }
    const m = /^\/users\/([^/]+)\/(followers|following)$/.exec(p);
    if (m) {
      if (m[1].toLowerCase() !== state.me.login.toLowerCase()) return send(res, 404, { message: "Not Found" });
      const list = state[m[2]];
      const per = Number(url.searchParams.get("per_page")) || 30, page = Number(url.searchParams.get("page")) || 1;
      return send(res, 200, list.slice((page - 1) * per, page * per));
    }
    if (p === "/graphql" && req.method === "POST") {
      const { variables } = JSON.parse(await body(req));
      const start = variables.after ? Number(variables.after) : 0;
      const slice = state.followers.slice(start, start + 100);
      return send(res, 200, { data: { user: { followers: {
        totalCount: state.followers.length,
        pageInfo: { hasNextPage: start + 100 < state.followers.length, endCursor: String(start + 100) },
        nodes: slice.map((a) => {
          const d = state.details.get(a.id) || { followers: 1, following: 1, createdAt: "2015-01-01T00:00:00Z" };
          return { databaseId: a.id, login: a.login, name: null, createdAt: d.createdAt,
            followers: { totalCount: d.followers }, following: { totalCount: d.following } };
        }),
      } } } });
    }
    send(res, 404, { message: "Not Found" });
  });

  return {
    state,
    listen: () => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => server.close(r)),
  };
}
