// Login sessions: a random id in a signed, HttpOnly cookie; only its hash is stored.
import { randomToken, sha256, sign, unsign } from "./crypto.mjs";
import { isSecure, parseCookies, serializeCookie } from "./http.mjs";

export const SESSION_COOKIE = "ghfs_session";
export const OAUTH_COOKIE = "ghfs_oauth";
const SESSION_DAYS = 30;

function sessionHash(request) {
  const raw = parseCookies(request)[SESSION_COOKIE];
  const id = raw ? unsign(raw) : null;
  return id ? sha256(id) : null;
}

export async function currentUser(request, store) {
  const hash = sessionHash(request);
  return hash ? store.getSessionUser(hash) : null;
}

/** Creates a session and returns its Set-Cookie value. */
export async function startSession(request, store, userId) {
  const id = randomToken(32);
  await store.createSession(sha256(id), userId, new Date(Date.now() + SESSION_DAYS * 86400e3));
  return serializeCookie(SESSION_COOKIE, sign(id), { maxAge: SESSION_DAYS * 86400, secure: isSecure(request) });
}

/** Deletes the session (if any) and returns a Set-Cookie value that clears it. */
export async function endSession(request, store) {
  const hash = sessionHash(request);
  if (hash) await store.deleteSession(hash);
  return clearCookie(request, SESSION_COOKIE);
}

export function clearCookie(request, name) {
  return serializeCookie(name, "", { maxAge: 0, secure: isSecure(request) });
}
