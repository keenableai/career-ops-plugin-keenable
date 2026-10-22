// @ts-check
// career-ops-plugin-keenable: job postings from Keenable web search.
// Guide: https://github.com/career-ops-hq/career-ops/blob/main/docs/PLUGINS.md
//
// Two hooks over one search call:
//  - search(query, ctx): `node plugins.mjs run keenable search "<query>"`
//  - provider: a portals.yml entry with `provider: keenable` and a `scan_query`,
//    run by `node scan.mjs` like any other board.
//
// Keyless by default: POST /v1/search/public with an X-Keenable-Title header.
// With KEENABLE_API_KEY in .env the same request goes to /v1/search with
// X-API-Key; the key only lifts the keyless rate limit (10 requests/s and
// 1,000/hour per IP). A request carries the query text and nothing else: no CV,
// no tracker rows, no pipeline.
//
// All network access goes through ctx.fetch, so the engine enforces the
// manifest's allowedHosts (api.keenable.ai).

const BASE = 'https://api.keenable.ai/v1';
const APP_TITLE = 'career-ops';
const DEFAULT_MAX = 20;
const DESCRIPTION_CAP = 1500;
const KEYLESS_SPACING_MS = 150;
const MAX_RETRY_WAIT_S = 5;

const seg = (u, i) => u.pathname.split('/').filter(Boolean)[i] || '';
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Employer ATS hosts searched when the query names no site: of its own. Each
// entry knows what one posting's path looks like, so a board's index page
// (jobs.lever.co/acme) never comes back as a job.
const ATS = [
  { host: 'job-boards.greenhouse.io', posting: /^\/[^/]+\/jobs\/\d+/, company: (u) => seg(u, 0) },
  { host: 'boards.greenhouse.io', posting: /^\/[^/]+\/jobs\/\d+/, company: (u) => seg(u, 0) },
  { host: 'jobs.lever.co', posting: /^\/[^/]+\/[0-9a-f-]{36}(\/|$)/i, company: (u) => seg(u, 0) },
  { host: 'jobs.ashbyhq.com', posting: /^\/[^/]+\/[0-9a-f-]{36}(\/|$)/i, company: (u) => seg(u, 0) },
  { host: 'apply.workable.com', posting: /^\/[^/]+\/j\/[0-9a-z]+/i, company: (u) => seg(u, 0) },
  { host: 'jobs.smartrecruiters.com', posting: /^\/[^/]+\/\d{6,}/, company: (u) => seg(u, 0) },
  { host: 'myworkdayjobs.com', posting: /\/job\//, company: (u) => u.hostname.split('.')[0] },
];

export const DEFAULT_SITES = Object.freeze(ATS.map((a) => a.host));

const hostIs = (hostname, host) => hostname === host || hostname.endsWith(`.${host}`);
const atsFor = (u) => ATS.find((a) => hostIs(u.hostname.toLowerCase(), a.host)) || null;

function clampInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(1, Math.round(n)));
}

const SITE_RE = /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s()"]*)?$/i;

function settingsOf(ctx) {
  const s = (ctx && ctx.settings) || {};
  const sites = Array.isArray(s.sites)
    ? s.sites.map((x) => String(x).trim().toLowerCase()).filter((x) => SITE_RE.test(x))
    : [];
  const days = Number(s.days_back);
  return {
    maxResults: clampInt(s.max_results, DEFAULT_MAX),
    sites: sites.length ? sites : [...DEFAULT_SITES],
    daysBack: Number.isFinite(days) && days > 0 ? Math.round(days) : null,
  };
}

/** site: operators the user wrote, minus exclusions (-site:). */
function sitesInQuery(query) {
  const out = [];
  for (const m of query.matchAll(/(^|[\s(])site:([^\s()"]+)/gi)) out.push(m[2].toLowerCase());
  return out;
}

/**
 * The query sent to Keenable plus the sites a result must belong to. A query
 * that already says site: is sent as written (portals.yml search_queries are
 * written that way); otherwise the configured sites are added as one group.
 */
export function buildQuery(query, sites) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  if (!q) throw new Error('keenable: the search query is empty');
  const own = sitesInQuery(q);
  if (own.length) return { query: q, sites: own };
  return { query: `${q} (${sites.map((s) => `site:${s}`).join(' OR ')})`, sites };
}

function siteMatches(u, site) {
  const [host, ...rest] = site.split('/');
  const path = rest.length ? `/${rest.join('/')}` : '';
  if (!hostIs(u.hostname.toLowerCase(), host)) return false;
  return !path || path === '/' || u.pathname.toLowerCase().startsWith(path.toLowerCase());
}

/** https, no tracking query or fragment, no trailing apply step. */
function cleanAtsUrl(u) {
  const out = new URL(u.href);
  out.protocol = 'https:';
  out.search = '';
  out.hash = '';
  out.pathname = out.pathname.replace(/\/(application|apply)\/?$/i, '').replace(/\/+$/, '');
  return out.href;
}

/** Title and employer from the page title shapes the ATSes use. */
export function splitTitle(raw, u) {
  let title = String(raw || '').replace(/\s+/g, ' ').trim();
  let company = '';
  let m;
  if ((m = /^Job Application for (.+) at (.+)$/i.exec(title))) [, title, company] = m;
  else if ((m = /^Job Application for (.+)$/i.exec(title))) [, title] = m;
  else if ((m = /^(.+\S)\s+@\s+([^@]+)$/.exec(title))) [, title, company] = m;
  else if ((m = /^(.+?)\s+[-|–]\s+Careers at (.+)$/i.exec(title))) [, title, company] = m;
  else if ((m = /^(.+?)\s+\|\s+(.+?) Careers\b.*$/i.exec(title))) [, title, company] = m;
  else if ((m = /^(.+?)\s+Careers\s+\|\s+(.+)$/i.exec(title))) [, company, title] = m;
  else if (u && hostIs(u.hostname.toLowerCase(), 'jobs.lever.co') && (m = /^(.+?)\s+-\s+(.+)$/.exec(title))
    && squash(m[1]) === squash(seg(u, 0))) [, company, title] = m;
  return { title: title.trim(), company: company.trim() };
}

function looksLikePlace(s) {
  return s.length >= 2 && s.length <= 60 && s.split(/\s+/).length <= 8
    && !/[.:!?]$/.test(s) && !/^[#>*\-[<]/.test(s) && !/https?:|www\./i.test(s);
}

/**
 * The location line when the page states one in a recognisable spot: right
 * under the "# Title" heading (Greenhouse, Lever), or between "Location" and
 * "Employment Type" (Ashby). Anything else stays empty, which career-ops'
 * location_filter passes rather than guesses at.
 */
export function extractLocation(text, title) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && /^#{1,3}\s/.test(lines[0])) {
    const heading = squash(lines[0].replace(/^#+/, ''));
    const want = squash(title).slice(0, 24);
    // A bold line there is a section label ("**The Role**"), not a place.
    const next = lines[1].startsWith('**') ? '' : lines[1];
    if (want && heading.includes(want) && looksLikePlace(next)) return next;
  }
  const m = /\bLocation\s+(.{2,60}?)\s+(?:Employment Type|Location Type)\b/.exec(String(text || ''));
  if (m && looksLikePlace(m[1].trim())) return m[1].trim();
  return '';
}

const plain = (text) => String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CAP);

/** One Keenable result as a career-ops Job, or null when it is not a posting. */
export function toJob(r, { sites, entryCompany = '' }) {
  let u;
  try { u = new URL(String((r && r.url) || '')); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!sites.some((s) => siteMatches(u, s))) return null;
  const ats = atsFor(u);
  if (ats && !ats.posting.test(u.pathname)) return null;
  // Keenable puts the page text in `snippet`; `description` comes back empty.
  const text = String(r.snippet || r.description || '');
  const { title, company } = splitTitle(r.title, u);
  if (!title) return null;
  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
  const job = {
    title,
    url: ats ? cleanAtsUrl(u) : u.href,
    company: entryCompany || company || (ats ? ats.company(u) : ''),
    location: extractLocation(text, title),
  };
  const description = plain(text);
  if (description) job.description = description;
  const posted = Date.parse(r.published_at || '');
  if (Number.isFinite(posted)) job.postedAt = posted;
  return job;
}

// Keyless calls are spaced so a scan with several keenable entries stays
// under the 10 requests/s limit; scan.mjs runs up to 10 boards at once.
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + KEYLESS_SPACING_MS;
  if (at > now) await sleep(at - now);
}

function retryAfterSeconds(message) {
  const m = /"retryAfter"\s*:\s*(\d+)/.exec(String(message || ''));
  return m ? Number(m[1]) : 1;
}

async function keenableSearch(ctx, body) {
  const key = String((ctx.env && ctx.env.KEENABLE_API_KEY) || '').trim();
  const url = key ? `${BASE}/search` : `${BASE}/search/public`;
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', 'X-Keenable-Title': APP_TITLE };
  if (key) headers['X-API-Key'] = key;
  for (let attempt = 0; ; attempt++) {
    if (!key) await pace();
    try {
      const res = await ctx.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res && res.ok === false) {
        const err = new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        // @ts-ignore
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return Array.isArray(data && data.results) ? data.results : [];
    } catch (err) {
      const status = err && err.status;
      if (status === 429) {
        const wait = retryAfterSeconds(err.message);
        if (attempt === 0 && wait <= MAX_RETRY_WAIT_S) { await sleep(Math.max(1, wait) * 1000); continue; }
        throw new Error(key
          ? 'keenable: rate limited (HTTP 429), try again shortly'
          : `keenable: keyless rate limit reached (10 requests/s, 1,000/hour per IP)${wait > MAX_RETRY_WAIT_S ? `, retry in about ${Math.ceil(wait / 60)} min` : ''}. A KEENABLE_API_KEY in .env lifts it.`);
      }
      if (key && (status === 401 || status === 403)) {
        throw new Error(`keenable: KEENABLE_API_KEY was rejected (HTTP ${status}). Fix it, or remove it from .env to search keyless.`);
      }
      throw err;
    }
  }
}

async function runQuery(ctx, rawQuery, { maxResults, sites, daysBack, entryCompany = '' }) {
  const built = buildQuery(rawQuery, sites);
  /** @type {Record<string, unknown>} */
  const body = { query: built.query, max_results: maxResults };
  if (daysBack) body.published_after = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
  const results = await keenableSearch(ctx, body);
  const seen = new Set();
  const jobs = [];
  for (const r of results) {
    const job = toJob(r, { sites: built.sites, entryCompany });
    if (!job) continue;
    const k = (typeof ctx.normalizePostingUrl === 'function' && ctx.normalizePostingUrl(job.url)) || job.url;
    if (seen.has(k)) continue;
    seen.add(k);
    jobs.push(job);
  }
  return jobs;
}

/** search hook: `node plugins.mjs run keenable search "<query>"`. */
async function search(query, ctx) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('keenable: search needs a query string');
  return runQuery(ctx, query, settingsOf(ctx));
}

/** provider hook: a portals.yml entry with `provider: keenable` and a `scan_query`. */
async function fetchEntry(entry, ctx) {
  const query = entry && (entry.scan_query || entry.query || entry.search_query);
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error(`keenable: entry "${(entry && entry.name) || '?'}" needs a scan_query`);
  }
  const s = settingsOf(ctx);
  const days = Number(entry.days_back);
  return runQuery(ctx, query, {
    maxResults: entry.max_results !== undefined ? clampInt(entry.max_results, s.maxResults) : s.maxResults,
    sites: s.sites,
    daysBack: Number.isFinite(days) && days > 0 ? Math.round(days) : s.daysBack,
    // A tracked company's own label beats the slug in its ATS URL; a board
    // entry's name is the board, not the employer.
    entryCompany: entry._isBoard === false && typeof entry.name === 'string' ? entry.name.trim() : '',
  });
}

export default {
  search,
  provider: { id: 'keenable', fetch: fetchEntry },
};
