# career-ops-plugin-keenable

A community plugin for [career-ops](https://github.com/career-ops-hq/career-ops)
that finds job postings with [Keenable](https://keenable.ai) web search. It works
with no API key and no account.

Maintained by Keenable, which runs the search API this plugin calls.

## What it does

- **`search` hook**: `node plugins.mjs run keenable search "<query>"` returns
  postings for a query and, without `--dry-run`, appends the new ones to
  `data/pipeline.md`.
- **`provider` hook**: a `portals.yml` entry with `provider: keenable` and a
  `scan_query` runs during `node scan.mjs`, so the queries an agent would
  otherwise run by hand (the `search_queries` / `scan_method: websearch` kind)
  run with the zero-token scanner.

Results are limited to employer ATS hosts unless you say otherwise
(`job-boards.greenhouse.io`, `boards.greenhouse.io`, `jobs.lever.co`,
`jobs.ashbyhq.com`, `apply.workable.com`, `jobs.smartrecruiters.com`,
`myworkdayjobs.com`), and only single postings are kept: a board's index page,
a hit on another site or a duplicate is dropped. Every result links to the
employer's own posting. The manifest sets `jobPostings: true`, so career-ops
applies `data/blacklist.md`, `title_filter` and `location_filter` and records
what it adds in `data/scan-history.tsv`.

## What leaves your machine

One HTTPS request per query to `api.keenable.ai` (the only host in
`allowedHosts`), carrying the query text, the result count, an
`X-Keenable-Title: career-ops` header and, if you set one, your key. Nothing
from your CV, tracker or pipeline is sent.

## Install

```bash
# Once it's in the career-ops registry:
node plugins.mjs add keenable

# Before listing (install from this repo at a pinned commit):
node plugins.mjs add keenableai/career-ops-plugin-keenable --sha <40-hex-commit>
```

Then enable + consent:

```bash
node plugins.mjs enable keenable            # shows the capability card
node plugins.mjs enable keenable --confirm  # grants it
```

## Use

```bash
# Preview
node plugins.mjs run keenable search "remote machine learning engineer" --dry-run

# A search_queries line from portals.yml, sent as written
node plugins.mjs run keenable search 'site:jobs.ashbyhq.com OR site:jobs.lever.co "Product Designer" remote'
```

In `portals.yml`:

```yaml
job_boards:
  - name: Remote ML roles (Keenable)
    provider: keenable
    scan_query: '"machine learning engineer" remote'
    max_results: 30          # optional, 1-50

tracked_companies:
  - name: Reddit
    provider: keenable
    scan_query: 'site:job-boards.greenhouse.io/reddit "machine learning"'
```

## Configure

Optional, in `config/plugins.yml`:

```yaml
plugins:
  keenable:
    enabled: true
    max_results: 20        # results per query, 1-50
    days_back: 30          # only pages published in the last N days
    sites:                 # replaces the default ATS hosts
      - job-boards.greenhouse.io
      - jobs.ashbyhq.com
```

`KEENABLE_API_KEY` in `.env` is optional. Without it the plugin uses the keyless
endpoint, limited to 10 requests/s and 1,000 requests/hour per IP; a key lifts
that limit. If the hourly limit is reached, the run stops with a message saying
so.

Search results come from an index that can lag the live board: check that a
posting is still open before you spend time on it.

## Develop

No dependencies. Both test files run offline:

```bash
node test/smoke.mjs   # the career-ops plugin contract
node test/unit.mjs    # request shape, result mapping, filters, errors
```

## License

MIT
