# Counterpart Ecosystem Monitor — Multica Milestones & Issues Design

## Project Metadata

| Field | Value |
|-------|-------|
| Project | Counterpart Ecosystem Monitor |
| Start Date | 2026-06-02 |
| Target Date | 2026-06-20 |
| Priority | High |
| Lead | whisker yu |
| Team | Whisker-Personal |

## Project Summary (max 255 chars)

Competitor narrative intelligence: tracks competitor blogs via RSS, LLM-powered content analysis with structured output, directional judgments, delivers layered daily + weekly reports to Lark.

## Project Description

Four-stage sequential pipeline: **Blog RSS Collector → Analyzer → Report Generator → Lark Dispatcher**, communicating via SQLite (status columns: `pending`/`complete`/`failed`), not direct function calls. Pipeline is resumable and debuggable.

**Key architectural decision:** No agent framework. Pipeline orchestration uses plain TS modules with direct function calls (`src/pipeline/runner.ts`). `PipelineContext` carries per-competitor collection status through all 4 stages.

**Tech stack:** Bun (TypeScript), SQLite via `bun:sqlite`, `rss-parser`, `@extractus/article-extractor`, Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), Lark webhook (Message Card v2), croner.

**Sister project:** `couterpart-codebase-ecosystem` (GitHub PR monitoring). Same pipeline architecture, same tech stack, independent deployment.

---

## Milestones Overview

| Milestone | Name | Target Date | Issues |
|-----------|------|-------------|--------|
| M0 | Scaffold | 2026-06-04 | 4 |
| M1 | Core Pipeline (Daily + Weekly) | 2026-06-12 | 7 |
| M2 | Harden | 2026-06-19 | 8 |
| M3 (post-MVP) | Expansion + Evolution | TBD | 3+ |

**MVP Total: 19 issues (M0 + M1 + M2). Post-MVP: 3+ issues.**

> **Design source:** Architecture from `/office-hours` design doc (2026-06-02). 7 implementation tasks from `/plan-eng-review` (T1-T7) integrated into corresponding issues.

---

## M0: Scaffold

> Target: 2026-06-04 (2 days)
> Goal: 项目骨架就绪，SQLite 数据层可用，配置系统完整，URL 规范化工具就绪。

---

### Issue 1: [Setup] Bun 项目初始化与依赖安装

**Priority:** Urgent

#### Blocked By
无（起点 issue）

#### Blocks
Issue 2, Issue 3, Issue 4

#### 目标

初始化 Bun 项目，安装所有核心依赖，配置 TypeScript，创建完整目录骨架。确保任何人 `git clone && bun install && bun run dev` 零报错。

#### 实现内容

**1. 项目初始化**

* `bun init` 创建项目
* `tsconfig.json`：`strict: true`, `target: "ESNext"`, `module: "ESNext"`, `moduleResolution: "bundler"`

**2. 核心依赖安装**

```
bun add rss-parser @extractus/article-extractor croner ai @ai-sdk/anthropic zod
bun add -d @types/bun typescript
```

**3. 目录结构创建**

```
src/
├── index.ts                    # Entry point, scheduler setup
├── config/                     # 竞品注册表 + settings
├── collectors/                 # Source-specific collection logic
│   ├── blog-rss.ts             # RSS feed parser + content extraction
│   └── x-posts.ts             # X/Twitter (placeholder, v1 disabled)
├── pipeline/                   # Pipeline runner + stages
│   ├── runner.ts               # Sequential stage executor + PipelineContext
│   └── stages/
│       ├── collect.ts          # Orchestrates collectors per competitor
│       ├── analyze.ts          # LLM content analyzer
│       ├── report.ts           # Daily/weekly report builder
│       └── dispatch.ts         # Lark webhook delivery
├── storage/                    # SQLite schema + db setup
│   ├── db.ts                   # Database initialization + pragmas
│   └── schema.ts               # Table definitions + version-based migrations
├── scheduler/                  # croner-based scheduling
│   └── cron.ts
├── e2e-run.ts                  # Manual pipeline validation (eng review T3)
└── utils/                      # Shared utilities
    ├── retry.ts
    ├── rate-limiter.ts
    ├── budget-tracker.ts
    └── url-normalize.ts        # URL normalization (eng review T4)
config/                         # JSON config files (project root, not src/)
├── competitors.json            # Blog RSS URLs, X handles per competitor
└── settings.json               # LLM model, budget cap, schedule, etc.
data/                           # SQLite db + raw content (gitignored)
```

**4. Scripts 与 gitignore**

* `package.json` scripts: `"dev": "bun run src/index.ts"`, `"start": "bun run src/index.ts"`, `"e2e": "bun run src/e2e-run.ts"`
* `.gitignore`: `node_modules/`, `data/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts`（空壳） |
| CREATE | 所有目录下的 `.gitkeep`（保持目录结构） |
| CREATE | `.env.example` |

#### 验收标准

* [ ] `git clone && bun install && bun run dev` 零报错
* [ ] TypeScript strict mode 编译通过
* [ ] 目录结构完整，所有子目录存在

---

### Issue 2: [Setup] SQLite schema 定义与 db 模块实现

**Priority:** Urgent
**Eng Review:** T5 (PRAGMA busy_timeout = 5000)

#### Blocked By
Issue 1

#### Blocks
Issue 5, Issue 6

#### 目标

实现 SQLite 数据库模块：完整 schema（6 张表）、生产级 pragma 配置（含 busy_timeout）、自动建表。这是整个 pipeline 的通信层 — 各 stage 通过 SQLite status 列协调。

#### 实现内容

**1. Schema 定义 (`src/storage/schema.ts`)**

完整 DDL 如下，必须严格遵守：

```sql
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
    analysis_status TEXT DEFAULT 'pending',  -- pending | complete | failed
    input_quality TEXT,          -- 'full' | 'truncated' | 'metadata_only'
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

-- Analysis inputs (audit trail)
CREATE TABLE IF NOT EXISTS analysis_inputs (
    id INTEGER PRIMARY KEY,
    analysis_id INTEGER NOT NULL REFERENCES analyses(id),
    prompt_version TEXT,
    input_quality TEXT,          -- full | truncated | metadata_only
    competitor_context TEXT,     -- rendered competitor context
    raw_content_snapshot TEXT,   -- content at analysis time
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
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(report_date, report_type)
);

-- Per-card Lark delivery tracking
CREATE TABLE IF NOT EXISTS report_deliveries (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id),
    card_content TEXT NOT NULL,
    delivery_status TEXT DEFAULT 'pending',  -- pending | sent | failed
    message_id TEXT,
    sent_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

**2. Database 模块 (`src/storage/db.ts`)**

* 使用 `bun:sqlite` 的 `Database` 类
* 数据库文件路径：`data/monitor.db`（目录不存在时自动创建）
* 生产级 pragma 配置（**必须全部设置**，eng review 硬性要求）：
  ```ts
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA temp_store=MEMORY");
  db.exec("PRAGMA cache_size=-64000");     // 64MB
  db.exec("PRAGMA mmap_size=268435456");   // 256MB
  db.exec("PRAGMA busy_timeout=5000");     // 5s — eng review T5
  ```
* macOS WAL 清理（shutdown hook）：尝试 `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")`
* 导出：`getDb(): Database`（单例）+ `closeDb(): void`
* 首次运行时自动执行 DDL 建表

**3. 迁移机制**

* 使用 SQLite `user_version` pragma 追踪 schema 版本
* `PRAGMA user_version = 1` 初始版本
* 启动时检查 `PRAGMA user_version`，按需执行 migration

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/storage/db.ts` |
| CREATE | `src/storage/schema.ts` |

#### 验收标准

* [ ] `bun run dev` 后 `data/monitor.db` 自动创建
* [ ] 六张表结构正确（`sqlite3 data/monitor.db ".schema"` 验证）
* [ ] `PRAGMA journal_mode` 返回 `wal`
* [ ] `PRAGMA busy_timeout` 返回 `5000`
* [ ] `UNIQUE(source_url)` 约束生效：重复 INSERT 报错或被 IGNORE
* [ ] `reports` 表的 `UNIQUE(report_date, report_type)` 约束生效
* [ ] `content_items.input_quality` 列存在
* [ ] 进程 `SIGTERM` 退出时 WAL checkpoint 执行

---

### Issue 3: [Setup] 竞品注册表与全局配置模块

**Priority:** High

#### Blocked By
Issue 1

#### Blocks
Issue 5, Issue 6

#### 目标

实现配置系统：tracked competitors 注册表 + 全局 settings + 环境变量。后续 pipeline 所有 stage 通过此模块读取配置。

#### 实现内容

**1. 竞品注册表 (`src/config/competitors.ts` + `config/competitors.json`)**

TypeScript 类型定义：
```ts
interface CompetitorConfig {
  name: string;         // Display name, e.g. "Competitor A"
  org: string;          // Organization slug
  blogRssUrl?: string;  // RSS feed URL (nullable)
  xHandle?: string;     // X/Twitter handle (v1 unused)
  xEnabled: boolean;    // false for v1
  websiteUrl?: string;  // Main website
  tags?: string[];      // Optional tags: ["defi", "layer2"]
  rssQuality?: string;  // Pre-validation: "full" | "truncated" | "title_only" | "none"
}
```

* 从 `config/competitors.json` 读取，导出 `getCompetitors(): CompetitorConfig[]`
* 初始配置 3-5 个竞品（博客有活跃 RSS feed 的）
* 每个竞品包含 `rssQuality` 字段（预验证结果）

**2. 全局设置 (`src/config/settings.ts` + `config/settings.json`)**

```ts
interface Settings {
  llm: {
    model: string;              // "claude-sonnet-4-6"
    baseUrlEnvVar: string;      // "LLM_BASE_URL"
    apiKeyEnvVar: string;       // "LLM_API_KEY"
    maxTokensPerCall: number;   // 4096
  };
  lark: {
    webhookUrlEnvVar: string;   // "LARK_WEBHOOK_URL"
  };
  schedule: {
    dailyCron: string;          // "0 8 * * *"
    weeklyCron: string;         // "0 9 * * 0" (Sunday)
  };
  budget: {
    monthlyCap: number;        // 40 (USD)
    warningThreshold: number;  // 0.8
    cutoffThreshold: number;   // 1.0
  };
  collector: {
    contentMinLength: number;  // 500 (chars, trigger article-extractor fallback)
  };
}
```

* JSON 文件提供默认值，环境变量覆盖敏感字段
* 导出 `getSettings(): Settings`

**3. 配置校验**

* 启动时校验必填环境变量：`LLM_BASE_URL`, `LLM_API_KEY`
* Lark 环境变量 `LARK_WEBHOOK_URL` 在 M2 Lark 集成时校验（M1 不需要）
* 缺失时打印明确信息并 `process.exit(1)`

**4. 环境变量模板**

创建 `.env.example`：
```
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-xxx
LARK_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/xxx
```

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/config/competitors.ts`, `src/config/settings.ts` |
| CREATE | `config/competitors.json`, `config/settings.json` |
| CREATE | `.env.example` |

#### 验收标准

* [ ] `getCompetitors()` 返回 3-5 个真实竞品，各含 `blogRssUrl`
* [ ] `getSettings()` 返回完整配置对象（包含 `budget.monthlyCap` 默认 40）
* [ ] 缺失 `LLM_BASE_URL` 或 `LLM_API_KEY` 时启动报错，信息包含缺失变量名
* [ ] 环境变量可覆盖 JSON 配置中的值
* [ ] 每个竞品有 `rssQuality` 预验证字段

---

### Issue 4: [Utils] URL 规范化工具

**Priority:** High
**Eng Review:** T4 (URL normalization for dedup)

#### Blocked By
Issue 1

#### Blocks
Issue 6

#### 目标

实现 URL 规范化函数，确保同一篇文章的不同 URL 变体（trailing slash、utm 参数、http vs https）映射到相同的 normalized URL，防止重复入库。

#### 实现内容

**1. URL Normalize (`src/utils/url-normalize.ts`)**

```ts
function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  // 1. Force https
  url.protocol = "https:";
  // 2. Strip trailing slash
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  // 3. Remove tracking params
  const trackingPrefixes = ["utm_", "ref", "fbclid", "gclid"];
  for (const key of [...url.searchParams.keys()]) {
    if (trackingPrefixes.some(p => key.startsWith(p))) {
      url.searchParams.delete(key);
    }
  }
  // 4. Sort remaining params for consistency
  url.searchParams.sort();
  // 5. Remove hash fragment
  url.hash = "";
  return url.toString();
}
```

* 导出 `normalizeUrl(raw: string): string`
* 无效 URL 输入时返回原始字符串（不 throw）

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/utils/url-normalize.ts` |

#### 验收标准

* [ ] `http://example.com/blog/` → `https://example.com/blog`
* [ ] `https://example.com/blog?utm_source=rss&id=1` → `https://example.com/blog?id=1`
* [ ] `https://example.com/blog#section` → `https://example.com/blog`
* [ ] 无效 URL 输入不 throw
* [ ] 相同文章不同 URL 变体 normalize 后完全一致

---

## M1: Core Pipeline (Daily + Weekly)

> Target: 2026-06-12 (6 working days)
> Goal: 端到端 pipeline 跑通（collect → analyze → report），本地 JSON 验证分析质量。Lark 推送延迟到 M2。

---

### Issue 5: [Pipeline] Pipeline runner + PipelineContext + 调度框架

**Priority:** Urgent
**Eng Review:** T6 (PipelineContext for error propagation)

#### Blocked By
Issue 2, Issue 3（需要 db、config 全部就绪）

#### Blocks
Issue 6, Issue 7, Issue 8

#### 目标

实现 pipeline 顺序执行框架、PipelineContext 错误传播机制、croner 调度。PipelineContext 是 eng review 的明确要求：每个 stage 可查询上游 stage 的 per-competitor 执行状态，Report stage 据此区分 "no new content" 和 "collector failed"。

#### 实现内容

**1. Pipeline Runner (`src/pipeline/runner.ts`)**

```ts
interface CompetitorStatus {
  competitorId: string;
  competitorName: string;
  success: boolean;
  itemsCollected: number;
  error?: string;
}

interface StageResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
  durationMs: number;
  competitorStatuses?: CompetitorStatus[];  // per-competitor status from collect stage
}

interface PipelineContext {
  mode: "daily" | "weekly";
  stageResults: Map<string, StageResult>;
}

interface PipelineStage {
  name: string;
  execute: (ctx: PipelineContext) => Promise<StageResult>;
}

async function runPipeline(
  stages: PipelineStage[],
  mode: "daily" | "weekly"
): Promise<PipelineContext>;
```

* 顺序执行所有 stage，单个失败不阻断后续
* PipelineContext 随 stage 累积，下游可检查上游完整性
* 每个 stage 执行前后记录日志：`[Pipeline] Starting stage: collect`, `[Pipeline] Stage collect completed in 3200ms (5 items)`
* Report stage 可查询 collect stage 的 `competitorStatuses`，据此标记报告为 partial（"3/5 competitors collected, 2 failed"）

**2. Scheduler (`src/scheduler/cron.ts`)**

* 使用 `croner` 注册两个定时任务：
  * Daily pipeline: 读取 `settings.schedule.dailyCron`
  * Weekly pipeline: 读取 `settings.schedule.weeklyCron`（Sunday，触发 weekly report 逻辑）
* 提供 `runNow(mode: "daily" | "weekly")` 手动触发入口

**3. Stage 骨架（4 个空壳）**

创建四个 stage 文件，各导出 `execute(ctx: PipelineContext): Promise<StageResult>`，初始实现为 `return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 }`：

* `src/pipeline/stages/collect.ts`
* `src/pipeline/stages/analyze.ts`
* `src/pipeline/stages/report.ts`
* `src/pipeline/stages/dispatch.ts`

**4. 集成到 `src/index.ts`**

* 注册 scheduler
* `runPipeline([collect, analyze, report, dispatch], mode)` 作为 scheduled task

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/pipeline/runner.ts` |
| CREATE | `src/scheduler/cron.ts` |
| CREATE | `src/pipeline/stages/collect.ts`（空壳） |
| CREATE | `src/pipeline/stages/analyze.ts`（空壳） |
| CREATE | `src/pipeline/stages/report.ts`（空壳） |
| CREATE | `src/pipeline/stages/dispatch.ts`（空壳） |
| MODIFY | `src/index.ts`（注册 scheduler + pipeline） |

#### 验收标准

* [ ] `runPipeline()` 顺序执行 4 个 stage，日志清晰标注每个 stage 的名称/耗时/结果
* [ ] 某个 stage `throw Error` 时 pipeline 继续执行后续 stage
* [ ] 下游 stage 可通过 `ctx.stageResults` 查询上游执行情况
* [ ] `ctx.stageResults.get("collect")?.competitorStatuses` 可获取 per-competitor 状态
* [ ] `runNow("daily")` 可在 CLI 直接手动触发完整 pipeline
* [ ] croner 设为 1 分钟间隔时可验证自动触发

---

### Issue 6: [Collector] Blog RSS 采集器 + article-extractor 全文提取

**Priority:** Urgent
**Eng Review:** T1 (Use @extractus/article-extractor for content extraction)

#### Blocked By
Issue 2（SQLite schema）, Issue 3（竞品注册表）, Issue 4（URL 规范化）, Issue 5（pipeline runner 的 stage 骨架）

#### Blocks
Issue 7, Issue 11

#### 目标

实现完整的 Blog RSS Collector stage：使用 `rss-parser` 抓取竞品 RSS feeds，解析 blog items，URL 规范化后写入 `content_items` 表。RSS 内容不足 500 字符时使用 `@extractus/article-extractor` 抓取全文。

#### 实现内容

**1. RSS Feed Parser (`src/collectors/blog-rss.ts`)**

```ts
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

interface CollectedItem {
  title: string;
  sourceUrl: string;        // normalized URL
  content: string;          // full article text
  publishedAt: string;      // ISO timestamp
  inputQuality: "full" | "truncated" | "metadata_only";
}

async function collectFromRss(
  competitor: CompetitorConfig,
  since?: Date
): Promise<CollectedItem[]>;
```

* 使用 `rss-parser` 获取 feed items
* 过滤：仅处理 `since` 之后发布的 items（首次同步抓取最近 7 天）
* 对每个 item：
  1. `normalizeUrl(item.link)` 规范化 URL
  2. 检查 `content_items` 表中是否已存在（dedup by normalized URL）
  3. 已存在则 skip
  4. 提取内容：优先使用 RSS `content:encoded` 或 `description`

**2. Content Extraction Fallback**

* 如果 RSS 内容 < 500 字符（`settings.collector.contentMinLength`）：
  * 调用 `@extractus/article-extractor` 的 `extract(url)`
  * 成功：使用提取的全文，`inputQuality = "full"`
  * 失败（paywall、JS-rendered、403）：保留 truncated RSS 内容，`inputQuality = "truncated"`
* RSS 内容 >= 500 字符：直接使用，`inputQuality = "full"`
* RSS 无内容（仅 title）：`inputQuality = "metadata_only"`

**3. Collect Stage (`src/pipeline/stages/collect.ts`)**

完整实现（替换 Issue 5 创建的空壳）：

```ts
async function execute(ctx: PipelineContext): Promise<StageResult> {
  const competitors = getCompetitors();
  const competitorStatuses: CompetitorStatus[] = [];

  for (const competitor of competitors) {
    try {
      if (!competitor.blogRssUrl) {
        competitorStatuses.push({
          competitorId: competitor.org,
          competitorName: competitor.name,
          success: true,
          itemsCollected: 0,
        });
        continue;
      }

      // 1. Determine since time
      const lastSynced = db.query(
        "SELECT last_synced_at FROM competitors WHERE org = ?"
      ).get(competitor.org);
      const since = lastSynced?.last_synced_at
        ? new Date(lastSynced.last_synced_at)
        : sevenDaysAgo();

      // 2. Collect from RSS
      const items = await collectFromRss(competitor, since);

      // 3. Write to DB (idempotent: INSERT OR IGNORE by normalized URL)
      for (const item of items) {
        db.run(
          "INSERT OR IGNORE INTO content_items (...) VALUES (...)",
          ...
        );
      }

      // 4. Update last_synced_at
      db.run(
        "UPDATE competitors SET last_synced_at = ? WHERE org = ?",
        new Date().toISOString(), competitor.org
      );

      competitorStatuses.push({
        competitorId: competitor.org,
        competitorName: competitor.name,
        success: true,
        itemsCollected: items.length,
      });
    } catch (error) {
      competitorStatuses.push({
        competitorId: competitor.org,
        competitorName: competitor.name,
        success: false,
        itemsCollected: 0,
        error: error.message,
      });
    }
  }

  return {
    success: competitorStatuses.some(s => s.success),
    itemsProcessed: competitorStatuses.reduce((sum, s) => sum + s.itemsCollected, 0),
    errors: competitorStatuses.filter(s => !s.success).map(s => s.error!),
    durationMs: ...,
    competitorStatuses,
  };
}
```

* 首次同步（`last_synced_at` 为 null）：抓取最近 7 天
* 单个 competitor 失败时 catch error，继续下一个 competitor
* 初始数据写入：首次运行前将 `config/competitors.json` 中的竞品写入 `competitors` 表（`INSERT OR IGNORE`）

**4. RSS 预验证**

* 实际编码前，手动验证每个竞品的 RSS feed 质量
* 记录到 `competitors.json` 的 `rssQuality` 字段
* 如果少于 2 个竞品有可用 RSS，需暂停重新评估方案

#### 技术约束

* RSS feed 通常无 rate limit，但避免并发请求同一域名
* article-extractor 需要 HTTP 请求原始页面，可能被 403/paywall 阻止
* 预计 5 个竞品每天 ~5-10 篇新 blog posts

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/collectors/blog-rss.ts` |
| MODIFY | `src/pipeline/stages/collect.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] 对 3-5 个配置竞品执行 collect，`content_items` 表有数据
* [ ] 重复执行不产生重复记录（`INSERT OR IGNORE` + normalized URL 幂等）
* [ ] RSS 内容 < 500 字符时触发 article-extractor 抓取全文
* [ ] article-extractor 失败时保留 truncated 内容，`input_quality = 'truncated'`
* [ ] `competitors.last_synced_at` 正确更新
* [ ] 日志输出每个竞品采集的 item 数量
* [ ] URL 变体（trailing slash、utm params）不产生重复记录
* [ ] 单个竞品 RSS 失败不阻断其他竞品采集

---

### Issue 7: [Analyzer] LLM 内容分析器 + Zod schema with .describe()

**Priority:** Urgent
**Eng Review:** T2 (Add .describe() to all Zod schema fields)

#### Blocked By
Issue 5（pipeline runner）, Issue 6（提供 `content_items` 表中的待分析数据）

#### Blocks
Issue 8, Issue 11, Issue 15

#### 目标

实现 Analyzer stage：读取 `analysis_status = 'pending'` 的 content items，调用 LLM 生成结构化分析（summary, technical_detail, direction_signal, significance, why_we_care），写入 `analyses` 表和 `analysis_inputs` 表。Zod schema 所有字段必须有 `.describe()` 注解（中文，eng review T2）。

#### 实现内容

**1. Zod Analysis Schema (`src/pipeline/stages/analyze.ts`)**

```ts
const ContentAnalysisSchema = z.object({
  summary: z.string()
    .describe("1-2句中文摘要，概括竞争对手发布的内容要点"),
  technical_detail: z.string()
    .describe("2-4句技术或策略分析，说明内容的具体含义和影响"),
  category: z.enum([
    "product_launch", "strategy_shift", "hiring",
    "partnership", "technical", "marketing", "other"
  ]).describe("内容类别：产品发布、战略转向、招聘、合作、技术更新、营销、其他"),
  direction_signal: z.string()
    .describe("一句话总结这篇内容揭示了竞争对手什么方向性信号，routine 内容可为空字符串"),
  significance: z.enum(["routine", "notable", "directional_shift"])
    .describe("重要性判断：routine=日常更新, notable=值得关注, directional_shift=方向性变化"),
  urgency: z.enum(["normal", "high"])
    .describe("紧急度：normal=常规, high=需要尽快关注（如融资、重大产品发布）"),
  sentiment: z.enum(["positive", "neutral", "negative", "aggressive"])
    .describe("内容情绪基调"),
  why_we_care: z.string()
    .describe("一句话说明这对我们团队意味着什么、为什么需要关注"),
});
```

**2. LLM Reviewer (`src/pipeline/stages/analyze.ts`)**

System prompt:

```
You are a competitive intelligence analyst. Given a competitor's blog post
or public content, produce a structured analysis in Chinese. Focus on what
this reveals about the competitor's product direction, strategy, and
competitive positioning.

COMPETITOR CONTEXT:
Name: {competitor.name}
Tags: {competitor.tags.join(", ") or "None"}
Website: {competitor.websiteUrl or "Unknown"}

CONTENT INFORMATION:
Title: {item.title}
Source: {item.source} ({item.source_url})
Published: {item.published_at}
Content Quality: {item.input_quality}

CONTENT:
{item.content or "Content not available — analysis based on title and metadata only."}

Significance 分类规则：
* routine: 日常博客更新、小功能公告、团队介绍、营销活动
* notable: 新产品/功能发布、重要合作、显著技术变更、市场策略调整
* directional_shift: 全新业务方向、重大战略转向、核心产品线变化、进入新市场
```

LLM 调用：
* 使用 Vercel AI SDK（`ai` + `@ai-sdk/anthropic`，通过 AI gateway），model 默认 `claude-sonnet-4-6`
* 使用 `generateObject()` + Zod schema with `.describe()` 获取结构化输出
* schema 校验失败时重试 1 次，仍失败标记 `analysis_status = 'failed'`
* 记录 token 用量：从 `result.usage` 提取 `inputTokens` / `outputTokens`，计算 `estimated_cost_usd`

**3. Analyzer Stage**

* **Budget 硬上限检查（每个 item 分析前）：**
  ```ts
  const monthlyUsage = db.query(
    "SELECT SUM(estimated_cost_usd) as total_cost FROM analyses WHERE analyzed_at >= ?"
  ).get(monthStart);
  if (monthlyUsage.total_cost >= settings.budget.monthlyCap) {
    // skip remaining items, keep as 'pending'
    break;
  }
  ```
* 查询待分析 items（含重试）：
  ```sql
  SELECT ci.*, c.name, c.org, c.tags, c.website_url
  FROM content_items ci JOIN competitors c ON ci.competitor_id = c.id
  WHERE ci.analysis_status = 'pending'
  ```
* 对每个 item 顺序处理（**不并发**，控制 API 负载）
* 成功：`UPDATE content_items SET analysis_status = 'complete' WHERE id = ?`
* 失败：`UPDATE content_items SET analysis_status = 'failed' WHERE id = ?`
* 同时写入 `analysis_inputs` 表（prompt_version, input_quality, raw_content_snapshot）
* 单个 item 失败不阻断其他 item

#### 技术约束

* 单次 LLM 调用 timeout: 60s
* 预估 token 消耗：~2000-4000 input + ~300-500 output tokens/item
* 预估成本：~$0.01-0.02/item（Claude Sonnet）
* Zod `.describe()` 注解使用中文（eng review T2 明确要求）

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/pipeline/stages/analyze.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] 对 pending content item 生成分析，`analyses` 表写入所有字段
* [ ] Zod schema 所有 8 个字段都有 `.describe()` 中文注解
* [ ] `generateObject()` 结构化输出通过 Zod 校验
* [ ] `input_tokens`, `output_tokens`, `estimated_cost_usd` 正确记录（>0）
* [ ] `analysis_inputs` 表同步写入 prompt_version, input_quality, raw_content_snapshot
* [ ] 分析完成后 `content_items.analysis_status` = `'complete'`
* [ ] LLM 调用失败时标记 `'failed'`
* [ ] 单个 item 失败不阻断其他 item 的分析
* [ ] 月度 budget 硬上限：超限时跳过剩余 items，日志输出

---

### Issue 8: [Reporter] Daily report 生成器

**Priority:** High

#### Blocked By
Issue 7（需要 `analyses` 表中有分析数据）

#### Blocks
Issue 9, Issue 11

#### 目标

实现 Report Generator stage 的 daily report：聚合当天各竞品的内容分析结果，生成结构化 JSON 报告，写入 `reports` 表 + 本地 JSON 文件。M1 阶段通过本地文件验证分析质量。

#### 实现内容

**1. Daily Report 组装 (`src/pipeline/stages/report.ts`)**

* 查询：`SELECT a.*, ci.title, ci.source_url, c.name as competitor_name FROM analyses a JOIN content_items ci ON a.content_item_id = ci.id JOIN competitors c ON ci.competitor_id = c.id WHERE a.analyzed_at >= ?`（今天 00:00 UTC）
* 按竞品分组
* 每个竞品生成：
  * Summary 行：`Competitor A: 2 blog posts, 1 notable — launched new API product`
  * Detail 列表：每个 item 的 `summary + significance + direction_signal + why_we_care`
* 排序规则：directional_shift 排最前 > notable > routine

**2. Lark Card 模板**

必须使用 Lark Message Card v2 格式：

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "竞品动态日报 · 2026-06-05" },
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**概览**\n* Competitor A: 2 篇博客, 1 notable...\n* Competitor B: 1 篇博客, routine"
    },
    { "tag": "hr" },
    {
      "tag": "collapsible_panel",
      "expanded": false,
      "header": { "title": { "tag": "plain_text", "content": "详细分析" } },
      "elements": [
        { "tag": "markdown", "content": "**[Competitor A]**\n\n博客: \"Title\" — summary\n重要性: NOTABLE\n方向信号: ...\n..." }
      ]
    }
  ]
}
```

**3. PipelineContext 集成**

* 接收 `PipelineContext`，从中提取 collect stage 的 `competitorStatuses`
* 如果有失败的 competitor：在 card summary 顶部添加 `"⚠ 部分报告: {N}/{total} 个竞品采集成功，{failed} 个失败"` 标记
* 标记 `reports.is_partial = 1`

**4. 本地 JSON 输出**

* 每次生成报告后写入 `data/reports/daily-YYYY-MM-DD.json`
* 包含 `{ date, card, analyses, completeness }` — 完整报告内容 + 原始分析数据

**5. 幂等写入**

```sql
INSERT INTO reports (report_date, report_type, content, item_count, notable_count, is_partial)
VALUES (?, 'daily', ?, ?, ?, ?)
ON CONFLICT(report_date, report_type)
DO UPDATE SET content = excluded.content, item_count = excluded.item_count, notable_count = excluded.notable_count, is_partial = excluded.is_partial
```

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/pipeline/stages/report.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] 生成的 card JSON 结构包含 `config`, `header`, `elements` 三层
* [ ] Summary section 列出每个竞品的 blog 数 + 重要变化
* [ ] Technical detail 在 `collapsible_panel` 中
* [ ] 无分析数据时不生成报告（`itemsProcessed = 0`）
* [ ] `reports` 表正确写入 `report_type='daily'` 记录
* [ ] 重复运行 pipeline 不产生重复报告（upsert 覆盖同一行）
* [ ] 上游 stage 部分失败时，报告卡片中包含 partial report 标记，`is_partial = 1`
* [ ] `data/reports/daily-YYYY-MM-DD.json` 本地文件正确生成

---

### Issue 9: [Reporter] Weekly report 聚合与趋势分析

**Priority:** High

#### Blocked By
Issue 8（daily report 模板机制复用）

#### Blocks
Issue 11

#### 目标

实现 Weekly report：聚合过去 7 天的内容分析数据，提取方向性变化和跨竞品趋势，使用 LLM 生成周度主题分析，生成周报 card JSON。

#### 实现内容

**1. Weekly Report 组装**

* 查询：过去 7 天的全部分析数据
* 聚合三个维度：
  * **Direction Changes**: 所有 `significance = 'directional_shift'` 的 items，按竞品分组
  * **Activity Summary**: 各竞品 content item 总数 + notable 数 + directional_shift 数
  * **Cross-Competitor Themes**: LLM 调用，输入所有分析结果 summary，提取跨竞品的共同主题和趋势

**2. Weekly Card Template**

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "竞品动态周报 · 5月26日-6月1日" },
    "template": "purple"
  },
  "elements": [
    { "tag": "markdown", "content": "**本周方向性变化**\n* Competitor A: 发布新 DeFi 产品线\n* Competitor C: 进入亚太市场" },
    { "tag": "hr" },
    { "tag": "markdown", "content": "**活动概览**\n* 12 篇博客来自 5 个竞品\n* 2 个方向性变化\n* 4 个值得关注的更新" },
    { "tag": "hr" },
    { "tag": "markdown", "content": "**跨竞品主题**\n* 主题 1: 多家竞品同时发力...\n* 主题 2: ..." },
    { "tag": "hr" },
    { "tag": "collapsible_panel", "expanded": false,
      "header": { "title": { "tag": "plain_text", "content": "各竞品详情" } },
      "elements": [{ "tag": "markdown", "content": "..." }] }
  ]
}
```

**3. 集成到 Pipeline**

* 修改 `src/pipeline/stages/report.ts`：当 `ctx.mode === "weekly"` 时生成 weekly report
* Sunday 触发 weekly pipeline（通过 scheduler `weeklyCron`）
* Weekly report 写入 `reports` 表，`report_type = 'weekly'`

**4. LLM 主题提取**

* 如果本周 items < 3 个，跳过 LLM 主题提取（数据不足）
* 使用 `generateObject()` 提取 2-3 个跨竞品主题

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/pipeline/stages/report.ts`（增加 weekly report 逻辑） |
| MODIFY | `src/scheduler/cron.ts`（weekly 触发设置 mode） |

#### 验收标准

* [ ] Weekly report 聚合了 7 天的分析数据
* [ ] Directional shift 在报告中被重点展示
* [ ] Cross-competitor themes 由 LLM 生成（items >= 3 时）
* [ ] Activity summary 数字准确
* [ ] Sunday 自动触发 weekly report 生成
* [ ] Lark 卡片格式与 daily 卡片风格一致但结构不同（purple header）

---

### Issue 10: [Pipeline] E2E runner for manual validation

**Priority:** High
**Eng Review:** T3 (Add src/e2e-run.ts for manual pipeline validation)

#### Blocked By
Issue 5（pipeline runner）

#### Blocks
Issue 11

#### 目标

实现 `src/e2e-run.ts`，用于手动触发 pipeline 验证。镜像 sister project 的 e2e-run.ts，支持 `--mode daily/weekly` 和 `--no-dispatch`（检查报告内容但不发送 Lark）。这是开发和调试的主要入口。

#### 实现内容

**1. E2E Runner (`src/e2e-run.ts`)**

```ts
// CLI: bun run src/e2e-run.ts --mode daily --no-dispatch
const args = parseArgs({
  options: {
    mode: { type: "string", default: "daily" },       // daily | weekly
    "no-dispatch": { type: "boolean", default: false }, // skip Lark delivery
  },
});

async function main() {
  const mode = args.values.mode as "daily" | "weekly";
  const noDispatch = args.values["no-dispatch"];

  const stages = [collect, analyze, report];
  if (!noDispatch) stages.push(dispatch);

  const ctx = await runPipeline(stages, mode);

  // Print summary
  for (const [name, result] of ctx.stageResults) {
    console.log(`[${name}] ${result.success ? "OK" : "FAILED"} — ${result.itemsProcessed} items in ${result.durationMs}ms`);
    if (result.errors.length > 0) {
      result.errors.forEach(e => console.log(`  ERROR: ${e}`));
    }
  }

  // Print latest report path
  const reportPath = `data/reports/${mode}-${today()}.json`;
  if (existsSync(reportPath)) {
    console.log(`\nReport written to: ${reportPath}`);
  }
}
```

* 支持 `bun run e2e` (package.json script)
* `--no-dispatch` 模式：跳过 dispatch stage，仅生成本地 JSON 报告
* 退出时关闭 DB 连接

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/e2e-run.ts` |
| MODIFY | `package.json`（添加 `"e2e": "bun run src/e2e-run.ts"` script） |

#### 验收标准

* [ ] `bun run e2e --mode daily --no-dispatch` 执行完整 pipeline（除 dispatch）
* [ ] `bun run e2e --mode weekly` 执行 weekly pipeline
* [ ] 执行结束后打印每个 stage 的状态摘要
* [ ] `--no-dispatch` 不触发任何 Lark 请求
* [ ] 进程正确退出（不 hang）

---

### Issue 11: [Pipeline] 端到端集成联调与首份日报验证

**Priority:** Urgent

#### Blocked By
Issue 6, Issue 7, Issue 8, Issue 9, Issue 10（所有 M1 deliverables 完成）

#### Blocks
Issue 12（M2 Lark 推送）, Issue 13, Issue 15（M2 入口）

#### 目标

M1 最终验证：完整 pipeline 端到端执行成功（collect → analyze → report），本地 JSON 报告验证分析质量。使用 E2E runner 执行。

#### 实现内容

**1. 端到端执行**

* 确保 `config/competitors.json` 配置了 3-5 个有活跃博客的竞品
* 确保 `.env` 中环境变量已设置（`LLM_BASE_URL`, `LLM_API_KEY`）
* 执行 `bun run e2e --mode daily --no-dispatch`
* 预期数据流：RSS Feed → `content_items` 表 → LLM → `analyses` 表 → card JSON → `reports` 表 + `data/reports/daily-YYYY-MM-DD.json`

**2. 验证检查清单**

* [ ] `content_items` 表中有数据（collect 成功）
* [ ] `analyses` 表中有 complete 分析（analyze 成功）
* [ ] `reports` 表中有 daily report（report 成功）
* [ ] `data/reports/daily-YYYY-MM-DD.json` 本地文件生成，内容可读
* [ ] 报告 summary 准确描述了博客内容（审查本地 JSON）
* [ ] significance 分类基本合理（抽查 3-5 个 items）
* [ ] `analysis_inputs` 表有数据，`prompt_version` 非空
* [ ] Weekly report 格式正确（`bun run e2e --mode weekly`）
* [ ] 单次 pipeline 总耗时 < 3 分钟（5 个竞品）

**3. 增量语义验证**

* 第二次运行 `bun run e2e --mode daily --no-dispatch`
* 确认不重复分析已完成的 items（增量语义）
* 确认不产生重复 daily report（幂等 upsert）

**4. Scheduler 验证**

* 临时改 croner 为 5 分钟间隔，验证自动触发
* 恢复正常调度

#### 交付物

* `data/reports/` 中至少一份真实 daily digest JSON
* 质量观察和改进方向记录

#### 验收标准

* [ ] 完整 pipeline collect → analyze → report 执行成功
* [ ] 本地 JSON 报告内容可读，分析质量基本达标
* [ ] 第二次运行为增量（不重复分析）
* [ ] Scheduler 自动触发验证通过

---

## M2: Harden

> Target: 2026-06-19 (5 working days)
> Goal: 生产化就绪。Lark 推送上线，完善错误处理、预算管控、数据管理，使系统可无人值守稳定运行。

---

### Issue 12: [Dispatcher] Lark webhook 推送实现

**Priority:** High

#### Blocked By
Issue 11（M1 验证通过后再接入 Lark）

#### Blocks
Issue 14（Lark 消息体积降级策略以此为基础）

#### 目标

实现 Lark Dispatcher stage：读取 `reports WHERE sent_at IS NULL` 等价逻辑，通过 webhook 发送 Lark 消息卡片。

#### 实现内容

**1. Webhook 客户端 (`src/pipeline/stages/dispatch.ts`)**

```ts
interface LarkWebhookResponse {
  code: number;        // 0 = success
  msg: string;
  data?: { message_id: string };
}

async function sendCard(webhookUrl: string, card: object): Promise<LarkWebhookResponse> {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "interactive",
      card: card
    })
  });
  return resp.json();
}
```

* HTTP 非 200 或 `code !== 0` 时：重试 3 次（间隔 2s, 4s, 8s，指数退避）
* 仍失败时记录 error，不 throw

**2. Dispatch Stage**

完整实现（通过 `report_deliveries` 表追踪发送状态）：

* 查询未发送的报告
* 为每个报告创建 `report_deliveries` 行（`INSERT OR IGNORE`）
* 逐条发送 `status != 'sent'` 的 delivery
* 成功：更新 `delivery_status = 'sent'`, 记录 `message_id`
* 失败：更新 `delivery_status = 'failed'`, 记录 `error`
* 所有 delivery 成功后更新 `reports.sent_at`

**3. 环境变量校验**

* `LARK_WEBHOOK_URL` 缺失时 skip dispatch + log 警告（不 crash pipeline）

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/pipeline/stages/dispatch.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] Lark 群组收到格式正确的消息卡片
* [ ] 卡片包含 summary + 可折叠详细分析
* [ ] `report_deliveries` 记录正确创建，`delivery_status` 随发送结果更新
* [ ] 所有 delivery 成功后 `reports.sent_at` 才更新
* [ ] 发送失败时不 crash，下次 pipeline 重试
* [ ] 重复运行 dispatch 不重复发送已成功的 delivery
* [ ] `LARK_WEBHOOK_URL` 缺失时 dispatch stage 优雅跳过

---

### Issue 13: [Infra] 错误处理与重试逻辑

**Priority:** Urgent

#### Blocked By
Issue 11（M1 完成，所有 stage 已有基本实现）

#### Blocks
Issue 18

#### 目标

为整个 pipeline 补齐生产级错误处理和重试机制，覆盖所有外部 API 调用（RSS fetch, article-extractor, LLM, Lark）的 failure mode。

#### 实现内容

**1. 通用重试工具 (`src/utils/retry.ts`)**

```ts
interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn?: (error: Error) => boolean;
}

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>;
// 指数退避: delay = min(baseDelay * 2^attempt, maxDelay)
```

**2. RSS Feed 错误处理**

| Error | Detection | Recovery |
|-------|-----------|----------|
| Network timeout | fetch timeout | 重试 2 次，间隔 5s, 10s |
| HTTP 403/404 | HTTP status | 标记竞品 feed 不可用，log 告警，继续下一个 |
| Malformed XML | rss-parser 抛异常 | log 告警，跳过此竞品 |
| article-extractor 失败 | extract() 返回 null/throw | 保留 truncated RSS 内容，不重试 |

**3. LLM API 错误处理**

| Error | Detection | Recovery |
|-------|-----------|----------|
| Timeout (>60s) | AbortController timeout | 标记 `failed`，下次 pipeline 重试 |
| 429 Rate Limit | HTTP 429 | 指数退避（5s, 10s, 20s） |
| Schema Validation | `NoObjectGeneratedError` | 重试 1 次，仍失败标记 `failed` |
| API Error | HTTP 500/overloaded | 指数退避，最多 2 次 |

**4. Lark Webhook 错误处理**

| Error | Detection | Recovery |
|-------|-----------|----------|
| HTTP 非 200 | HTTP status | 重试 3 次（2s, 4s, 8s） |
| 全部失败 | 3 次后仍失败 | `delivery_status = 'failed'`，下次 pipeline 重试 |

**5. Pipeline 韧性确认**

* 单个 competitor 失败不阻断其他 competitor
* 单个 content item 分析失败不阻断同批其他 items
* Pipeline crash 后重启：`analysis_status = 'pending'` 的 items 被重新处理；`delivery_status != 'sent'` 的 cards 被重新发送

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/utils/retry.ts` |
| MODIFY | `src/collectors/blog-rss.ts` |
| MODIFY | `src/pipeline/stages/analyze.ts` |
| MODIFY | `src/pipeline/stages/dispatch.ts` |

#### 验收标准

* [ ] RSS feed 网络超时后自动重试，不 crash
* [ ] LLM timeout 时 item 标记 `failed`，其他 items 继续
* [ ] Lark 发送 3 次失败后标记 `failed`，下次 pipeline 重试
* [ ] Pipeline 中断后重启：不重复分析已完成 items，自动处理 pending items

---

### Issue 14: [Dispatcher] Lark 消息体积三级降级策略

**Priority:** High

#### Blocked By
Issue 12（Lark Dispatcher 基本实现）

#### Blocks
无（独立增强）

#### 目标

完善 Lark 消息卡片体积管理，实现三级降级策略（来自 sister project），确保任何报告都能成功发送。

#### 实现内容

**1. 三级降级策略**

```ts
function formatReport(report: Report): LarkCard | LarkCard[] {
  const fullCard = buildFullCard(report);
  const size = Buffer.byteLength(JSON.stringify(fullCard), "utf-8");

  if (size <= 20_000) return fullCard;                    // Level 1: 正常

  const trimmedCard = buildTrimmedCard(report);           // Level 2: 精简
  // 仅保留 notable + directional_shift items
  // 添加 "N routine items omitted" 行
  const trimmedSize = Buffer.byteLength(JSON.stringify(trimmedCard), "utf-8");

  if (trimmedSize <= 28_000) return trimmedCard;

  return splitByCompetitor(report);                       // Level 3: 按竞品拆分
}
```

* 体积计算使用 `Buffer.byteLength(str, "utf-8")`（中文 3 bytes/char）
* 预留 2KB 安全边际（Lark 硬限制 ~30KB）

**2. 多卡片 Dispatch**

* Level 3 拆分时：写入多条 `report_deliveries` 行
* dispatch 逻辑逐张发送，部分失败时仅重试失败的 card

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/pipeline/stages/report.ts`（添加 format/降级逻辑） |
| MODIFY | `src/pipeline/stages/dispatch.ts`（支持多卡片） |

#### 验收标准

* [ ] <20KB 报告：完整发送
* [ ] 20-30KB 报告：自动精简 routine items
* [ ] >30KB 报告：拆分为多张卡片
* [ ] 拆分后各卡片独立可读（有自己的 header）
* [ ] Card 1 成功 + Card 2 失败时：Card 1 保持 `sent`，下次仅重试 Card 2

---

### Issue 15: [Infra] LLM 预算监控与告警

**Priority:** Urgent

#### Blocked By
Issue 7（LLM 分析器已有 token 用量 + 成本记录）

#### Blocks
无（独立增强）

#### 目标

实现 LLM token 使用量追踪和预算管控：80% 时降级（跳过 routine items），100% 时熔断（暂停分析 + Lark 告警）。

#### 实现内容

**1. Budget Tracker (`src/utils/budget-tracker.ts`)**

```ts
interface BudgetStatus {
  estimatedCostUSD: number;
  budgetCapUSD: number;        // settings.budget.monthlyCap (default 40)
  usagePercent: number;
  action: "normal" | "skip_routine" | "pause";
}

function getBudgetStatus(): BudgetStatus {
  // SELECT SUM(estimated_cost_usd) FROM analyses WHERE analyzed_at >= {month_start}
}
```

**2. 预算策略执行**

修改 `src/pipeline/stages/analyze.ts`：

* `action = "normal"`: 正常分析
* `action = "skip_routine"` (80%-100%): 仅分析 notable/unknown 级别 items，routine 跳过
* `action = "pause"` (100%): 跳过全部分析，发送 Lark 告警

**3. Budget Dashboard**

Daily report card 末尾添加：
```
Budget: $15.00 / $40.00 (38%)
```
* 超过 60% 时显示
* 超过 80% 时标记 warning

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/utils/budget-tracker.ts` |
| MODIFY | `src/pipeline/stages/analyze.ts`（budget 检查） |
| MODIFY | `src/pipeline/stages/report.ts`（budget dashboard） |

#### 验收标准

* [ ] `getBudgetStatus()` 返回准确的费用估算
* [ ] 80% budget 时 routine items 被跳过
* [ ] 100% budget 时全部分析暂停
* [ ] Daily report 末尾显示 budget usage

---

### Issue 16: [Infra] 数据留存自动化

**Priority:** Medium

#### Blocked By
Issue 11（M1 完成，pipeline 已运行）

#### Blocks
无（独立维护任务）

#### 目标

实现数据留存策略，防止磁盘空间无限增长。

#### 实现内容

**1. 维护模块 (`src/pipeline/maintenance.ts`)**

```ts
// 月度执行
async function archiveReports(): Promise<number>;
// 90 天前的 reports 导出为 data/archive/YYYY-MM/reports.jsonl，然后 DELETE

async function vacuumDb(): Promise<void>;
// db.exec("VACUUM")

async function cleanupOldContent(): Promise<number>;
// 60 天前已分析完成的 content_items.content 设为 null（保留元数据和分析结果）
```

**2. 集成到 Scheduler**

* `cleanupOldContent()`: 每次 pipeline 运行后调用
* `archiveReports()` + `vacuumDb()`: 月度 croner 任务（每月 1 号 03:00）

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/pipeline/maintenance.ts` |
| MODIFY | `src/scheduler/cron.ts`（注册月度维护任务） |

#### 验收标准

* [ ] 90 天前的报告被归档到 `data/archive/YYYY-MM/reports.jsonl`
* [ ] 60 天前已完成分析的 content 被清理
* [ ] VACUUM 后 db 文件大小减小

---

### Issue 17: [Pipeline] Prompt 调优（数据驱动）

**Priority:** Medium

#### Blocked By
Issue 11（需要真实数据积累 5+ 天）

#### Blocks
无

#### 目标

基于 M1 运行 5+ 天的真实数据，系统性调优 LLM prompt，提升 significance 分类准确率和 summary 可读性。

#### 实现内容

**1. 分析质量审计**

* 查询最近 7 天全部分析结果
* 人工标注明显误分类的案例
* 统计分布：routine/notable/directional_shift 比例（预期 ~70/25/5）

**2. Prompt 迭代**

* 调整 significance rubric
* 优化 summary 要求（"什么样的 summary 对战略读者最有价值"）
* 调整 `.describe()` 注解措辞
* A/B 对比：对同一批 items 用新旧 prompt 分析

**3. 文档化**

* 最终 prompt 版本记录在分析器代码中
* 关键调优决策记录

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/pipeline/stages/analyze.ts`（prompt 内容 + Zod .describe() 调整） |

#### 验收标准

* [ ] 新 prompt 的 significance 分类更准确
* [ ] Summary 可读性提升
* [ ] Directional shift 检出率 > 70%

---

### Issue 18: [Pipeline] 测试套件

**Priority:** Medium
**Eng Review:** T7 (Write test suite per module, 28 codepaths)

#### Blocked By
Issue 11（所有模块实现完成）

#### Blocks
Issue 19（生产部署前需要测试覆盖）

#### 目标

为所有核心模块编写测试，覆盖 eng review test plan 中定义的 28 个 codepath。使用 Bun 内置 test runner。

#### 实现内容

按 test plan (`docs/reference/test-plan.md`) 覆盖：

**1. Blog RSS Collector Tests**
* 正常 RSS feed 解析
* Truncated content 触发 article-extractor fallback
* article-extractor 失败时 graceful fallback
* Network errors, HTTP 403/404
* Malformed XML
* URL normalization + dedup

**2. LLM Analyzer Tests**
* 正常分析 + Zod schema 验证
* Truncated/metadata-only content 分析
* LLM API 失败 + 重试
* Budget cap 阻断

**3. Report Generator Tests**
* Daily report with mixed significance
* Empty report (zero items)
* Partial report (some competitors failed)
* Weekly themes

**4. Lark Dispatcher Tests**
* Successful delivery
* Retry on failure
* Skip when webhook URL not set
* Size degradation

**5. Storage Tests**
* Fresh DB creation + pragmas
* Schema migration via user_version

**6. Pipeline Integration Tests**
* Full pipeline: collect → analyze → report → dispatch
* Partial failure propagation through PipelineContext

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/__tests__/collectors/blog-rss.test.ts` |
| CREATE | `src/__tests__/pipeline/analyze.test.ts` |
| CREATE | `src/__tests__/pipeline/report.test.ts` |
| CREATE | `src/__tests__/pipeline/dispatch.test.ts` |
| CREATE | `src/__tests__/storage/db.test.ts` |
| CREATE | `src/__tests__/pipeline/integration.test.ts` |
| CREATE | `src/__tests__/utils/url-normalize.test.ts` |

#### 验收标准

* [ ] `bun test` 全部通过
* [ ] 覆盖 test plan 中定义的关键 codepath
* [ ] URL normalization 边界情况覆盖
* [ ] LLM 调用使用 mock（不消耗真实 API quota）
* [ ] Pipeline integration test 验证 PipelineContext 传播

---

### Issue 19: [Pipeline] 生产部署配置

**Priority:** Medium

#### Blocked By
Issue 13（错误处理完善）, Issue 18（测试通过）

#### Blocks
无（M2 收尾）

#### 目标

配置生产环境部署，使系统可长期无人值守运行。

#### 实现内容

**1. 进程管理（pm2）**

创建 `ecosystem.config.js`：
```js
module.exports = {
  apps: [{
    name: "ecosystem-monitor",
    script: "src/index.ts",
    interpreter: "bun",
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: "production"
    }
  }]
};
```

**2. 健康检查**

* Pipeline 运行结果记录到 `data/health.json`：`{ lastRun, success, itemsProcessed, errors }`
* 连续 3 次 pipeline 全部 stage 失败时：发送 Lark 告警

**3. 部署文档**

README Deployment 章节：
* 环境要求：Bun >= 1.x
* 一键部署：`git clone && bun install && cp .env.example .env && pm2 start`
* 更新：`git pull && bun install && pm2 restart ecosystem-monitor`

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `ecosystem.config.js` |
| MODIFY | `src/pipeline/runner.ts`（健康检查写入） |

#### 验收标准

* [ ] `pm2 start ecosystem.config.js` 后进程稳定运行
* [ ] 进程 crash 后 pm2 自动重启
* [ ] `data/health.json` 在每次 pipeline 运行后更新
* [ ] 连续 3 次失败时 Lark 收到告警

---

## M3 (Post-MVP): Expansion + Evolution

> Target: TBD
> Goal: X/Twitter 采集、竞品关注领域模型、RSS 健康监控。Gated by M2 完成。

---

### Issue 20: [Collector] X/Twitter 采集器评估与实现

**Priority:** Medium

#### Blocked By
M2 complete

#### Blocks
无

#### 目标

评估并实现 X/Twitter 内容采集方案。v1 scope 中 X 被有意推迟（`xEnabled: false`），需先评估可行方案的成本和稳定性。

#### 实现内容

**1. 方案评估**

* X API Basic tier ($100/month) — 成本评估
* Self-hosted RSS-Bridge for X — 稳定性评估
* Direct scraping — 法律和技术风险评估
* 如果无方案低于 $20/month，接受 blog-only 为长期 scope

**2. 实现**（如果找到可行方案）

* `src/collectors/x-posts.ts` 实现
* 过滤：仅 original tweets + quote tweets（skip replies, retweets）
* 写入 `content_items` 表，`source = 'x_post'`
* 集成到 collect stage

#### 验收标准

* [ ] 方案评估文档完成
* [ ] 如果可行：X 内容成功采集并进入分析 pipeline

---

### Issue 21: [Analyzer] 竞品关注领域模型

**Priority:** Low

#### Blocked By
M2 complete

#### Blocks
无

#### 目标

在 `competitors.json` 中添加 `focus_areas` 字段，让 LLM 分析更具针对性。

#### 实现内容

* `CompetitorConfig` 添加 `focusAreas?: string[]`（如 `["DeFi", "Layer2", "Wallet"]`）
* 分析 prompt 中注入 focus areas 上下文
* 提高与我们业务相关的 notable/directional_shift 判断准确率

#### 验收标准

* [ ] Focus areas 注入分析 prompt
* [ ] 分析结果更聚焦于竞品核心领域

---

### Issue 22: [Infra] RSS 订阅源健康监控

**Priority:** Low

#### Blocked By
M2 complete

#### Blocks
无

#### 目标

监控 RSS feeds 健康状态，当某个 feed 7+ 天没有新内容时发出告警。

#### 实现内容

* 在 maintenance 任务中检查各竞品 `last_synced_at`
* 超过 7 天无新内容：Lark 告警 "RSS feed for {competitor} may be stale"
* 区分 "feed 正常但竞品确实没发文" vs "feed URL 失效"

#### 验收标准

* [ ] 7+ 天无更新的 feed 触发告警
* [ ] 告警包含竞品名称和最后更新时间

---

## Issue 依赖关系图

```
M0 (Scaffold):
  1 ─┬── 2 ──┐
     ├── 3 ──┼── 5
     └── 4 ──┘

M1 (Core Pipeline):
  5 ─── 6 ── 7 ── 8 ── 9
  4 ── 6              │
  5 ── 10             │
  6 + 7 + 8 + 9 + 10 ── 11

M2 (Harden):
  11 ── 12 ── 14
  11 ── 13 ── 18 ── 19
  7 ── 15
  11 ── 16
  11 ── 17

M3 (Post-MVP, gated by M2 complete):
  M2 ── 20
  M2 ── 21
  M2 ── 22
```

## 明确的 Blocking 关系（用于 Multica 的 blockedBy 字段）

| Issue | Blocked By |
|-------|------------|
| 1 | (none) |
| 2 | 1 |
| 3 | 1 |
| 4 | 1 |
| 5 | 2, 3 |
| 6 | 2, 3, 4, 5 |
| 7 | 5, 6 |
| 8 | 7 |
| 9 | 8 |
| 10 | 5 |
| 11 | 6, 7, 8, 9, 10 |
| 12 | 11 |
| 13 | 11 |
| 14 | 12 |
| 15 | 7 |
| 16 | 11 |
| 17 | 11 |
| 18 | 11 |
| 19 | 13, 18 |
| 20 | M2 complete |
| 21 | M2 complete |
| 22 | M2 complete |

## Priority 分布

| Priority | Count | Issues |
|----------|-------|--------|
| Urgent | 5 | 1, 2, 5, 6, 7, 11, 13, 15 |
| High | 7 | 3, 4, 8, 9, 10, 12, 14 |
| Medium | 5 | 16, 17, 18, 19, 20 |
| Low | 2 | 21, 22 |

## Eng Review Task Mapping

| Eng Review Task | Issue | Description |
|-----------------|-------|-------------|
| T1 | Issue 6 | Use @extractus/article-extractor for content extraction |
| T2 | Issue 7 | Add .describe() to all Zod schema fields (Chinese) |
| T3 | Issue 10 | Add src/e2e-run.ts for manual pipeline validation |
| T4 | Issue 4 | Implement URL normalization for dedup |
| T5 | Issue 2 | Add PRAGMA busy_timeout = 5000 |
| T6 | Issue 5 | Add PipelineContext for error propagation |
| T7 | Issue 18 | Write test suite per module (28 codepaths) |
