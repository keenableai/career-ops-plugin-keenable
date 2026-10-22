---
name: career-ops-plugin-keenable
description: How to find job postings with the keenable plugin and what it adds to the pipeline.
license: MIT
---

# keenable

> This file teaches an AI agent how to drive THIS plugin. It stays inside the
> plugin's own hooks: it does not ask the agent to edit core files, change
> scoring, or act outside `search` and `provider`.

The plugin runs a web search through Keenable and keeps only results that are
single job postings on the sites the search was limited to. By default that is
the employer ATS hosts below, so every result links to the employer's own posting:

`job-boards.greenhouse.io`, `boards.greenhouse.io`, `jobs.lever.co`,
`jobs.ashbyhq.com`, `apply.workable.com`, `jobs.smartrecruiters.com`,
`myworkdayjobs.com`

## How to run it

- One-off search, preview only:
  `node plugins.mjs run keenable search "remote machine learning engineer" --dry-run`
- Same search, appending new postings to `data/pipeline.md`:
  `node plugins.mjs run keenable search "remote machine learning engineer"`
- A query that already contains `site:` operators is sent as written, so the
  `search_queries` lines in `portals.yml` work unchanged:
  `node plugins.mjs run keenable search 'site:jobs.ashbyhq.com "Product Designer" remote'`
- During `node scan.mjs`: any `portals.yml` entry with `provider: keenable` and a
  `scan_query` runs like any other board.

Only the query text is sent. Nothing from the CV, tracker or pipeline leaves
the machine.

## What it produces

`Job` records for the pipeline:

| Field | Source |
|---|---|
| `title` | Page title, with ATS wrappers removed ("Job Application for", "@ Company", "Company - ") |
| `url` | The posting URL; for ATS hosts: https, no tracking query, no trailing `/apply` |
| `company` | The `name` of a `tracked_companies` entry; otherwise the employer from the title, else the slug in the ATS URL |
| `location` | Only when the page states it right under the title heading (Greenhouse, Lever) or in Ashby's "Location" field; otherwise empty |
| `description` | Up to 1,500 characters of page text (provider runs only; used by `content_filter`) |
| `postedAt` | Publication time, when the index has one |

Results come from a search index, which can lag the live board. Treat each one as
unverified until its posting page shows it is still open.

## Settings

Non-secret options in `config/plugins.yml` under `plugins.keenable`:

| Key | Default | Meaning |
|---|---|---|
| `max_results` | `20` | Results per query, 1-50 |
| `sites` | the ATS hosts above | Hosts (optionally with a path, e.g. `careers.example.com/jobs`) to search when the query has no `site:` of its own |
| `days_back` | none | Only pages published in the last N days |

A `portals.yml` entry may set `max_results` and `days_back` for itself.

`KEENABLE_API_KEY` in `.env` is optional. Without it the plugin uses the keyless
endpoint (10 requests/s and 1,000 requests/hour per IP); a key lifts that limit.
