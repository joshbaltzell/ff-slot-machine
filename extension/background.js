/**
 * Opens the analysis page, and keeps a quiet daily check on whether it is worth
 * re-opening.
 *
 * What this deliberately does NOT do is run the trade search in the background.
 * MV3 terminates a service worker after five minutes, and a full league pull is
 * nineteen API calls before any searching starts. Rather than fight that - or
 * pretend to have found something - the daily job makes ONE light request per
 * analysed league, through that league's platform adapter, and compares the roster
 * fingerprint it gets back with the one the panel stored from the same function over
 * the same payload. That answers the only question worth nagging about: has anything
 * actually changed?
 *
 * This is a module service worker (manifest `background.type: module`) so it can
 * import the platform registry. It never parses a storage key: every ffsm.league
 * record carries its own `ref`, and the key is opaque. A record with no hash yet -
 * one migrated from a pre-11-04 key, or one whose own fingerprint request failed -
 * adopts the first hash it sees instead of comparing, so an upgrade can never light
 * the badge on a roster that has not moved.
 */
import { byId, leagueKey, migrateStorageKeys, nextLeagueRecord } from "./engine/platforms/index.js";

const DAY = 24 * 60 * 60 * 1000;

chrome.action.onClicked.addListener(async (tab) => {
  const url = chrome.runtime.getURL("panel.html")
    + (tab?.url ? "?from=" + encodeURIComponent(tab.url) : "");
  await chrome.tabs.create({ url });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("ffsm.daily", { periodInMinutes: 60 * 12 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "ffsm.daily") refreshAll();
});

/** Re-check every league the user has actually analysed. */
async function refreshAll() {
  // Whichever of the panel or this worker runs first rewrites the legacy keys.
  try { await migrateStorageKeys(chrome.storage.local); } catch { /* try again next time */ }
  const all = await chrome.storage.local.get(null);
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith("ffsm.league.")) continue;
    const ref = val?.ref;
    const platform = ref && byId(ref.platform);
    if (!platform) continue;                 // no ref, or a platform this build does not know
    try {
      const hash = await platform.fingerprint(ref);
      if (!hash) continue;                   // offline or signed out; the record stands
      await chrome.storage.local.set({ [key]: nextLeagueRecord(val, hash, Date.now()) });
    } catch { /* offline or signed out; try again next time */ }
  }
  await paintBadge();
}

async function paintBadge() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.entries(all).filter(([k, v]) =>
    k.startsWith("ffsm.league.") && (v.changed || Date.now() - (v.at ?? 0) > 7 * DAY));
  await chrome.action.setBadgeText({ text: stale.length ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#3ddc84" });
}

/**
 * The content script asks what, if anything, is worth mentioning on this page. It
 * names the platform from 11-07 on; until then, and for the ESPN script, the
 * platform is espn. Every reply carries `label` so the notice can name the site.
 */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "ffsm.status") return false;
  (async () => {
    const platform = msg.platform ?? "espn";
    const label = byId(platform)?.label ?? null;
    const key = leagueKey({ platform, leagueId: msg.leagueId, seasonId: msg.seasonId });
    const { [key]: rec } = await chrome.storage.local.get(key);
    const dismissKey = `ffsm.dismissed.${platform}.${msg.leagueId}`;
    const { [dismissKey]: dismissed } = await chrome.storage.local.get(dismissKey);

    // One mention a day at most. A daily reminder is a nudge; more is nagging.
    if (dismissed && Date.now() - dismissed < DAY) return reply({ show: false, label });
    if (!rec) return reply({ show: true, first: true, label });

    const ageDays = Math.floor((Date.now() - (rec.at ?? 0)) / DAY);
    if (rec.changed) return reply({ show: true, changed: true, offers: rec.offers ?? 0, label });
    if (ageDays >= 7) return reply({ show: true, stale: ageDays, offers: rec.offers ?? 0, label });
    if ((rec.offers ?? 0) > 0 && ageDays >= 1)
      return reply({ show: true, offers: rec.offers, team: rec.team, label });
    return reply({ show: false, label });
  })();
  return true;      // async reply
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ffsm.open") {
    chrome.tabs.create({ url: chrome.runtime.getURL("panel.html")
      + "?from=" + encodeURIComponent(msg.from ?? "") });
  }
  if (msg?.type === "ffsm.dismiss") {
    const platform = msg.platform ?? "espn";
    chrome.storage.local.set({ [`ffsm.dismissed.${platform}.${msg.leagueId}`]: Date.now() });
  }
  if (msg?.type === "ffsm.analysed") paintBadge();
});
