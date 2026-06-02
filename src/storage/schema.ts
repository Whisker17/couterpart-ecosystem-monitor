export const DDL = `
-- Tracked competitors
CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    org TEXT NOT NULL,           -- organization slug
    blog_rss_url TEXT,           -- RSS feed URL (nullable)
    x_handle TEXT,               -- X/Twitter handle (nullable, v1 unused)
    website_url TEXT,            -- main website
    tags TEXT,                   -- JSON array of tags
    last_synced_at TEXT,         -- ISO timestamp
    created_at TEXT DEFAULT (datetime('now'))
);

-- Collected content items
-- X-related source type ('x_post') defined now to avoid schema migration later,
-- but X collector is not part of v1 scope (xEnabled: false).
CREATE TABLE IF NOT EXISTS content_items (
    id INTEGER PRIMARY KEY,
    competitor_id INTEGER NOT NULL REFERENCES competitors(id),
    source TEXT NOT NULL,        -- 'blog' | 'x_post'
    source_url TEXT NOT NULL,    -- normalized canonical URL
    title TEXT,                  -- blog title or null for tweets
    content TEXT,                -- full text content
    content_hash TEXT,           -- dedup hash
    published_at TEXT,           -- original publish time
    collected_at TEXT DEFAULT (datetime('now')),
    analysis_status TEXT DEFAULT 'pending',  -- pending | complete | failed (failed = terminal after max retries)
    input_quality TEXT,          -- 'full' | 'truncated' | 'metadata_only'
    retry_count INTEGER DEFAULT 0,  -- analysis retry attempts (terminal failed at 3)
    last_error TEXT,             -- most recent analysis error message
    reported_at TEXT,            -- set when item is included in a daily report (NULL = unreported)
    UNIQUE(source_url)           -- dedup by normalized URL (eng review T4)
);

-- LLM analysis results
CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY,
    content_item_id INTEGER NOT NULL REFERENCES content_items(id),
    summary TEXT NOT NULL,       -- 1-2 sentence summary
    technical_detail TEXT,       -- deeper analysis
    category TEXT,               -- product_launch | strategy_shift | hiring | partnership | technical | marketing | other
    direction_signal TEXT,       -- what this reveals about competitor direction
    significance TEXT NOT NULL,  -- routine | notable | directional_shift
    urgency TEXT DEFAULT 'normal',  -- normal | high (for future alert validation)
    sentiment TEXT,              -- positive | neutral | negative | aggressive
    why_we_care TEXT,            -- one sentence on why this matters to us
    input_tokens INTEGER,
    output_tokens INTEGER,
    model_id TEXT,
    estimated_cost_usd REAL,
    analyzed_at TEXT DEFAULT (datetime('now'))
);

-- Analysis inputs (audit trail — written for both successful and failed LLM calls)
CREATE TABLE IF NOT EXISTS analysis_inputs (
    id INTEGER PRIMARY KEY,
    content_item_id INTEGER NOT NULL REFERENCES content_items(id),  -- always set, enables audit of failed calls
    analysis_id INTEGER REFERENCES analyses(id),  -- NULL when LLM call failed (no analysis row)
    attempt INTEGER NOT NULL DEFAULT 1,           -- which retry attempt (1-based)
    prompt_version TEXT,
    input_quality TEXT,          -- full | truncated | metadata_only
    competitor_context TEXT,     -- rendered competitor context
    raw_content_snapshot TEXT,   -- content at analysis time
    error TEXT,                  -- error message if LLM call failed, NULL on success
    created_at TEXT DEFAULT (datetime('now'))
);

-- Generated reports
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    report_date TEXT NOT NULL,
    report_type TEXT NOT NULL,   -- daily | weekly
    content TEXT NOT NULL,       -- JSON report payload
    item_count INTEGER,
    notable_count INTEGER,
    is_partial INTEGER DEFAULT 0,
    content_hash TEXT,           -- SHA-256 of report JSON, used to detect content changes on upsert
    sent_at TEXT,                -- set when all deliveries succeed (NULL = unsent)
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(report_date, report_type)
);

-- Per-card Lark delivery tracking
CREATE TABLE IF NOT EXISTS report_deliveries (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id),
    card_index INTEGER NOT NULL DEFAULT 0,  -- card sequence (0 for single-card, 0..N for split)
    card_content TEXT NOT NULL,
    delivery_status TEXT DEFAULT 'pending',  -- pending | sent | failed
    message_id TEXT,
    sent_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(report_id, card_index)            -- prevents duplicate deliveries per card
);
`;
