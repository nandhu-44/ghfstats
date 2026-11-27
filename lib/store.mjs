import { databaseUrl, useMemoryStore } from "./config.mjs";
import { createMemoryStore } from "./store-memory.mjs";

let storePromise = null;

/** The configured store, created once per function instance. */
export function getStore() {
  if (!storePromise) {
    const url = databaseUrl();
    if (url) storePromise = import("./store-pg.mjs").then((m) => m.createPgStore(url));
    else if (useMemoryStore()) storePromise = Promise.resolve(createMemoryStore());
    else storePromise = Promise.reject(new Error("No database configured (set DATABASE_URL)."));
    storePromise.catch(() => { storePromise = null; });
  }
  return storePromise;
}

/** Tests only. */
export function setStoreForTests(store) {
  storePromise = Promise.resolve(store);
}
