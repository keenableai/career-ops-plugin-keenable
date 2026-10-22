// Offline unit tests: a stub ctx stands in for the engine, so no request leaves
// the machine. The stub behaves like the engine's ctx.fetch: it throws an
// Error carrying .status on a non-2xx answer.
//
// Fixtures follow the real response shape: `description` is empty and the page
// text is in `snippet`.
import assert from 'node:assert';
import plugin, { buildQuery, extractLocation, splitTitle, toJob, DEFAULT_SITES } from '../index.mjs';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

function stubCtx({ results = [], env = {}, settings = {}, answers = null } = {}) {
  const calls = [];
  const queue = answers ? [...answers] : null;
  return {
    calls,
    env,
    settings,
    normalizePostingUrl: (u) => String(u).toLowerCase().replace(/\/+$/, ''),
    fetch: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      const answer = queue ? queue.shift() : { status: 200, json: { results } };
      if (answer.status >= 300) {
        const err = new Error(`HTTP ${answer.status}: ${JSON.stringify(answer.json || {})}`);
        // @ts-ignore
        err.status = answer.status;
        throw err;
      }
      return { ok: true, status: answer.status, json: async () => answer.json, text: async () => JSON.stringify(answer.json) };
    },
  };
}

const R = {
  greenhouse: {
    url: 'http://job-boards.greenhouse.io/reddit/jobs/7074776?gh_src=aijobsdesk',
    title: 'Senior Machine Learning Engineer, ML Training Platform',
    description: '',
    snippet: '# Senior Machine Learning Engineer, ML Training Platform\nRemote - United States\n**Who We Are:**\nThe Machine Learning Platform team at Reddit is a high-impact team.',
  },
  greenhouseApp: {
    url: 'https://boards.greenhouse.io/oscar/jobs/8222478',
    title: 'Job Application for Nurse Practitioner',
    description: '',
    snippet: "# Nurse Practitioner - Virtual Health Assessment\nRemote\nHi, we're Oscar Medical Group.",
  },
  ashby: {
    url: 'https://jobs.ashbyhq.com/yobi/c5e3ca22-fb3e-4bea-9515-feed1c7a8768/application',
    title: 'Machine Learning Engineer - Applied / Product @ Yobi',
    description: '',
    snippet: 'Machine Learning Engineer - Applied / Product Location Remote (US + Canada Only) Employment Type Full time Location Type Remote',
    published_at: '2026-10-01T00:00:00Z',
  },
  lever: {
    url: 'https://jobs.lever.co/smart-working-solutions/1ffa3574-26f8-4bc0-99d5-f14fb725e506',
    title: 'Smart Working Solutions - Machine Learning Engineer (Remote, Full-Time) [AS207]',
    description: '',
    snippet: '## Machine Learning Engineer (Remote, Full-Time) [AS207]\nIndia\nAhmedabad',
  },
  careersSuffix: {
    url: 'https://boards.greenhouse.io/airbnb/jobs/8224032',
    title: 'Senior Staff Data Engineer, Foundational Data - Careers at Airbnb',
    description: '',
    snippet: 'Airbnb was born in 2007.',
  },
  leverIndex: { url: 'https://jobs.lever.co/smart-working-solutions', title: 'Smart Working Solutions', description: '', snippet: 'Jobs' },
  offSite: { url: 'https://www.linkedin.com/jobs/view/123', title: 'ML Engineer', description: '', snippet: '' },
};

console.log('career-ops-plugin-keenable unit tests\n');

await check('keyless: /v1/search/public, X-Keenable-Title, no key header, ATS site group added', async () => {
  const ctx = stubCtx({ results: [R.greenhouse] });
  const jobs = await plugin.search('remote machine learning engineer', ctx);
  assert.strictEqual(ctx.calls.length, 1);
  const { url, opts, body } = ctx.calls[0];
  assert.strictEqual(url, 'https://api.keenable.ai/v1/search/public');
  assert.strictEqual(opts.method, 'POST');
  assert.strictEqual(opts.headers['X-Keenable-Title'], 'career-ops');
  assert.strictEqual(opts.headers['X-API-Key'], undefined);
  assert.strictEqual(body.max_results, 20);
  assert.ok(body.query.startsWith('remote machine learning engineer ('), body.query);
  for (const s of DEFAULT_SITES) assert.ok(body.query.includes(`site:${s}`), `missing site:${s}`);
  assert.deepStrictEqual(Object.keys(body).sort(), ['max_results', 'query']);
  assert.strictEqual(jobs.length, 1);
});

await check('keyed: /v1/search with X-API-Key', async () => {
  const ctx = stubCtx({ results: [], env: { KEENABLE_API_KEY: 'test-key-123' } });
  await plugin.search('data scientist', ctx);
  assert.strictEqual(ctx.calls[0].url, 'https://api.keenable.ai/v1/search');
  assert.strictEqual(ctx.calls[0].opts.headers['X-API-Key'], 'test-key-123');
});

await check('maps snippet to location + description; cleans ATS URLs; drops index pages, off-site hits and duplicates', async () => {
  const dup = { ...R.greenhouse, url: 'https://job-boards.greenhouse.io/reddit/jobs/7074776' };
  const ctx = stubCtx({ results: [R.greenhouse, dup, R.ashby, R.lever, R.leverIndex, R.offSite] });
  const jobs = await plugin.search('machine learning engineer', ctx);
  assert.deepStrictEqual(jobs.map((j) => j.url), [
    'https://job-boards.greenhouse.io/reddit/jobs/7074776',
    'https://jobs.ashbyhq.com/yobi/c5e3ca22-fb3e-4bea-9515-feed1c7a8768',
    'https://jobs.lever.co/smart-working-solutions/1ffa3574-26f8-4bc0-99d5-f14fb725e506',
  ]);
  const [gh, ashby, lever] = jobs;
  assert.deepStrictEqual([gh.title, gh.company, gh.location],
    ['Senior Machine Learning Engineer, ML Training Platform', 'reddit', 'Remote - United States']);
  assert.ok(gh.description.startsWith('# Senior Machine Learning Engineer'));
  assert.deepStrictEqual([ashby.title, ashby.company, ashby.location],
    ['Machine Learning Engineer - Applied / Product', 'Yobi', 'Remote (US + Canada Only)']);
  assert.strictEqual(ashby.postedAt, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepStrictEqual([lever.title, lever.company, lever.location],
    ['Machine Learning Engineer (Remote, Full-Time) [AS207]', 'Smart Working Solutions', 'India']);
});

await check('title shapes: "Job Application for", "- Careers at X"', async () => {
  assert.deepStrictEqual(splitTitle(R.greenhouseApp.title, new URL(R.greenhouseApp.url)), { title: 'Nurse Practitioner', company: '' });
  assert.deepStrictEqual(splitTitle(R.careersSuffix.title, new URL(R.careersSuffix.url)),
    { title: 'Senior Staff Data Engineer, Foundational Data', company: 'Airbnb' });
  assert.deepStrictEqual(splitTitle('Stripe Careers | Full Stack Engineer, Builder Experience', new URL('https://stripe.com/jobs/search?gh_jid=8206731')),
    { title: 'Full Stack Engineer, Builder Experience', company: 'Stripe' });
  const job = toJob(R.greenhouseApp, { sites: [...DEFAULT_SITES] });
  assert.deepStrictEqual([job.title, job.company, job.location], ['Nurse Practitioner', 'oscar', 'Remote']);
});

await check('location stays empty unless the page states it where expected', () => {
  assert.strictEqual(extractLocation('# About Acme\nWe build things', 'Data Engineer'), '');
  assert.strictEqual(extractLocation('# Staff Data Scientist\n- Full-time\n## Job Description', 'Staff Data Scientist'), '');
  assert.strictEqual(extractLocation('# Remote Nurse Practitioner - TX License Required\n\n**The Role**\nWe are hiring', 'Remote Nurse Practitioner'), '');
  assert.strictEqual(extractLocation('', 'x'), '');
});

await check('a query with its own site: is sent as written and filters to those sites', async () => {
  const q = 'site:jobs.lever.co "Nurse Practitioner" remote -site:jobs.ashbyhq.com';
  assert.deepStrictEqual(buildQuery(q, [...DEFAULT_SITES]), { query: q, sites: ['jobs.lever.co'] });
  const ctx = stubCtx({ results: [R.greenhouse, R.lever] });
  const jobs = await plugin.search(q, ctx);
  assert.strictEqual(ctx.calls[0].body.query, q);
  assert.deepStrictEqual(jobs.map((j) => j.company), ['Smart Working Solutions']);
});

await check('settings: max_results clamped to 1-50, sites override, days_back sets published_after', async () => {
  const ctx = stubCtx({ settings: { max_results: 99, sites: ['careers.example.com/jobs'], days_back: 14 } });
  await plugin.search('platform engineer', ctx);
  const { body } = ctx.calls[0];
  assert.strictEqual(body.max_results, 50);
  assert.strictEqual(body.query, 'platform engineer (site:careers.example.com/jobs)');
  assert.match(body.published_after, /^\d{4}-\d{2}-\d{2}$/);
  const ctx0 = stubCtx({ settings: { max_results: 0 } });
  await plugin.search('x', ctx0);
  assert.strictEqual(ctx0.calls[0].body.max_results, 1);
});

await check('provider: scan_query from the entry; a tracked company keeps its own name, a board does not', async () => {
  const ctx = stubCtx({ results: [R.greenhouse] });
  const company = await plugin.provider.fetch({ name: 'Reddit', scan_query: 'machine learning engineer', _isBoard: false }, ctx);
  assert.strictEqual(company[0].company, 'Reddit');
  const board = await plugin.provider.fetch({ name: 'Remote ML (Keenable)', scan_query: 'machine learning engineer', _isBoard: true, max_results: 5 }, ctx);
  assert.strictEqual(board[0].company, 'reddit');
  assert.strictEqual(ctx.calls[1].body.max_results, 5);
  await assert.rejects(() => plugin.provider.fetch({ name: 'No query' }, ctx), /needs a scan_query/);
});

await check('search needs a string query', async () => {
  await assert.rejects(() => plugin.search(stubCtx(), stubCtx()), /needs a query string/);
  await assert.rejects(() => plugin.search('   ', stubCtx()), /needs a query string/);
});

await check('429 with a short retryAfter is retried once', async () => {
  const ctx = stubCtx({ answers: [
    { status: 429, json: { error: 'Rate limit exceeded', retryAfter: 1 } },
    { status: 200, json: { results: [R.lever] } },
  ] });
  const jobs = await plugin.search('nurse practitioner', ctx);
  assert.strictEqual(ctx.calls.length, 2);
  assert.strictEqual(jobs.length, 1);
});

await check('hourly 429 fails with a readable message that names the optional key', async () => {
  const ctx = stubCtx({ answers: [{ status: 429, json: { error: 'Rate limit exceeded', retryAfter: 1800 } }] });
  await assert.rejects(() => plugin.search('nurse practitioner', ctx), /keyless rate limit.*about 30 min.*KEENABLE_API_KEY/);
  assert.strictEqual(ctx.calls.length, 1);
});

await check('a rejected key says so', async () => {
  const ctx = stubCtx({ env: { KEENABLE_API_KEY: 'bad-key-123' }, answers: [{ status: 401, json: { error: 'Unauthorized' } }] });
  await assert.rejects(() => plugin.search('nurse', ctx), /KEENABLE_API_KEY was rejected \(HTTP 401\)/);
});

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
