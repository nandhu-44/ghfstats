// Response, cookie and request helpers for the Web-standard function handlers.

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function fail(status, message, extra = {}) {
  return json({ error: message, ...extra }, { status });
}

export function redirect(location, setCookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

export function parseCookies(request) {
  const out = {};
  const header = request.headers.get("cookie");
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

export function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}

export function serializeCookie(name, value, { maxAge, secure = true, httpOnly = true, sameSite = "Lax", path = "/" } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) s += "; HttpOnly";
  if (secure) s += "; Secure";
  if (maxAge != null) s += `; Max-Age=${maxAge}`;
  return s;
}

/** Blocks cross-site form posts and fetches on state-changing endpoints. */
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

/** Wraps a handler so unexpected errors become a JSON 500 instead of a crash page. */
export function handle(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (e) {
      console.error(e);
      return fail(500, "Something went wrong on the server. Try again in a moment.");
    }
  };
}
