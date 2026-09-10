#!/usr/bin/env node
/**
 * FF Slot Machine — CBS spike scrubber. Node, no dependencies.
 *
 *   node scrub.mjs <raw.json> <outDir>   scrub a capture bundle into fixture files
 *   node scrub.mjs --self-test           round-trip a synthetic bundle; prints SCRUB OK
 *   node scrub.mjs --verify <dir>        re-check a fixture directory; prints FIXTURES OK
 *
 * The raw bundle capture.js downloads carries a live API token, the league slug, team
 * names and owner strings. None of those may reach the repository (D-18). Rules 1 and 2 are
 * applied to every string in the bundle — keys, values and URLs alike; rules 3 and 4 stop at
 * the value boundary, because a key is a schema name (see mapStrings):
 *
 *   1. every token value P1–P5 find in pageHtml, and every access_token= value  -> REDACTED
 *   2. the slug                                                                  -> redacted-league
 *   3. team names under rosters/standings/schedules team objects                 -> Team A, Team B, …
 *      (first-seen order, skipping any label a real team already uses; the longest
 *      name is replaced first)
 *   4. owner-shaped fields inside team/owner objects                             -> Owner N / owner-n@example.invalid
 *
 * Two extras cost nothing and close obvious gaps: the league's own display name becomes
 * "Redacted League", and any e-mail address anywhere becomes owner-n@example.invalid.
 *
 * After writing, every output file is re-read. If a collected secret survives — whole, or
 * as a 12-character fragment of a token — the written files are deleted, the run prints
 * SCRUB FAILED and exits 1. `--verify` re-checks a directory without knowing the secrets
 * and exits 2 printing STOP AND REPORT when README.md records `auth_route: none` (D-11).
 *
 * Nothing here is imported by the extension or by run-all.mjs (which is non-recursive).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const SELF = fileURLToPath(import.meta.url);

/* ===================== tables shared with capture.js ===================== */
/* The route keys must stay identical to the ROUTES list in capture.js. */

/* Observed on a signed-in league page, 2026-09-10: the API token is set as CBSi.token = "…"
 * (106 chars) and passed to the page's own API calls as 'access_token': '…'; a separate,
 * shorter "token" : "…" sits in the chat/websocket config; var token = "…" is the 2017 form,
 * kept as a fallback. Order matters: the first match names the API token. */
export const TOKEN_PATTERNS = [
  ["P1", 'CBSi\\.token\\s*=\\s*"([^"]+)"'],
  ["P2", "['\"]access_token['\"]\\s*:\\s*['\"]([^'\"]+)['\"]"],
  ["P3", '"token"\\s*:\\s*"([^"]+)"'],
  ["P4", 'var token\\s*=\\s*"([^"]+)"'],
  ["P5", "access_token=([A-Za-z0-9._~%-]+)"],
];
const re = (src, flags = "g") => new RegExp(src, flags);

export const ROUTE_FILES = {
  "league/details": "details.json",
  "league/rules": "rules.json",
  "league/scoring/rules": "scoring-rules.json",
  "league/rosters?team_id=all": "rosters.json",
  "league/stats?stats_type=projections&period=week1&player_status=all": "stats-week1.json",
  "league/stats?stats_type=projections&period=week2&player_status=all": "stats-week2.json",
  "league/stats?stats_type=projections&period=week1&player_status=free_agents": "stats-free-agents-week1.json",
  "league/schedules?period=all": "schedules.json",
  "league/standings/overall": "standings.json",
  "league/fantasy-points/weekly-scoring": "weekly-scoring.json",
  "league/transaction-list/add-drops": "transactions.json",
};
export const PRIOR_SEASON_ROUTES = [
  "league/fantasy-points/weekly-scoring?timeframe=2025",
  "league/stats?stats_type=projections&period=week1&timeframe=2025",
  "league/stats?stats_type=stats&period=week1&timeframe=2025",
];
/* Routes whose bodies are read with the root treated as a list of teams. */
const TEAM_ROUTES = new Set(["league/rosters?team_id=all", "league/standings/overall", "league/schedules?period=all"]);

/* What --verify insists on. stats-week2.json and transactions.json are written when the
 * route answered but a league in its first week, or with no transactions, may lack them. */
export const REQUIRED_FILES = [
  "details.json", "rules.json", "scoring-rules.json", "rosters.json", "stats-week1.json",
  "stats-free-agents-week1.json", "schedules.json", "standings.json", "weekly-scoring.json",
  "prior-season.json", "auth-probe.json", "page-meta.json", "page.html", "README.md",
];

/* ===================== small helpers ===================== */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = (s) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, "gi");
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/* Page-derived text only (token-context windows, trimmed scripts, viewer-hint contexts): the
 * signed-in page's chat/websocket config names the viewer next to its token. JSON name-shaped
 * fields become "SCRUBBED" (not REDACTED, which page.html reserves for token values so that
 * --verify can tie it to page-meta token.found); an all-digit id (a team id, a D-16 hint) is
 * kept. Never applied to fixture bodies, whose player names must survive. */
const PAGE_FIELD_RE = /"(name|short_name|long_name|first_?name|last_?name|full_?name|nick_?name|display_?name|screen_?name|long_abbr|short_abbr|abbr|id|login|email|user|user_?name|owner)"(\s*:\s*)"([^"]*)"/gi;
const PAGE_FIELD_OK = (k, v) => v === "REDACTED" || v === "SCRUBBED" || (k.toLowerCase() === "id" && /^\d*$/.test(v));
const pageFields = (t) => (typeof t === "string" ? t.replace(PAGE_FIELD_RE, (m, k, sep, v) => (PAGE_FIELD_OK(k, v) ? m : `"${k}"${sep}"SCRUBBED"`)) : t);
const pageFieldLeaks = (t) => { for (const m of String(t).matchAll(PAGE_FIELD_RE)) if (!PAGE_FIELD_OK(m[1], m[3])) return true; return false; };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const letters = (i) => { let s = ""; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
const byLenDesc = (a, b) => b[0].length - a[0].length;

/**
 * Map every string in a JSON value through fn. Object KEYS go through `fn.key` when the
 * scrubber provides one, because a key is a schema name and not free text: one real team's
 * short_name is the word "Draft", and rewriting keys turned `draft_type` into `Team B_type`
 * (observed 2026-09-10). Keys still get the token and slug rules; only the name tables stop
 * at the value boundary.
 */
function mapStrings(value, fn) {
  const keyFn = fn.key ?? fn;
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[keyFn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}

/* ===================== where names live (shape heuristics) ===================== */
/* The league-scoped CBS shapes are [ASSUMED] until this very spike records them, so the
 * collector reads context from key names rather than from a fixed schema. It errs toward
 * scrubbing too much: a mis-scrubbed player name costs a fixture some realism, a missed
 * team name costs a person their privacy. */

const PRO_TEAM_CTX = /pro_?teams?/i;
const PLAYER_CTX = /player/i;
const OWNER_CTX = /owner|commissioner|manager|user/i;
const TEAM_CTX = /team|^(home|away|visitor|opponent|winner|loser)$/i;
const PLAYER_KEYS = ["fullname", "firstname", "lastname", "position", "pro_team", "eligible_positions",
  "eligible_positions_display", "elias_id", "jersey", "bye_week", "pro_status"];
const TEAM_NAME_KEYS = /^(name|team_name|long_name|short_name|full_name)$/i;
const TEAM_ABBR_KEYS = /^(abbr|abbrev|abbreviation|short_abbr|long_abbr)$/i;
const LOOSE_TEAM_NAME_KEYS = /team_?name|^(home|away|visitor|opponent|winner|loser)_?(team_?)?name$/i;
const LOOSE_TEAM_KEYS = /^(team|home|away|visitor|opponent|winner|loser)$/i;
const OWNER_FIELD_IN_OWNER = /owner|email|user|login|first_?name|last_?name|nick_?name|^name$|full_?name|display_?name|screen_?name/i;
const OWNER_FIELD_IN_TEAM = /owner|email|user|login|first_?name|last_?name|nick_?name/i;
const OWNER_FIELD_ANYWHERE = /^(owner|owner_?name|commissioner|email|e_?mail|login|user_?name)$/i;
const SKIP_WORDS = /^(owner|owners|team|teams|league|redacted|user|none|null|true|false|n\/a|unknown|commissioner|yes|no)$/i;

function nearestCtx(keyPath) {
  for (let i = keyPath.length - 1; i >= 0; i--) {
    const k = keyPath[i];
    if (PRO_TEAM_CTX.test(k)) return "pro";
    if (OWNER_CTX.test(k)) return "owner";
    if (PLAYER_CTX.test(k)) return "player";
    if (TEAM_CTX.test(k)) return "team";
  }
  return null;
}

/**
 * Walk a body and call visit(kind, value) for every string (or string-array element) that
 * sits in a name-shaped field. kind is "team" | "abbr" | "owner". A non-undefined return
 * replaces the value in place — the same walk collects and later rewrites.
 */
function traverse(node, keyPath, visit) {
  if (Array.isArray(node)) { for (const n of node) traverse(n, keyPath, visit); return; }
  if (!node || typeof node !== "object") return;
  const ctx = nearestCtx(keyPath);
  const looksPlayer = PLAYER_KEYS.some((k) => k in node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    let kind = null;
    if (ctx === "team" && !looksPlayer && TEAM_NAME_KEYS.test(k)) kind = "team";
    else if (ctx === "team" && !looksPlayer && TEAM_ABBR_KEYS.test(k)) kind = "abbr";
    else if (LOOSE_TEAM_NAME_KEYS.test(k)) kind = "team";
    else if (LOOSE_TEAM_KEYS.test(k) && typeof v === "string" && ctx !== "player" && !looksPlayer && !/^[A-Z]{2,3}$/.test(v)) kind = "team";
    else if (ctx === "owner" ? OWNER_FIELD_IN_OWNER.test(k) : ctx === "team" ? OWNER_FIELD_IN_TEAM.test(k) : OWNER_FIELD_ANYWHERE.test(k)) kind = "owner";
    if (kind) {
      if (typeof v === "string") { const r = visit(kind, v); if (r !== undefined) node[k] = r; }
      else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === "string") { const r = visit(kind, x); if (r !== undefined) v[i] = r; } });
    }
    traverse(v, [...keyPath, k], visit);
  }
}

const bodiesOf = (bundle) => Object.entries(bundle.responses ?? {})
  .filter(([, r]) => r && typeof r === "object")
  .map(([key, r]) => [key, r.body]);

/* ===================== scrub rules ===================== */

/** Collect every secret in the bundle. Returns the replacement tables the scrubber and the check share. */
function collect(bundle) {
  const c = { slug: String(bundle.slug ?? "").trim(), tokens: new Set(), league: null, teams: new Map(), abbrs: new Map(), owners: new Map() };
  /* Names are collected first and lettered second. CBS's own placeholder for a team nobody has
   * named is `Team <letter>` — the very shape this vocabulary generates — so a value may not be
   * waved through for looking already-scrubbed, and a generated label may not land on a string a
   * real team already uses (observed 2026-09-10: two teams would otherwise read the same name). */
  const rawTeams = [], rawAbbrs = [];
  const addTeam = (v) => { const s = String(v).trim(); if (s && !/^\d+$/.test(s) && !rawTeams.includes(s)) rawTeams.push(s); };
  const addAbbr = (v) => { const s = String(v).trim(); if (s && !rawAbbrs.includes(s)) rawAbbrs.push(s); };
  const letterInto = (raws, map, fmt) => {
    const taken = new Set([...rawTeams, ...rawAbbrs].map((s) => s.toLowerCase()));
    let i = 0;
    for (const s of raws) { let label; do { label = fmt(letters(i++)); } while (taken.has(label.toLowerCase())); map.set(s, label); }
  };
  const addOwner = (v) => {
    const s = String(v).trim();
    if (!s || /^\d+$/.test(s) || c.owners.has(s) || c.teams.has(s) || SKIP_WORDS.test(s)) return;
    const n = c.owners.size + 1;
    c.owners.set(s, s.includes("@") ? `owner-${n}@example.invalid` : `Owner ${n}`);
  };
  // 1. tokens: every P1-P3 match in every string of the bundle, plus their URL-encoded forms
  const bad = /^(REDACTED|null|undefined|true|false|token|access_token)$/i;
  mapStrings(bundle, (s) => {
    for (const [, src] of TOKEN_PATTERNS) for (const m of s.matchAll(re(src))) {
      const t = m[1];
      if (t.length >= 12 && !bad.test(t)) {
        c.tokens.add(t);
        const enc = encodeURIComponent(t); if (enc !== t) c.tokens.add(enc);
        try { const dec = decodeURIComponent(t); if (dec !== t && dec.length >= 12) c.tokens.add(dec); } catch { /* not encoded */ }
      }
    }
    return s;
  });
  // league display name from league/details. Recorded 2026-09-10: the envelope's body is a
  // single `league_details` object, so that path comes first.
  const d = bundle.responses?.["league/details"]?.body;
  for (const cand of [d?.body?.league_details?.name, d?.body?.league?.name, d?.body?.name, d?.body?.league_name,
    d?.league_details?.name, d?.league?.name, d?.name, d?.league_name]) {
    if (typeof cand === "string" && cand.trim().length >= 3 && !/^\d+$/.test(cand)) { c.league = cand.trim(); break; }
  }
  // 3. team names (and abbreviations) first, so an owner field holding a team name is not mistaken for a person
  for (const [key, body] of bodiesOf(bundle)) {
    traverse(structuredClone(body), TEAM_ROUTES.has(key) ? ["teams"] : [], (kind, v) => { if (kind === "team") addTeam(v); else if (kind === "abbr") addAbbr(v); });
  }
  letterInto(rawTeams, c.teams, (l) => `Team ${l}`);
  letterInto(rawAbbrs, c.abbrs, (l) => `TM${l}`);
  // 4. owner strings
  for (const [key, body] of bodiesOf(bundle)) {
    traverse(structuredClone(body), TEAM_ROUTES.has(key) ? ["teams"] : [], (kind, v) => { if (kind === "owner") addOwner(v); });
  }
  return c;
}

/** Build the string scrubber from the tables. `skip` disables named rules (self-test only). */
function makeScrubber(c, skip = new Set()) {
  const tokens = [...c.tokens].sort((a, b) => b.length - a.length);
  const named = [];
  if (c.league && !skip.has("league")) named.push([c.league, "Redacted League"]);
  if (!skip.has("teams")) named.push(...[...c.teams].sort(byLenDesc));
  if (!skip.has("owners")) named.push(...[...c.owners].sort(byLenDesc));
  /* The slug is handled with the tokens below: it is the one name that may legitimately appear
   * in a key (and it is a DNS label, so it cannot collide with an English word). */
  let extraEmails = 0;
  /* Tokens and the slug: safe on a key as on a value, and a token in a key would still be a token. */
  const secrets = (s) => {
    let t = s;
    if (!skip.has("tokens")) {
      for (const tok of tokens) t = t.split(tok).join("REDACTED");
      for (const [, src] of TOKEN_PATTERNS) t = t.replace(re(src), (m, g1) => (g1 && g1 !== "REDACTED" ? m.replace(g1, "REDACTED") : m));
    }
    if (c.slug && !skip.has("slug") && c.slug.length >= 3) t = t.replace(bounded(c.slug), "redacted-league");
    return t;
  };
  const scrub = (s) => {
    if (typeof s !== "string" || !s) return s;
    let t = secrets(s);
    for (const [from, to] of named) if (from.length >= 3) t = t.replace(bounded(from), to);
    if (!skip.has("owners")) t = t.replace(EMAIL_RE, (m) => (m.endsWith("@example.invalid") ? m : `owner-x${++extraEmails}@example.invalid`));
    return t;
  };
  /* Keys are schema names, not free text: the name tables stop here (see mapStrings). */
  scrub.key = (s) => (typeof s === "string" && s ? secrets(s) : s);
  return scrub;
}

/** Rewrite name-shaped fields in place (covers names too short for the global pass), then every string. */
function deepScrub(value, c, scrub, key = null) {
  const clone = structuredClone(value);
  const inPlace = (kind, v) => {
    const s = v.trim();
    if (kind === "team") return c.teams.get(s);
    if (kind === "abbr") return c.abbrs.get(s);
    if (kind === "owner") return c.owners.get(s) ?? c.teams.get(s);
    return undefined;
  };
  if (clone && typeof clone === "object" && "body" in clone) traverse(clone.body, key && TEAM_ROUTES.has(key) ? ["teams"] : [], inPlace);
  else traverse(clone, [], inPlace);
  return mapStrings(clone, scrub);
}

/**
 * Split a written file into the text the name rules govern (its values) and its keys. A key is a
 * schema name the scrubber deliberately leaves alone, so a team called "Draft" must not make
 * `draft_type` read as a leak — but a key that IS a name, exactly, still must.
 */
function splitKeysAndValues(text, isJson) {
  if (!isJson) return { values: text, keys: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { values: text, keys: [] }; }
  const values = [], keys = [];
  (function walk(v) {
    if (typeof v === "string") values.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
  })(parsed);
  return { values: values.join("\n"), keys };
}

/** Re-read written files; return one line per surviving secret. Never prints a secret. */
function findLeaks(files, c) {
  const leaks = [];
  const named = [[c.league, "the league name"],
    ...[...c.teams.keys()].map((n, i) => [n, `team name ${i + 1}`]),
    ...[...c.owners.keys()].map((n, i) => [n, `owner string ${i + 1}`])];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.basename(f);
    const { values, keys } = splitKeysAndValues(text, rel.endsWith(".json"));
    for (const tok of c.tokens) {
      if (text.includes(tok)) { leaks.push(`${rel}: a token value survives`); continue; }
      if (tok.length >= 16) for (let i = 0; i + 12 <= tok.length; i++) if (text.includes(tok.slice(i, i + 12))) { leaks.push(`${rel}: a 12-character token fragment survives`); break; }
    }
    if (c.slug && c.slug.length >= 3 && bounded(c.slug).test(text)) leaks.push(`${rel}: the slug survives`);
    for (const [n, label] of named) {
      if (!n || n.length < 3) continue;
      if (bounded(n).test(values)) leaks.push(`${rel}: ${label} survives`);
      else if (keys.some((k) => k.toLowerCase() === n.toLowerCase())) leaks.push(`${rel}: ${label} survives as a key`);
    }
    for (const m of text.matchAll(EMAIL_RE)) if (!m[0].endsWith("@example.invalid")) { leaks.push(`${rel}: an e-mail address outside example.invalid survives`); break; }
    for (const [name, src] of TOKEN_PATTERNS) for (const m of text.matchAll(re(src))) if (m[1] && m[1] !== "REDACTED") { leaks.push(`${rel}: a ${name} token value survives`); break; }
    if (/^page(-meta)?\.(html|json)$/.test(path.basename(rel)) && pageFieldLeaks(text)) leaks.push(`${rel}: a name-shaped page field survives`);
  }
  return leaks;
}

/* ===================== end scrub rules ===================== */

/** page.html: only the <script> element(s) that matched a token pattern, plus the viewer-hint contexts. */
function buildPageHtml(bundle, scrubText) {
  const scrub = (t) => pageFields(scrubText(t));
  const html = String(bundle.pageHtml ?? "");
  const patterns = TOKEN_PATTERNS.map(([, src]) => src);
  const matched = (s) => patterns.some((p) => re(p).test(s));
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]).filter(matched);
  const blocks = [];
  if (scripts.length) {
    for (const s of scripts) blocks.push(scrub(trimScript(s, patterns)));
  } else {
    const windows = [];
    for (const p of patterns) for (const m of html.matchAll(re(p))) windows.push(html.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300));
    if (windows.length) blocks.push(`<section id="token-context">\n${windows.map((w) => `<pre>${esc(scrub(w))}</pre>`).join("\n")}\n</section>`);
    else blocks.push("<!-- no token match in page -->");
  }
  const hints = Array.isArray(bundle.viewerHints) ? bundle.viewerHints : [];
  blocks.push(hints.length
    ? `<section id="viewer-hints">\n${hints.map((h) => `<pre data-pattern="${esc(h.pattern)}">${esc(scrub(String(h.context ?? "")))}</pre>`).join("\n")}\n</section>`
    : "<!-- no viewer hints -->");
  return scrub(`<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>CBS league page, reduced to the token-bearing scripts and viewer hints, scrubbed</title></head>\n<body>\n${blocks.join("\n")}\n</body>\n</html>\n`);
}

function trimScript(s, patterns) {
  if (s.length <= 60000) return s;
  const open = /^<script\b[^>]*>/i.exec(s)?.[0] ?? "<script>";
  const windows = [];
  for (const p of patterns) for (const m of s.matchAll(re(p))) windows.push(s.slice(Math.max(0, m.index - 3000), m.index + m[0].length + 3000));
  return `${open}\n/* trimmed from ${s.length} chars: 3000 chars either side of each token match */\n${windows.join("\n/* … */\n")}\n</script>`;
}

const pickResponse = (r) => ({ url: r.url ?? null, status: r.status ?? null, ok: r.ok ?? null, body: r.body ?? null });
const pickProbe = (p) => (p && typeof p === "object"
  ? { url: p.url ?? null, status: p.status ?? null, ok: p.ok ?? null, envelopeStatusCode: p.envelopeStatusCode ?? null, ...(p.error ? { error: String(p.error) } : {}) }
  : null);

/**
 * Scrub a raw bundle into outDir. Returns { ok, leaks, files, summary }. On a leak the
 * written files are removed again so a leaking fixture never sits in the tree.
 */
export function scrubBundle(bundle, outDir, opts = {}) {
  if (!bundle || typeof bundle !== "object") throw new Error("bundle is not an object");
  if (!bundle.responses || typeof bundle.responses !== "object") throw new Error("bundle has no responses");
  if (!bundle.probes || typeof bundle.probes !== "object") throw new Error("bundle has no probes");
  if (typeof bundle.slug !== "string" || !bundle.slug) throw new Error("bundle has no slug");
  const skip = new Set(opts.skipRules ?? []);
  const c = collect(bundle);
  const scrub = makeScrubber(c, skip);

  const outputs = [];
  for (const [key, file] of Object.entries(ROUTE_FILES)) {
    const r = bundle.responses[key];
    if (!r || typeof r !== "object") continue;
    if (file === "transactions.json" && !r.ok) continue;
    outputs.push([file, deepScrub(pickResponse(r), c, scrub, key)]);
  }
  const prior = {};
  for (const key of PRIOR_SEASON_ROUTES) if (bundle.responses[key]) prior[key] = deepScrub(pickResponse(bundle.responses[key]), c, scrub, key);
  outputs.push(["prior-season.json", mapStrings(prior, scrub)]);
  outputs.push(["auth-probe.json", mapStrings({
    A: pickProbe(bundle.probes.A), B: pickProbe(bundle.probes.B), C: pickProbe(bundle.probes.C),
    cookieNames: Array.isArray(bundle.cookieNames) ? bundle.cookieNames.map(String) : [],
  }, scrub)]);
  const tok = bundle.token ?? {};
  outputs.push(["page-meta.json", mapStrings({
    capturedAt: bundle.capturedAt ?? null,
    href: bundle.href ?? null,
    token: { found: tok.found === true, pattern: tok.pattern ?? null, length: typeof tok.length === "number" ? tok.length : null },
    viewerHints: (Array.isArray(bundle.viewerHints) ? bundle.viewerHints : []).map((h) => ({ pattern: String(h?.pattern ?? ""), context: pageFields(scrub(String(h?.context ?? ""))) })),
  }, scrub)]);

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [file, value] of outputs) {
    const p = path.join(outDir, file);
    fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
    written.push(p);
  }
  const pagePath = path.join(outDir, "page.html");
  fs.writeFileSync(pagePath, buildPageHtml(bundle, scrub));
  written.push(pagePath);

  const leaks = findLeaks(written, c);
  if (leaks.length) for (const f of written) fs.rmSync(f, { force: true });
  return {
    ok: leaks.length === 0, leaks, files: written,
    summary: { teams: c.teams.size, owners: c.owners.size, tokens: c.tokens.size, tokenFound: tok.found === true, league: c.league != null },
  };
}

/* ===================== --verify ===================== */

function listDataFiles(dir) {
  const out = [];
  for (const sub of ["", "public"]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.(json|html)$/.test(f) && fs.statSync(path.join(d, f)).isFile()) out.push(path.join(d, f));
  }
  return out;
}

/** Structural re-check of a fixture directory, without the secrets. */
export function verifyDir(dir) {
  const problems = [];
  const at = (f) => path.join(dir, f);
  for (const f of REQUIRED_FILES) if (!fs.existsSync(at(f))) problems.push(`missing ${f}`);
  const files = listDataFiles(dir);
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    try { JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { problems.push(`${path.relative(dir, f)} does not parse: ${e.message}`); }
  }
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(at("page-meta.json"), "utf8")); } catch { /* reported above */ }
  const page = fs.existsSync(at("page.html")) ? fs.readFileSync(at("page.html"), "utf8") : "";
  if (meta) {
    const found = meta?.token?.found === true;
    const has = page.includes("REDACTED");
    if (found !== has) problems.push(`page.html ${has ? "contains" : "lacks"} REDACTED but page-meta.json token.found is ${found}`);
  }
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.relative(dir, f);
    if (/access_token=[^R&"]{8,}/.test(text)) problems.push(`${rel}: an access_token= value survives`);
    if (/var token\s*=\s*"(?!REDACTED)/.test(text)) problems.push(`${rel}: a var token value survives`);
    for (const m of text.matchAll(EMAIL_RE)) if (!m[0].endsWith("@example.invalid")) { problems.push(`${rel}: an e-mail address outside example.invalid survives`); break; }
  }
  const readme = fs.existsSync(at("README.md")) ? fs.readFileSync(at("README.md"), "utf8") : "";
  const m = /^(?:- )?auth_route:\s*(\S+)/m.exec(readme);
  const authRoute = m ? m[1] : null;
  if (!authRoute || authRoute === "<pending>") problems.push("README.md Findings auth_route is not set");
  else if (!["cookie", "page-token", "none"].includes(authRoute)) problems.push(`README.md auth_route '${authRoute}' is not cookie | page-token | none`);
  return { problems, authRoute };
}

/* ===================== --self-test ===================== */

function syntheticBundle(S, { withToken }) {
  const host = `https://${S.slug}.football.cbssports.com`;
  const Q = "version=3.0&SPORT=football&response_format=JSON";
  const proxy = (route) => `${host}/api/${route}${route.includes("?") ? "&" : "?"}${Q}`;
  const env = (route, body) => ({ statusMessage: "OK", statusCode: 200, uri: `/fantasy/${route}&league_id=${S.slug}`, body });
  const okRes = (route, body) => ({ url: proxy(route), status: 200, ok: true, body: env(route, body) });
  const badRes = (route) => ({ url: proxy(route), status: 400, ok: false, body: "User not signed in" });
  const teams = [
    { id: "1", name: S.teams[0], abbr: "GG", owners: [{ first_name: S.first, last_name: S.last, email: S.owner, login: "patowner77", user_id: 5551 }],
      players: [{ id: "2001", fullname: "Player One", position: "QB", eligible_positions: ["QB"], pro_team: "KC" }] },
    /* Observed 2026-09-10: a team CBS has not had named carries the short_name "Team B" — the
     * very shape the replacement vocabulary uses. It must still be replaced, and no generated
     * label may collide with it. */
    { id: "2", name: S.teams[1], abbr: "BWB", short_name: "Team B", owners: [{ nickname: S.nick }],
      players: [{ id: "2002", fullname: "Player Two", position: "RB", eligible_positions: ["RB", "RB-WR"], pro_team: "SF" }] },
    /* Observed 2026-09-10: one real team's short_name is the word "Draft", which the collector
     * rightly takes for a team name — and which then appears inside the key `draft_type`. */
    { id: "3", name: S.teams[2], abbr: "GNG", short_name: "Draft", owners: [], players: [] },
  ];
  const stats = (route) => okRes(route, { player_stats: { 2001: { name: "Player One", FP: "18.2", TM: "KC" }, 2002: { name: "Player Two", FP: "12.4", TM: "SF" } } });
  const responses = {
    /* Observed 2026-09-10: the details body is a single `league_details` object, and it carries
     * `draft_type` / `draft_label` keys beside the league's own display name. */
    "league/details": okRes("league/details", { league_details: { league_id: S.slug, name: S.league, current_period: 1, draft_type: "offline", commissioner: { name: `${S.first} ${S.last}`, email: S.owner } } }),
    "league/rules": okRes("league/rules", { roster: { positions: [{ abbr: "QB", max_active: 1, min_active: 1, max_total: "No Limit" }] } }),
    "league/scoring/rules": okRes("league/scoring/rules", { rules: [{ abbr: "PY", points: "0.04" }] }),
    "league/rosters?team_id=all": okRes("league/rosters?team_id=all", { teams }),
    "league/stats?stats_type=projections&period=week1&player_status=all": stats("league/stats?stats_type=projections&period=week1&player_status=all"),
    "league/stats?stats_type=projections&period=week2&player_status=all": stats("league/stats?stats_type=projections&period=week2&player_status=all"),
    "league/stats?stats_type=projections&period=week1&player_status=free_agents": stats("league/stats?stats_type=projections&period=week1&player_status=free_agents"),
    "league/schedules?period=all": okRes("league/schedules?period=all", { periods: [{ period: 1, matchups: [{ home_team: { id: "1", name: S.teams[0] }, away_team: { id: "2", name: S.teams[1] } }] }] }),
    "league/standings/overall": okRes("league/standings/overall", { teams: [
      { id: "1", name: S.teams[0], wins: 1, losses: 0, owner: `${S.first} ${S.last}` },
      { id: "2", name: S.teams[1], wins: 0, losses: 1, owner: S.nick },
      { id: "3", name: S.teams[2], wins: 0, losses: 0, owner: "" }] }),
    "league/fantasy-points/weekly-scoring": okRes("league/fantasy-points/weekly-scoring", { weeks: [] }),
    "league/fantasy-points/weekly-scoring?timeframe=2025": badRes("league/fantasy-points/weekly-scoring?timeframe=2025"),
    "league/stats?stats_type=projections&period=week1&timeframe=2025": badRes("league/stats?stats_type=projections&period=week1&timeframe=2025"),
    "league/stats?stats_type=stats&period=week1&timeframe=2025": badRes("league/stats?stats_type=stats&period=week1&timeframe=2025"),
    "league/transaction-list/add-drops": okRes("league/transaction-list/add-drops", { transactions: [{ team: S.teams[1], player: "Player Two", type: "add" }] }),
  };
  const tokenScript = withToken
    ? `<script>CBSi.token = "${S.token}"; var my_team_id = 2; var chat = { "team" : { "id" : "16", "name" : "${S.teams[0]}", "long_abbr" : "${S.chatAbbr}" }, "name" : "${S.chatName}", "token" : "${S.chat}", "auth" : { "id" : "${S.chatLogin}" } };</script><script>$(function(){ new PlayerSearch({ 'access_token': '${S.token}' }); });</script>`
    : "";
  const pageHtml = `<!DOCTYPE html><html><head><title>${S.league}</title>${tokenScript}</head><body><h1>${S.teams[0]}</h1>`
    + `<p>${S.first} ${S.last} &lt;${S.owner}&gt;</p><a href="/team/2">${S.teams[1]}</a>`
    + `<script>window.__data = {"owner":{"email":"${S.owner}"}, "teamId": 2};</script></body></html>`;
  const apiUrl = `https://api.cbssports.com/fantasy/league/details?${Q}&league_id=${S.slug}`;
  return {
    capturedAt: "2026-09-10T00:00:00.000Z",
    slug: S.slug,
    href: `${host}/`,
    cookieNames: ["CBS_SESSION", "pid"],
    token: withToken ? { found: true, pattern: "P1", length: S.token.length } : { found: false, pattern: null, length: null },
    viewerHints: [
      { pattern: "my_team_id", context: withToken ? `<script>CBSi.token = "${S.token}"; var my_team_id = 2;</script>` : `<script>var my_team_id = 2;</script>` },
      { pattern: "teamId", context: `{"owner":{"email":"${S.owner}"}, "teamId": 2};</script>` },
    ],
    probes: {
      A: { url: proxy("league/details"), status: 200, ok: true, envelopeStatusCode: 200 },
      B: withToken ? { url: apiUrl, status: 200, ok: true, envelopeStatusCode: 200 } : null,
      C: withToken ? { url: `${apiUrl}&access_token=${S.token}`, status: 200, ok: true, envelopeStatusCode: 200 } : null,
    },
    responses,
    pageHtml,
  };
}

async function selfTest(log) {
  let checks = 0, failures = 0;
  const ok = (c, what) => { checks++; if (!c) { failures++; log(`  FAIL ${what}`); } };
  const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const readText = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffsm-cbs-scrub-"));
  try {
    const S = {
      slug: "myleague77", token: "TOKENSECRETabc123XYZ", chat: "CHATTOKEN9876543210zyxw", chatName: "Pat O", chatAbbr: "PatO", chatLogin: "patownerlogin",
      teams: ["Gridiron Gang", "Bye Week Bandits", "Gang"],
      owner: "pat.owner@example.com", first: "Pat", last: "Ownerson", nick: "bandit_king",
      league: "Sunday Money League",
    };
    const secrets = [[S.slug, "the slug"], [S.token, "the token"], [S.teams[0], "team name 1"], [S.teams[1], "team name 2"], [S.teams[2], "team name 3"],
      [S.chat, "the chat token"], [S.chatName, "the chat display name"], [S.chatAbbr, "the chat long_abbr"], [S.chatLogin, "the chat auth id"], [S.owner, "the owner e-mail"], [S.first, "the owner first name"], [S.last, "the owner last name"], [S.nick, "the owner nickname"], [S.league, "the league name"]];

    /* the token-pattern table: the 2026 page shapes match, and capture.js carries the identical table */
    const find = (text) => { for (const [name, src] of TOKEN_PATTERNS) { const m = re(src).exec(text); if (m) return [name, m[1]]; } return null; };
    ok(find('<script> CBSi.token = "ABC.def-123"; </script>')?.[1] === "ABC.def-123", "a pattern captures CBSi.token = \"…\"");
    ok(find("new PlayerSearch({ 'access_token': 'ABC.def-123' })")?.[1] === "ABC.def-123", "a pattern captures a single-quoted 'access_token': '…'");
    ok(find('{"access_token": "ABC.def-123"}')?.[1] === "ABC.def-123", "a pattern captures a double-quoted \"access_token\": \"…\"");
    ok(find('"name" : "Pat O" }, "token" : "0123456789abcdef0123456789abcdef", "league_type"')?.[1] === "0123456789abcdef0123456789abcdef", "a pattern captures a JSON \"token\" : \"…\" field");
    ok(find('var token = "ABC.def-123"')?.[1] === "ABC.def-123", "the legacy var token = \"…\" form still matches");
    ok(find("params={payload:x,access_token:CBSi.token,method:\"PUT\"}") === null, "an unquoted access_token:CBSi.token reference is not mistaken for a value");
    const captureSrc = fs.readFileSync(path.join(path.dirname(SELF), "capture.js"), "utf8");
    const capturePatterns = [...captureSrc.matchAll(/^\s*\["(P\d)",\s*\/(.+)\/\],?\s*$/gm)].map((m) => [m[1], m[2]]);
    ok(capturePatterns.length === TOKEN_PATTERNS.length && capturePatterns.every(([n, src], i) => n === TOKEN_PATTERNS[i][0] && new RegExp(src).source === re(TOKEN_PATTERNS[i][1]).source), "capture.js PATTERNS is the same table as TOKEN_PATTERNS, in the same order");
    ok(captureSrc.includes("const LID = `league_id=${encodeURIComponent(out.slug)}`") && /const proxy = [^\n]*\$\{LID\}/.test(captureSrc) && /const direct = [^\n]*\$\{LID\}/.test(captureSrc), "capture.js sends league_id on every league-scoped request, proxy and direct alike (the proxy does not infer it from the hostname)");

    /* positive case, through the real CLI */
    const bundle = syntheticBundle(S, { withToken: true });
    const raw = path.join(tmp, "raw.json");
    fs.writeFileSync(raw, JSON.stringify(bundle));
    const out1 = path.join(tmp, "out1");
    const r = spawnSync(process.execPath, [SELF, raw, out1], { encoding: "utf8" });
    ok(r.status === 0, `CLI scrub exits 0 (got ${r.status})`);
    ok(/^SCRUB OK\s*$/m.test(r.stdout ?? ""), "CLI prints SCRUB OK");
    const files = fs.existsSync(out1) ? fs.readdirSync(out1).filter((f) => /\.(json|html)$/.test(f)) : [];
    for (const f of REQUIRED_FILES.filter((x) => x !== "README.md")) ok(files.includes(f), `${f} is written`);
    ok(files.includes("stats-week2.json") && files.includes("transactions.json"), "stats-week2.json and transactions.json are written when the route answered");
    for (const f of files) {
      const text = readText(out1, f);
      for (const [s, label] of secrets) ok(!bounded(s).test(text), `${f} does not contain ${label}`);
    }
    if (files.includes("page.html")) {
      const page = readText(out1, "page.html");
      ok(page.includes('CBSi.token = "REDACTED"'), "page.html has REDACTED exactly where CBSi.token was");
      ok(/'access_token':\s*'REDACTED'/.test(page), "page.html has REDACTED where the single-quoted access_token was");
      ok(/"token"\s*:\s*"REDACTED"/.test(page), "page.html has REDACTED where the chat token was");
      ok(/"id"\s*:\s*"16"/.test(page), "page.html keeps numeric ids in the token-context window (the viewer's team id is a D-16 hint)");
      ok(/"long_abbr"\s*:\s*"SCRUBBED"/.test(page) && /"auth"\s*:\s*\{\s*"id"\s*:\s*"SCRUBBED"/.test(page), "page.html scrubs name-shaped fields and non-numeric ids in the token-context window");
      ok(page.includes("my_team_id"), "page.html keeps the viewer-hint context");
      ok(!page.includes("window.__data"), "page.html carries only the token-bearing script, not the other one");
      ok(!page.includes("<h1>"), "page.html drops the rest of the page");
    }
    if (files.includes("page-meta.json")) {
      const meta = readJson(out1, "page-meta.json");
      ok(meta.token.found === true && meta.token.pattern === "P1" && meta.token.length === S.token.length, "page-meta.json records {found, pattern, length}");
      ok(Array.isArray(meta.viewerHints) && meta.viewerHints.length === 2, "page-meta.json carries the viewer hints");
      ok(meta.viewerHints.every((h) => !h.context.includes(S.token)) && meta.viewerHints[0].context.includes("REDACTED"), "viewer-hint contexts are scrubbed");
      ok(/redacted-league\.football\.cbssports\.com/.test(meta.href), "page-meta.json href carries redacted-league");
    }
    if (files.includes("auth-probe.json")) {
      const text = readText(out1, "auth-probe.json");
      const ap = JSON.parse(text);
      ok(typeof ap.A?.status === "number" && typeof ap.B?.status === "number" && typeof ap.C?.status === "number", "auth-probe.json has a status for A, B and C");
      ok(!/"body"/.test(text), "auth-probe.json carries no body");
      ok(/redacted-league\.football\.cbssports\.com/.test(ap.A.url), "auth-probe.json A.url names redacted-league");
      ok(/access_token=REDACTED/.test(ap.C.url), "auth-probe.json C.url reads access_token=REDACTED");
      ok(Array.isArray(ap.cookieNames) && ap.cookieNames.includes("pid"), "auth-probe.json keeps cookie names");
    }
    if (files.includes("rosters.json")) {
      const ro = readJson(out1, "rosters.json");
      const t = ro.body.body.teams;
      ok(t[0].name === "Team A" && t[1].name === "Team C" && t[2].name === "Team E", "rosters.json team names are lettered in first-seen order, skipping Team B (a real team already reads that)");
      ok(t[0].abbr === "TMA" && t[1].abbr === "TMB", "rosters.json team abbreviations are replaced too");
      ok(/^Team [A-Z]+$/.test(t[2].short_name), "a team short_name of 'Draft' is replaced where it is a value");
      ok(/^Team [A-Z]+$/.test(t[1].short_name) && t[1].short_name !== "Team B", "a team CBS left named 'Team B' is itself replaced, not mistaken for already-scrubbed output");
      const labels = [t[0].name, t[0].short_name, t[1].name, t[1].short_name, t[2].name, t[2].short_name];
      ok(new Set(labels).size === labels.length, "no two team strings collapse onto the same replacement label");
      ok(!labels.includes("Team B"), "the generated vocabulary skips a label a real team already uses");
      ok(/^Owner \d+$/.test(t[0].owners[0].first_name) && /^Owner \d+$/.test(t[0].owners[0].last_name), "rosters.json owner names read Owner N");
      ok(/^owner-\d+@example\.invalid$/.test(t[0].owners[0].email), "rosters.json owner e-mail reads owner-n@example.invalid");
      ok(/^Owner \d+$/.test(t[0].owners[0].login) && /^Owner \d+$/.test(t[1].owners[0].nickname), "rosters.json login and nickname read Owner N");
      ok(t[0].owners[0].user_id === 5551, "rosters.json numeric owner ids are untouched");
      ok(t[0].players[0].fullname === "Player One" && t[1].players[0].pro_team === "SF", "rosters.json player names and pro teams are untouched");
      ok(/redacted-league/.test(ro.url) && /redacted-league/.test(ro.body.uri), "rosters.json url and envelope uri carry redacted-league");
    }
    if (files.includes("standings.json") && files.includes("schedules.json") && files.includes("transactions.json") && files.includes("details.json")) {
      const st = readJson(out1, "standings.json").body.body.teams;
      ok(st[0].name === "Team A" && st[1].name === "Team C" && st[2].name === "Team E", "standings.json uses the same Team letters as rosters.json");
      ok(/^Owner \d+$/.test(st[0].owner) && /^Owner \d+$/.test(st[1].owner), "standings.json owner strings read Owner N");
      const sc = readJson(out1, "schedules.json").body.body.periods[0].matchups[0];
      ok(sc.home_team.name === "Team A" && sc.away_team.name === "Team C", "schedules.json home/away team names are replaced consistently");
      const tx = readJson(out1, "transactions.json").body.body.transactions[0];
      ok(tx.team === "Team C" && tx.player === "Player Two", "transactions.json team string is replaced, player name kept");
      const de = readJson(out1, "details.json").body.body.league_details;
      ok(de.league_id === "redacted-league" && de.name === "Redacted League", "details.json league id and display name are replaced, nested under league_details");
      ok(/^Owner \d+$/.test(de.commissioner.name) && /^owner-\d+@example\.invalid$/.test(de.commissioner.email), "details.json commissioner is owner-shaped");
      ok(de.current_period === 1, "details.json numbers are untouched");
      ok(Object.prototype.hasOwnProperty.call(de, "draft_type"), "details.json keeps the draft_type KEY: a team short_name of 'Draft' is replaced as a value, never inside a key");
      const ps = readJson(out1, "prior-season.json");
      ok(Object.keys(ps).length === 3 && Object.values(ps).every((x) => x.status === 400 && x.body === "User not signed in"), "prior-season.json carries the three attempts with their statuses");
      const sw = readJson(out1, "stats-week1.json").body.body.player_stats;
      ok(sw["2001"].name === "Player One" && sw["2001"].FP === "18.2", "stats-week1.json player rows are untouched");
    }

    /* --verify on the positive output */
    const readme = path.join(out1, "README.md");
    fs.writeFileSync(readme, "# stub\n\n## Findings\n\n- auth_route: cookie\n");
    let v = verifyDir(out1);
    ok(v.problems.length === 0 && v.authRoute === "cookie", `--verify passes a clean directory (${v.problems.join("; ") || "no problems"})`);
    const lines = [];
    ok((await main(["--verify", out1], { log: (s) => lines.push(s) })) === 0 && lines.some((l) => /^FIXTURES OK/.test(l)), "--verify prints FIXTURES OK and exits 0");
    fs.writeFileSync(readme, "# stub\n\n## Findings\n\n- auth_route: none\n");
    lines.length = 0;
    ok((await main(["--verify", out1], { log: (s) => lines.push(s) })) === 2 && lines.some((l) => /STOP AND REPORT/.test(l)), "--verify exits 2 with STOP AND REPORT on auth_route: none");
    fs.writeFileSync(readme, "# stub\n\n## Findings\n\n- auth_route: <pending>\n");
    lines.length = 0;
    ok((await main(["--verify", out1], { log: (s) => lines.push(s) })) === 1, "--verify exits 1 while auth_route is <pending>");
    fs.writeFileSync(readme, "# stub\n\n## Findings\n\n- auth_route: cookie\n");
    const meta1 = path.join(out1, "page-meta.json");
    if (fs.existsSync(meta1)) {
      const saved = fs.readFileSync(meta1, "utf8");
      fs.writeFileSync(meta1, saved.replace('"found": true', '"found": false'));
      v = verifyDir(out1);
      ok(v.problems.some((p) => /REDACTED/.test(p)), "--verify catches page.html REDACTED disagreeing with page-meta.json token.found");
      fs.writeFileSync(meta1, saved);
    }

    /* a page with no token match */
    const out2 = path.join(tmp, "out2");
    const res2 = scrubBundle(syntheticBundle(S, { withToken: false }), out2);
    ok(res2.ok, `a bundle without a token still scrubs (${res2.leaks.join("; ") || "no leaks"})`);
    if (res2.ok) {
      const page2 = readText(out2, "page.html");
      ok(page2.includes("<!-- no token match in page -->"), "page.html carries the no-token marker");
      ok(!page2.includes("REDACTED"), "page.html has no REDACTED when nothing matched");
      const meta2 = readJson(out2, "page-meta.json");
      ok(meta2.token.found === false && meta2.token.pattern === null, "page-meta.json records token.found: false");
      const ap2 = readJson(out2, "auth-probe.json");
      ok(ap2.B === null && ap2.C === null && ap2.A.status === 200, "auth-probe.json records B and C as null when no token was found");
      fs.writeFileSync(path.join(out2, "README.md"), "# stub\n\n- auth_route: cookie\n");
      ok(verifyDir(out2).problems.length === 0, "--verify passes the no-token directory");
    }

    /* negative case: a deliberately broken replacement table must fail loudly */
    const out3 = path.join(tmp, "out3");
    const broken = scrubBundle(bundle, out3, { skipRules: ["slug"] });
    ok(broken.ok === false && broken.leaks.some((l) => /the slug survives/.test(l)), "a broken slug rule is caught by the write-time check");
    ok(!fs.existsSync(path.join(out3, "details.json")), "a leaking run removes what it wrote");
    lines.length = 0;
    const code = await main([raw, path.join(tmp, "out4")], { skipRules: ["tokens"], log: (s) => lines.push(s) });
    ok(code === 1 && lines.some((l) => /^SCRUB FAILED/.test(l)), "the CLI prints SCRUB FAILED and exits 1 when a token survives");
    ok(lines.some((l) => /LEAK .*token/.test(l)) && !lines.some((l) => l.includes(S.token)), "the leak report names the kind of secret, never the secret");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log(`\n${checks} assertions, ${failures} failures`);
  if (failures) { log("SCRUB FAILED"); return 1; }
  log("SCRUB OK");
  return 0;
}

/* ===================== entry ===================== */

const USAGE = "usage: node scrub.mjs <raw.json> <outDir> | --self-test | --verify <dir>";

export async function main(argv, opts = {}) {
  const log = opts.log ?? console.log;
  if (argv[0] === "--self-test") return selfTest(log);
  if (argv[0] === "--verify") {
    if (!argv[1]) { log(USAGE); return 1; }
    const { problems, authRoute } = verifyDir(path.resolve(argv[1]));
    if (problems.length) { for (const p of problems) log(`  PROBLEM ${p}`); log("FIXTURES FAILED"); return 1; }
    if (authRoute === "none") { log("STOP AND REPORT: README.md records auth_route: none — no route authenticates without a password; the phase stops at 11-01 (D-11)"); return 2; }
    log(`FIXTURES OK (auth_route: ${authRoute})`);
    return 0;
  }
  const [rawPath, outDir] = argv;
  if (!rawPath || !outDir) { log(USAGE); return 1; }
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(rawPath, "utf8")); } catch (e) { log(`SCRUB FAILED: cannot read ${rawPath}: ${e.message}`); return 1; }
  let result;
  try { result = scrubBundle(bundle, path.resolve(outDir), opts); } catch (e) { log(`SCRUB FAILED: ${e.message}`); return 1; }
  for (const f of result.files) log(`  wrote ${path.relative(process.cwd(), f)}`);
  const s = result.summary;
  log(`  ${s.teams} team names, ${s.owners} owner strings, ${s.tokens} token values replaced; league name ${s.league ? "replaced" : "not found"}; token in page: ${s.tokenFound ? "yes" : "no"}`);
  if (!result.ok) { for (const l of result.leaks) log(`  LEAK ${l}`); log("SCRUB FAILED (written files removed)"); return 1; }
  log("SCRUB OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.log(`SCRUB FAILED: ${e?.stack ?? e}`); process.exit(1); });
}
