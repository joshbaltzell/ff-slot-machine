/**
 * A small notice on the league page, whichever platform it belongs to, when there is
 * something worth saying.
 *
 * The bar for showing this is deliberately high: at most once a day per league, and
 * only when the rosters have actually changed, the analysis has gone stale, or there
 * are offers waiting that the user has not looked at today. An extension that
 * reminds you it exists every single visit gets uninstalled.
 *
 * This script also answers the panel's token hand-over on a CBS league page. It is
 * not a module - Chrome has no module content scripts - so the two patterns it needs
 * are duplicated from `engine/platforms/cbs.js`, which is the source of truth for
 * both. `test/platform.mjs` reads this file as text and fails if either copy drifts.
 */
(function () {
  const CBS_HOST = /^([a-z0-9-]+)\.football\.cbssports\.com$/i;   // = CBS_HOST_RE
  const CBS_TOKEN = /CBSi\.token\s*=\s*"([^"]+)"/;                // = TOKEN_PATTERNS P1

  const ref = detectRef();
  if (!ref) return;                            // not a league page on either platform

  if (ref.platform === "cbs") {
    // The last sanctioned token route (D-10): the panel asks the tab the user is
    // already sitting on for the token in its own page. Page scripts run in another
    // world, so `window.CBSi` is invisible here - the script TEXT is what we read.
    // Nothing is stored and nothing is logged; the value only ever rides the reply.
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type !== "ffsm.token") return false;
      const m = CBS_TOKEN.exec(document.documentElement.outerHTML);
      reply({ token: m?.[1] ?? null });
      return false;                            // answered synchronously
    });
  }

  chrome.runtime.sendMessage(
    { type: "ffsm.status", platform: ref.platform, leagueId: ref.leagueId, seasonId: ref.seasonId },
    (res) => {
      if (chrome.runtime.lastError || !res?.show) return;
      show(res);
    });

  /** Which league this page is, and on which platform, or null. */
  function detectRef() {
    const cbs = CBS_HOST.exec(location.hostname);
    const slug = cbs?.[1]?.toLowerCase();
    if (slug && slug !== "www")                // "www" is the lobby, not a league
      return { platform: "cbs", leagueId: slug, seasonId: new Date().getFullYear() };
    const params = new URLSearchParams(location.search);
    const leagueId = params.get("leagueId");
    if (!leagueId) return null;
    return { platform: "espn", leagueId,
             seasonId: params.get("seasonId") || new Date().getFullYear() };
  }

  function show(res) {
    const el = document.createElement("div");
    el.className = "ffsm-pill";
    el.innerHTML = `
      <div class="ffsm-mark" aria-hidden="true">FF</div>
      <div class="ffsm-body">
        <div class="ffsm-title"></div>
        <div class="ffsm-sub"></div>
      </div>
      <button class="ffsm-go">Open</button>
      <button class="ffsm-x" title="Not today" aria-label="Dismiss">&times;</button>`;
    // Text, not markup: the title and the subtitle carry a team name that came out of
    // storage, and this pill is rendered on a page we do not own.
    el.querySelector(".ffsm-title").textContent = title(res);
    el.querySelector(".ffsm-sub").textContent = sub(res);
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("ffsm-in"));

    el.querySelector(".ffsm-go").onclick = () => {
      chrome.runtime.sendMessage({ type: "ffsm.open", from: location.href });
      close();
    };
    el.querySelector(".ffsm-x").onclick = () => {
      chrome.runtime.sendMessage(
        { type: "ffsm.dismiss", platform: ref.platform, leagueId: ref.leagueId });
      close();
    };
    // Slide away on its own; the badge on the toolbar icon is the persistent cue.
    const timer = setTimeout(close, 15000);
    function close() {
      clearTimeout(timer);
      el.classList.remove("ffsm-in");
      setTimeout(() => el.remove(), 260);
    }
  }

  function title(r) {
    if (r.first) return "FF Slot Machine is ready";
    if (r.changed) return "Rosters have changed";
    if (r.stale) return "Your analysis is out of date";
    return r.offers === 1 ? "1 trade option for you" : `${r.offers} trade options for you`;
  }
  function sub(r) {
    if (r.first) return "Analyse this league to see trades worth making.";
    if (r.changed) return "Someone traded or hit waivers — the numbers have moved.";
    if (r.stale) return `Last run ${r.stale} days ago. ${r.label ?? "Your platform"} reprojects every week.`;
    return r.team ? `Based on ${r.team}'s roster.` : "Both sides gain on every one.";
  }
})();
