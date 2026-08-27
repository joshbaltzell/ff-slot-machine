/**
 * A small notice on the ESPN fantasy page, when there is something worth saying.
 *
 * The bar for showing this is deliberately high: at most once a day per league, and
 * only when the rosters have actually changed, the analysis has gone stale, or there
 * are offers waiting that the user has not looked at today. An extension that
 * reminds you it exists every single visit gets uninstalled.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const leagueId = params.get("leagueId");
  if (!leagueId) return;                       // not on a league page
  const seasonId = params.get("seasonId") || new Date().getFullYear();

  chrome.runtime.sendMessage(
    { type: "ffsm.status", leagueId, seasonId },
    (res) => {
      if (chrome.runtime.lastError || !res?.show) return;
      show(res);
    });

  function show(res) {
    const el = document.createElement("div");
    el.className = "ffsm-pill";
    el.innerHTML = `
      <div class="ffsm-mark" aria-hidden="true">FF</div>
      <div class="ffsm-body">
        <div class="ffsm-title">${title(res)}</div>
        <div class="ffsm-sub">${sub(res)}</div>
      </div>
      <button class="ffsm-go">Open</button>
      <button class="ffsm-x" title="Not today" aria-label="Dismiss">&times;</button>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("ffsm-in"));

    el.querySelector(".ffsm-go").onclick = () => {
      chrome.runtime.sendMessage({ type: "ffsm.open", from: location.href });
      close();
    };
    el.querySelector(".ffsm-x").onclick = () => {
      chrome.runtime.sendMessage({ type: "ffsm.dismiss", leagueId });
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
    if (r.stale) return `Last run ${r.stale} days ago. ESPN reprojects every week.`;
    return r.team ? `Based on ${r.team}'s roster.` : "Both sides gain on every one.";
  }
})();
