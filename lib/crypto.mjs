// Small crypto helpers built on node:crypto. Two keys are derived from AUTH_SECRET:
// one signs cookies, the other encrypts GitHub tokens at rest (AES-256-GCM).
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual,
} from "node:crypto";
import { env } from "./config.mjs";

let cache = null;

function keys() {
  const secret = env("AUTH_SECRET");
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be set to at least 32 characters.");
  if (cache && cache.secret === secret) return cache;
  const derive = (info) => Buffer.from(hkdfSync("sha256", secret, "ghfstats", info, 32));
  cache = { secret, mac: derive("cookie-mac-v1"), enc: derive("token-enc-v1") };
  return cache;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function pkceChallenge(verifier) {
  return sha256(verifier);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function mac(value) {
  return createHmac("sha256", keys().mac).update(value).digest("base64url");
}

/** "value.signature" */
export function sign(value) {
  return `${value}.${mac(value)}`;
}

/** Returns the value if the signature is valid, otherwise null. */
export function unsign(signed) {
  if (typeof signed !== "string") return null;
  const i = signed.lastIndexOf(".");
  if (i < 1) return null;
  const value = signed.slice(0, i);
  return safeEqual(signed.slice(i + 1), mac(value)) ? value : null;
}

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keys().enc, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}

/** Throws if the value was tampered with or sealed with another key. */
export function decrypt(sealed) {
  if (!sealed) return null;
  const [v, iv, ct, tag] = String(sealed).split(".");
  if (v !== "v1" || !iv || !ct || !tag) throw new Error("Unrecognised encrypted value.");
  const d = createDecipheriv("aes-256-gcm", keys().enc, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
