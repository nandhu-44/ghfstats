// Local server that mimics Vercel: static files from public/ and functions from api/.
//   GHFS_MEMORY_STORE=1 AUTH_SECRET=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... node scripts/dev.mjs
// Without a database URL, GHFS_MEMORY_STORE=1 keeps data in memory until the server stops.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PUBLIC = join(ROOT, "public");
const REWRITES = { "/": "/index.html", "/dashboard": "/dashboard.html", "/privacy": "/privacy.html" };
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

async function toRequest(req, origin) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const body = chunks.length && !["GET", "HEAD"].includes(req.method) ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url, origin), { method: req.method, headers, body });
}

async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function handleApi(req, res, pathname, origin) {
  const file = normalize(join(ROOT, pathname + ".mjs"));
  if (!file.startsWith(join(ROOT, "api"))) return notFound(res);
  try { await stat(file); } catch { return notFound(res); }
  const mod = await import(pathToFileURL(file).href);
  const fn = mod[req.method];
  if (!fn) { res.writeHead(405, { allow: Object.keys(mod).join(", ") }); return res.end(); }
  await sendResponse(res, await fn(await toRequest(req, origin)));
}

async function handleStatic(res, pathname) {
  const path = REWRITES[pathname] || pathname;
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return notFound(res);
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { notFound(res); }
}

function notFound(res) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); }

export function startDevServer(port = Number(process.env.PORT) || 3000) {
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host || `localhost:${port}`}`;
    const { pathname } = new URL(req.url, origin);
    try {
      if (pathname.startsWith("/api/")) await handleApi(req, res, pathname, origin);
      else await handleStatic(res, pathname);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end("Server error");
    }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startDevServer();
  console.log(`ghfstats dev server on http://localhost:${server.address().port}`);
}
