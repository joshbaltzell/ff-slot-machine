/**
 * Cached fetch for external feeds.
 *
 * Every source outside ESPN goes through here so that: (1) a feed is fetched at
 * most once per TTL - Sleeper's player file is ~5 MB and they ask for one pull a
 * day; (2) a dead feed degrades to "unavailable" instead of a crash; (3) tests can
 * inject `fetchImpl` and `storage` and never touch the network.
 *
 * Storage is chrome.storage.local when present (the manifest asks for
 * unlimitedStorage), else an in-memory Map, so the same code runs under node.
 */
const memory = new Map();
const memStorage = {
  async get(key) { return { [key]: memory.get(key) }; },
  async set(obj) { for (const [k, v] of Object.entries(obj)) memory.set(k, v); },
  async remove(key) { memory.delete(key); },
};

export function defaultStorage() {
  return (typeof chrome !== "undefined" && chrome.storage?.local) ? chrome.storage.local : memStorage;
}

/**
 * @param key      storage key, e.g. "src.sleeper.players"
 * @param url      what to fetch when the cache is cold or stale
 * @param ttlMs    how long a cached copy stays fresh
 * @param opts     { fetchImpl, storage, parse: "json"|"text", transform(raw) -> stored value, now }
 * @returns { data, at, fromCache } ; throws when the fetch fails and no cache exists.
 *          A failed fetch with a stale cache returns the stale copy with `stale: true`.
 */
export async function cached(key, url, ttlMs, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const storage = opts.storage ?? defaultStorage();
  const now = opts.now ?? Date.now();
  const hit = (await storage.get(key))[key];
  if (hit && now - hit.at < ttlMs) return { data: hit.data, at: hit.at, fromCache: true };
  try {
    const res = await fetchImpl(url, { headers: { Accept: opts.parse === "text" ? "text/plain" : "application/json" } });
    if (!res.ok) throw new Error(`${res.status}`);
    const raw = opts.parse === "text" ? await res.text() : await res.json();
    const data = opts.transform ? opts.transform(raw) : raw;
    await storage.set({ [key]: { at: now, data } });
    return { data, at: now, fromCache: false };
  } catch (err) {
    if (hit) return { data: hit.data, at: hit.at, fromCache: true, stale: true, error: String(err.message ?? err) };
    throw new Error(`${url} unavailable (${err.message ?? err})`);
  }
}
