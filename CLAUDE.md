# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Counterpart Ecosystem Monitor is a competitor narrative intelligence pipeline that tracks competitors' public content (blog posts, future X/Twitter) and delivers LLM-analyzed daily digests to Lark. Sister project to `couterpart-codebase-ecosystem` (GitHub PR monitoring). Same 4-stage pipeline architecture, same tech stack.

## Tech Stack

- **Runtime**: Bun (TypeScript)
- **Database**: SQLite via `bun:sqlite`
- **LLM**: Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) with Anthropic-compatible AI gateway (`baseURL` + `apiKey`), `generateObject()` + Zod for structured output
- **RSS parsing**: `rss-parser`
- **Content extraction**: `@extractus/article-extractor` (fallback for truncated RSS feeds)
- **Messaging**: Lark webhook (Message Card v2, ~30KB limit per card)
- **Scheduling**: croner

## Architecture

Four-stage sequential pipeline: **Blog RSS Collector → Analyzer → Report Generator → Lark Dispatcher**. Stages communicate via SQLite (status columns: `pending`/`complete`/`failed`), not direct function calls. A `PipelineContext` object tracks per-competitor collection status across all stages.

Use **plain TS modules with direct function calls** for the sequential pipeline (`src/pipeline/runner.ts`).

### Directory structure

```
src/
├── index.ts                    # Entry point, scheduler setup
├── e2e-run.ts                  # Manual pipeline runner (--mode daily/weekly, --no-dispatch)
├── pipeline/
│   ├── runner.ts               # Sequential stage executor
│   └── stages/
│       ├── collect.ts          # Blog RSS content fetcher
│       ├── analyze.ts          # LLM content analyzer
│       ├── report.ts           # Daily/weekly report builder
│       └── dispatch.ts         # Lark webhook delivery
├── collectors/
│   ├── blog-rss.ts             # RSS feed parser + article-extractor fallback
│   └── x-posts.ts             # X/Twitter (stub, v1 disabled)
├── storage/
│   ├── db.ts                   # Database initialization + pragmas
│   └── schema.ts               # Table definitions + version-based migrations
├── scheduler/                  # croner-based scheduling
└── utils/
    ├── url-normalize.ts        # URL normalization for dedup
    ├── retry.ts
    ├── rate-limiter.ts
    └── budget-tracker.ts
config/                         # JSON config files (project root, not src/)
├── competitors.json            # Blog RSS URLs, X handles per competitor
└── settings.json               # LLM model, budget cap, schedule, etc.
data/                           # SQLite db + raw content (gitignored)
```

## Key Technical Constraints

### bun:sqlite production pragmas
WAL mode alone is insufficient. Required pragma suite:
- `journal_mode=WAL`
- `busy_timeout=5000`
- `temp_store=MEMORY`
- `cache_size=-64000`
- `mmap_size=268435456`
- `foreign_keys=ON`
- `synchronous=NORMAL`

On macOS: use `fileControl(SQLITE_FCNTL_PERSIST_WAL, 0)` + `wal_checkpoint(TRUNCATE)` for clean shutdown.

### Content extraction
RSS feeds often serve truncated content. When RSS `content:encoded` or `description` is under 500 characters, fetch the full page URL via `@extractus/article-extractor`. If extraction fails (paywall, JS-rendered, 403), store truncated content and set `input_quality = 'truncated'` in `analysis_inputs`.

### URL normalization
Before storing `source_url`, normalize: strip trailing slash, remove tracking params (`utm_*`, `ref`, `source`), force https. Prevents duplicate LLM analyses from URL variants.

### Zod schema `.describe()`
All fields in `ContentAnalysisSchema` must have `.describe()` annotations in Chinese. This is the #1 best practice for `generateObject` structured output quality.

### Lark message size
Cards have a ~30KB limit. If a daily report exceeds 20KB: include only `notable`/`directional_shift` items, add "N routine items omitted" line. If still over, split into one card per competitor.

### LLM budget
$40/month cap. Track `input_tokens`, `output_tokens`, `model_id`, `estimated_cost_usd` in analyses table. At budget cap, skip analysis and log.

## Data Model

SQLite tables: `competitors` (tracked competitors + RSS URLs), `content_items` (collected blog posts + X posts), `analyses` (LLM output: summary, technical_detail, direction_signal, significance, urgency, why_we_care), `analysis_inputs` (persisted LLM inputs for audit/replay), `reports` (generated reports), `report_deliveries` (per-card delivery tracking). Full schema in `docs/reference/design.md`.

Content significance levels: `routine`, `notable`, `directional_shift`.

### Pipeline context
`PipelineContext` tracks per-competitor status (success/failed/skipped) across pipeline stages. Reports show which competitors had errors instead of silently omitting them.

## Development

### Commands

```bash
bun install                          # Install dependencies
bun run dev                          # Start scheduled pipeline
bun run src/e2e-run.ts               # Run full pipeline once (daily mode)
bun run src/e2e-run.ts --mode weekly  # Include weekly themes
bun run src/e2e-run.ts --no-dispatch  # Skip Lark delivery
bun test                             # Run tests
bunx tsc --noEmit                    # Type check
```

### Environment

Create `.env` from template:

```bash
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=your_llm_api_key
LARK_WEBHOOK_URL=your_lark_webhook
```

### v1 scope

- Blog RSS only. X/Twitter is deferred (`xEnabled: false` in `config/settings.json`).
- Daily reports to Lark. Weekly themes on Sunday.
- Dogfooding validation: 2-week trial with 3-5 competitors.

## Deployment

Same pattern as `couterpart-codebase-ecosystem`:
- PM2 + Docker Compose
- Self-hosted on the same server as the codebase monitor
- `data/` directory is gitignored — runtime data stays local

## Design Documents

- `docs/reference/design.md` — Full product design (APPROVED)
- `docs/reference/eng-review.md` — Engineering review summary (7 issues, all resolved)
- `docs/reference/test-plan.md` — Test plan (28 codepaths across 6 modules)

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Architecture/eng plan review → invoke /plan-eng-review
- Strategy/scope → invoke /plan-ceo-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
