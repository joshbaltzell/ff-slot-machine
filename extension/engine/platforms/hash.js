/**
 * The roster fingerprint every platform shares.
 *
 * A leaf on purpose. platforms/index.js re-exports it and every adapter imports it
 * from here, never from index.js: index.js reads each adapter's default export
 * while it evaluates (`PLATFORMS = [espn, ...]`), so an adapter that imported
 * anything from index.js would close a cycle that throws a ReferenceError whenever
 * that adapter - or league.js, which re-exports it - is the module entry point.
 */

/**
 * Java-style 31-hash over `${id}:${sorted ids}` parts joined by "|", returned as a
 * decimal string. Order-independent in both teams and ids: ids sort numerically,
 * parts sort with the default sort. This is the form the panel's stored rosterHash
 * has always had; since 11-04 the panel stores model.fingerprint and the daily check
 * in background.js hashes the same payload with this same function, so the two can
 * never drift apart.
 *
 * @param {Iterable<{id: number|string, ids: Iterable<number|string>}>} teams
 * @returns {string}
 */
export function hashRosters(teams) {
  const parts = [];
  for (const t of teams ?? []) {
    parts.push(`${t.id}:${[...(t.ids ?? [])].map(Number).sort((a, b) => a - b).join(",")}`);
  }
  parts.sort();
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}
