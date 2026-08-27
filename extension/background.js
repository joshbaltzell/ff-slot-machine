/**
 * Opens the analysis page, and keeps a quiet daily check on whether it is worth
 * re-opening.
 *
 * What this deliberately does NOT do is run the trade search in the background.
 * MV3 terminates a service worker after five minutes, and a full league pull is
 * eighteen API calls before any searching starts. Rather than fight that - or
 * pretend to have found something - the daily job makes ONE request for the current
 * week's rosters and compares them to the rosters the last analysis was built on.
 * That answers the only question worth nagging about: has anything actually changed?
 */

const API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
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

/** A stable fingerprint of who is on which roster. */
function rosterHash(teams) {
  const parts = (teams ?? [])
    .map((t) => `${t.id}:${(t.roster?.entries ?? [])
      .map((e) => e.playerPoolEntry?.id ?? e.playerId).sort().join(",")}`)
    .sort();
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

async function checkLeague(leagueId, seasonId) {
  const res = await fetch(
    `${API}/seasons/${seasonId}/segments/0/leagues/${leagueId}?view=mRoster&view=mTeam`,
    { credentials: "include", headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const blob = await res.json();
  return rosterHash(blob.teams);
}

/** Re-check every league the user has actually analysed. */
async function refreshAll() {
  const all = await chrome.storage.local.get(null);
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith("ffsm.league.")) continue;
    const [, , leagueId, seasonId] = key.split(".");
    try {
      const hash = await checkLeague(leagueId, seasonId);
      if (!hash) continue;
      const changed = val.rosterHash && hash !== val.rosterHash;
      await chrome.storage.local.set({
        [key]: { ...val, latestHash: hash, changed, checkedAt: Date.now() },
      });
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

/** The content script asks what, if anything, is worth mentioning on this page. */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "ffsm.status") return false;
  (async () => {
    const key = `ffsm.league.${msg.leagueId}.${msg.seasonId}`;
    const { [key]: rec } = await chrome.storage.local.get(key);
    const dismissKey = `ffsm.dismissed.${msg.leagueId}`;
    const { [dismissKey]: dismissed } = await chrome.storage.local.get(dismissKey);

    // One mention a day at most. A daily reminder is a nudge; more is nagging.
    if (dismissed && Date.now() - dismissed < DAY) return reply({ show: false });
    if (!rec) return reply({ show: true, first: true });

    const ageDays = Math.floor((Date.now() - (rec.at ?? 0)) / DAY);
    if (rec.changed) return reply({ show: true, changed: true, offers: rec.offers ?? 0 });
    if (ageDays >= 7) return reply({ show: true, stale: ageDays, offers: rec.offers ?? 0 });
    if ((rec.offers ?? 0) > 0 && ageDays >= 1)
      return reply({ show: true, offers: rec.offers, team: rec.team });
    return reply({ show: false });
  })();
  return true;      // async reply
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ffsm.open") {
    chrome.tabs.create({ url: chrome.runtime.getURL("panel.html")
      + "?from=" + encodeURIComponent(msg.from ?? "") });
  }
  if (msg?.type === "ffsm.dismiss") {
    chrome.storage.local.set({ [`ffsm.dismissed.${msg.leagueId}`]: Date.now() });
  }
  if (msg?.type === "ffsm.analysed") paintBadge();
});
