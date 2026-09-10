/*
 * FF Slot Machine — CBS spike capture. Paste this whole file into the DevTools console.
 *
 * Where: your league's home page while signed in — https://<slug>.football.cbssports.com/
 * How:   Cmd+Option+J, Console tab, paste, Enter.
 * What:  about fifteen GET requests to your own league through your own session, all to
 *        this page's origin and to https://api.cbssports.com, then a download of
 *        ffsm-cbs-spike-raw.json to your Downloads folder and the line CAPTURE OK.
 *
 * THE DOWNLOAD CONTAINS A LIVE API TOKEN AND YOUR LEAGUE'S REAL NAMES. scrub.mjs turns it
 * into fixtures and it is then deleted; it never enters the repository. Cookie names are
 * recorded, never their values. No sign-in form is read, no login URL is touched, and
 * nothing is sent anywhere but cbssports.com.
 *
 * Bundle shape, consumed by scrub.mjs (the route keys must stay identical to ROUTE_FILES
 * and PRIOR_SEASON_ROUTES there):
 *   { capturedAt, slug, href, cookieNames, token: {found, pattern, length},
 *     viewerHints: [{pattern, context}], probes: {A, B, C},
 *     responses: {routeKey: {url, status, ok, body}}, pageHtml }
 */
(async () => {
  const out = {
    capturedAt: new Date().toISOString(),
    slug: location.hostname.split(".")[0],
    href: location.href,
    cookieNames: [],
    token: { found: false, pattern: null, length: null },
    viewerHints: [],
    probes: {},
    responses: {},
    pageHtml: "",
  };
  const say = (...a) => console.log("[ffsm capture]", ...a);
  try {
    if (!/\.football\.cbssports\.com$/.test(location.hostname)) {
      throw new Error(`this page is ${location.hostname}; open https://<slug>.football.cbssports.com/ first`);
    }
    const html = document.documentElement.outerHTML;
    out.pageHtml = html;
    out.cookieNames = document.cookie.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);

    // The token, if the page carries one: P1, then P2, then P3. Only {found, pattern, length}
    // is recorded here; the value itself stays inside pageHtml, which scrub.mjs redacts.
    const PATTERNS = [
      ["P1", /var token\s*=\s*"([^"]+)"/],
      ["P2", /"access_token"\s*:\s*"([^"]+)"/],
      ["P3", /access_token=([A-Za-z0-9._~%-]+)/],
    ];
    let token = null;
    for (const [name, re] of PATTERNS) {
      const m = re.exec(html);
      if (m) { token = m[1]; out.token = { found: true, pattern: name, length: m[1].length }; break; }
    }

    // Viewer hints: where the page might name the viewer's own team id. Contexts are cut
    // from a copy with the token already blanked, so no hint can carry a token fragment.
    const hintHtml = token ? html.split(token).join("REDACTED") : html;
    const hintRe = /(my_team_id|myTeamId|owner_team_id|team_id|teamId)[^0-9]{0,20}\d+/g;
    let m;
    while ((m = hintRe.exec(hintHtml)) && out.viewerHints.length < 60) {
      out.viewerHints.push({ pattern: m[1], context: hintHtml.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) });
    }

    const Q = "version=3.0&SPORT=football&response_format=JSON";
    const proxy = (route) => `${location.origin}/api/${route}${route.includes("?") ? "&" : "?"}${Q}`;
    const probe = async (url, init) => {
      try {
        const res = await fetch(url, init);
        let env = null;
        try { env = await res.clone().json(); } catch (_) { /* not JSON */ }
        return { url, status: res.status, ok: res.ok, envelopeStatusCode: env && env.statusCode != null ? env.statusCode : null };
      } catch (e) {
        return { url, status: 0, ok: false, envelopeStatusCode: null, error: String(e && e.message ? e.message : e) };
      }
    };

    // A: the league subdomain's /api proxy with the session cookie and no token.
    out.probes.A = await probe(proxy("league/details"), { credentials: "include" });
    // B and C: api.cbssports.com with the page token, as a bare Authorization header and as a query parameter.
    if (token) {
      const api = `https://api.cbssports.com/fantasy/league/details?${Q}&league_id=${encodeURIComponent(out.slug)}`;
      out.probes.B = await probe(api, { headers: { Authorization: token } });
      out.probes.C = await probe(`${api}&access_token=${encodeURIComponent(token)}`);
    } else {
      out.probes.B = null;
      out.probes.C = null;
    }
    say(`token in page: ${out.token.found ? `${out.token.pattern}, ${out.token.length} chars` : "none"}; probe A ${out.probes.A.status}`
      + (token ? `; B ${out.probes.B.status}; C ${out.probes.C.status}` : ""));

    // Every league-scoped route, through the proxy with the session cookie.
    const ROUTES = [
      "league/details",
      "league/rules",
      "league/scoring/rules",
      "league/rosters?team_id=all",
      "league/stats?stats_type=projections&period=week1&player_status=all",
      "league/stats?stats_type=projections&period=week2&player_status=all",
      "league/stats?stats_type=projections&period=week1&player_status=free_agents",
      "league/schedules?period=all",
      "league/standings/overall",
      "league/fantasy-points/weekly-scoring",
      "league/fantasy-points/weekly-scoring?timeframe=2025",
      "league/stats?stats_type=projections&period=week1&timeframe=2025",
      "league/stats?stats_type=stats&period=week1&timeframe=2025",
      "league/transaction-list/add-drops",
    ];
    for (const route of ROUTES) {
      const url = proxy(route);
      try {
        const res = await fetch(url, { credentials: "include" });
        const text = await res.text();
        let body = text;
        try { body = JSON.parse(text); } catch (_) { /* keep the text */ }
        out.responses[route] = { url, status: res.status, ok: res.ok, body };
        say(`${route} -> ${res.status}`);
      } catch (e) {
        out.responses[route] = { url, status: 0, ok: false, body: String(e && e.message ? e.message : e) };
        say(`${route} -> failed: ${e && e.message ? e.message : e}`);
      }
    }

    // Download the bundle. A Blob URL stays inside this tab; nothing is uploaded anywhere.
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "ffsm-cbs-spike-raw.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
    say(`${Object.keys(out.responses).length} routes, ${out.viewerHints.length} viewer hints, ${Math.round(blob.size / 1024)} KB -> Downloads/ffsm-cbs-spike-raw.json`);
    console.log("CAPTURE OK");
  } catch (e) {
    console.log("CAPTURE FAILED: " + (e && e.message ? e.message : e));
  }
})();
